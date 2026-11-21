package supervisor

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// ── fake clock ───────────────────────────────────────────────────────────────

type fakeTimer struct {
	at time.Time
	ch chan time.Time
}

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeClock) After(d time.Duration) <-chan time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &fakeTimer{at: f.now.Add(d), ch: make(chan time.Time, 1)}
	f.timers = append(f.timers, t)
	return t.ch
}

// Advance moves time forward and fires every timer that is due.
func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	var keep []*fakeTimer
	for _, t := range f.timers {
		if !t.at.After(f.now) {
			t.ch <- f.now
		} else {
			keep = append(keep, t)
		}
	}
	f.timers = keep
	f.mu.Unlock()
}

// ── fake processes ───────────────────────────────────────────────────────────

type fakeProc struct {
	pid  int
	done chan struct{}
	once sync.Once
	err  error

	mu            sync.Mutex
	stopRequested bool
	killed        bool
	exitOnStop    bool
}

func (p *fakeProc) Pid() int              { return p.pid }
func (p *fakeProc) Done() <-chan struct{} { return p.done }
func (p *fakeProc) Err() error            { return p.err }
func (p *fakeProc) exit(err error) {
	p.once.Do(func() {
		p.err = err
		close(p.done)
	})
}
func (p *fakeProc) RequestStop() error {
	p.mu.Lock()
	p.stopRequested = true
	exit := p.exitOnStop
	p.mu.Unlock()
	if exit {
		p.exit(nil)
	}
	return nil
}
func (p *fakeProc) Kill() error {
	p.mu.Lock()
	p.killed = true
	p.mu.Unlock()
	p.exit(errors.New("killed"))
	return nil
}

type fakeStarter struct {
	mu         sync.Mutex
	next       int
	started    chan *fakeProc
	fail       error
	exitOnStop bool
}

func newFakeStarter() *fakeStarter { return &fakeStarter{next: 100, started: make(chan *fakeProc, 64)} }

func (s *fakeStarter) Start(*Spec) (Process, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return nil, s.fail
	}
	s.next++
	p := &fakeProc{pid: s.next, done: make(chan struct{}), exitOnStop: s.exitOnStop}
	s.started <- p
	return p, nil
}

func (s *fakeStarter) waitStart(t *testing.T) *fakeProc {
	t.Helper()
	select {
	case p := <-s.started:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("child was not started")
		return nil
	}
}

func (s *fakeStarter) noStart(t *testing.T) {
	t.Helper()
	select {
	case p := <-s.started:
		t.Fatalf("unexpected start (pid %d)", p.pid)
	case <-time.After(50 * time.Millisecond):
	}
}

func waitFor(t *testing.T, c *Child, what string, ok func(Status) bool) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st := c.Status()
		if ok(st) {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; status %+v", what, st)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func inState(s State) func(Status) bool { return func(st Status) bool { return st.State == s } }

func newFakeChild(t *testing.T, spec Spec) (*Child, *fakeClock, *fakeStarter) {
	t.Helper()
	clock := newFakeClock()
	starter := newFakeStarter()
	if spec.Name == "" {
		spec.Name = "test"
	}
	c := New(spec, Options{Clock: clock, Starter: starter})
	t.Cleanup(func() { c.Close() })
	return c, clock, starter
}

// ── tests ────────────────────────────────────────────────────────────────────

func TestBackoffDoublesToCapAndCountsRestarts(t *testing.T) {
	c, clock, starter := newFakeChild(t, Spec{})
	c.Start()
	// Each run lasts 4 minutes: short of the 5-minute healthy reset, and few enough deaths per
	// 10 minutes that the child is never marked failed.
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60}
	for i, w := range want {
		p := starter.waitStart(t)
		waitFor(t, c, "running", inState(Running))
		clock.Advance(4 * time.Minute)
		p.exit(errors.New("exited with code 1"))
		st := waitFor(t, c, "backoff", inState(Backoff))
		if st.RetryIn != w*time.Second {
			t.Fatalf("death %d: retry in %s, want %s", i+1, st.RetryIn, w*time.Second)
		}
		if st.LastError != "exited with code 1" {
			t.Fatalf("last error %q", st.LastError)
		}
		clock.Advance(st.RetryIn - time.Millisecond)
		starter.noStart(t)
		clock.Advance(time.Millisecond)
	}
	starter.waitStart(t)
	st := waitFor(t, c, "running", inState(Running))
	if st.Restarts != len(want) {
		t.Fatalf("restarts %d, want %d", st.Restarts, len(want))
	}
}

func TestFailedAfterFiveDeathsWithinTenMinutes(t *testing.T) {
	c, clock, starter := newFakeChild(t, Spec{})
	c.Start()
	for i := 1; i <= 5; i++ {
		p := starter.waitStart(t)
		waitFor(t, c, "running", inState(Running))
		p.exit(errors.New("exited with code 2"))
		if i < 5 {
			st := waitFor(t, c, "backoff", inState(Backoff))
			clock.Advance(st.RetryIn)
		}
	}
	st := waitFor(t, c, "failed", inState(Failed))
	if st.Pid != 0 {
		t.Fatalf("failed child has pid %d", st.Pid)
	}
	clock.Advance(time.Hour)
	starter.noStart(t)
	if got := c.Status().State; got != Failed {
		t.Fatalf("state %s after an hour, want failed", got)
	}
	// A manual start gives it a fresh budget.
	c.Start()
	p := starter.waitStart(t)
	waitFor(t, c, "running", inState(Running))
	p.exit(errors.New("exited with code 2"))
	st = waitFor(t, c, "backoff", inState(Backoff))
	if st.RetryIn != time.Second {
		t.Fatalf("retry after manual start %s, want 1s", st.RetryIn)
	}
}

func TestBackoffResetsAfterFiveMinutesHealthy(t *testing.T) {
	c, clock, starter := newFakeChild(t, Spec{})
	c.Start()
	for _, w := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		p := starter.waitStart(t)
		waitFor(t, c, "running", inState(Running))
		p.exit(errors.New("boom"))
		st := waitFor(t, c, "backoff", inState(Backoff))
		if st.RetryIn != w {
			t.Fatalf("retry %s, want %s", st.RetryIn, w)
		}
		clock.Advance(st.RetryIn)
	}
	p := starter.waitStart(t)
	waitFor(t, c, "running", inState(Running))
	clock.Advance(5 * time.Minute)
	p.exit(errors.New("boom"))
	st := waitFor(t, c, "backoff", inState(Backoff))
	if st.RetryIn != time.Second {
		t.Fatalf("retry after a healthy run %s, want 1s", st.RetryIn)
	}
}

func TestStopDuringBackoffCancelsRestart(t *testing.T) {
	c, clock, starter := newFakeChild(t, Spec{})
	c.Start()
	p := starter.waitStart(t)
	p.exit(errors.New("boom"))
	waitFor(t, c, "backoff", inState(Backoff))
	c.Stop()
	if st := c.Status(); st.State != Stopped {
		t.Fatalf("state %s, want stopped", st.State)
	}
	clock.Advance(time.Minute)
	starter.noStart(t)
}

func TestGracefulStopKillsAfterTimeout(t *testing.T) {
	c, clock, starter := newFakeChild(t, Spec{Graceful: true, StopTimeout: 30 * time.Second})
	c.Start()
	p := starter.waitStart(t)
	stopped := make(chan struct{})
	go func() {
		c.Stop()
		close(stopped)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		p.mu.Lock()
		asked := p.stopRequested
		p.mu.Unlock()
		if asked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stop was not requested")
		}
		time.Sleep(time.Millisecond)
	}
	clock.Advance(29 * time.Second)
	select {
	case <-stopped:
		t.Fatal("stopped before the timeout although the child ignored the request")
	case <-time.After(50 * time.Millisecond):
	}
	clock.Advance(time.Second)
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("not killed after the timeout")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.killed {
		t.Fatal("child was not killed")
	}
	if st := c.Status(); st.State != Stopped || st.Restarts != 0 {
		t.Fatalf("status %+v, want stopped with no restarts", st)
	}
}

func TestPrecheckLeavesChildStopped(t *testing.T) {
	c, _, starter := newFakeChild(t, Spec{Precheck: func() error { return errors.New("not enrolled") }})
	c.Start()
	starter.noStart(t)
	st := c.Status()
	if st.State != Stopped || st.LastError != "not enrolled" {
		t.Fatalf("status %+v, want stopped / not enrolled", st)
	}
}

func TestReadyCheckGatesRunningAndTimesOut(t *testing.T) {
	var mu sync.Mutex
	ready := false
	check := func(int) (bool, error) {
		mu.Lock()
		defer mu.Unlock()
		return ready, nil
	}
	c, clock, starter := newFakeChild(t, Spec{ReadyCheck: check, ReadyPoll: time.Second, ReadyTimeout: 10 * time.Second})
	c.Start()
	starter.waitStart(t)
	if st := c.Status(); st.State != Starting {
		t.Fatalf("state %s, want starting", st.State)
	}
	clock.Advance(time.Second)
	waitFor(t, c, "still starting after a poll", inState(Starting))
	mu.Lock()
	ready = true
	mu.Unlock()
	clock.Advance(time.Second)
	waitFor(t, c, "running", inState(Running))

	// A second child that never gets ready is killed after ReadyTimeout and counted as a crash.
	c2, clock2, starter2 := newFakeChild(t, Spec{Name: "slow", ReadyCheck: func(int) (bool, error) { return false, errors.New("still loading") }, ReadyPoll: time.Second, ReadyTimeout: 3 * time.Second})
	c2.Start()
	p := starter2.waitStart(t)
	for i := 0; i < 3; i++ {
		// Wait for the poll timer to be registered before advancing.
		waitTimers(t, clock2, 1)
		clock2.Advance(time.Second)
	}
	st := waitFor(t, c2, "backoff after ready timeout", inState(Backoff))
	p.mu.Lock()
	killed := p.killed
	p.mu.Unlock()
	if !killed {
		t.Fatal("slow child was not killed")
	}
	if st.LastError != "still loading (did not become ready within 3s)" {
		t.Fatalf("last error %q", st.LastError)
	}
}

func waitTimers(t *testing.T, f *fakeClock, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		got := len(f.timers)
		f.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d pending timers, have %d", n, got)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRestartRunsAgain(t *testing.T) {
	c, _, starter := newFakeChild(t, Spec{Graceful: true})
	starter.exitOnStop = true
	c.Start()
	first := starter.waitStart(t)
	c.Restart()
	second := starter.waitStart(t)
	if first.pid == second.pid {
		t.Fatal("restart reused the process")
	}
	st := c.Status()
	if st.State != Running || st.Pid != second.pid {
		t.Fatalf("status %+v after restart", st)
	}
}

func TestStartFailureCountsAsCrash(t *testing.T) {
	c, _, starter := newFakeChild(t, Spec{})
	starter.fail = errors.New("file not found")
	c.Start()
	st := c.Status()
	if st.State != Backoff || st.LastError != "could not start: file not found" {
		t.Fatalf("status %+v", st)
	}
}
