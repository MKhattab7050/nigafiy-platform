package engine

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/engine/internal/supervisor"
)

// fakeUnit becomes Running on Start (after readyAfter, if set) and records every call.
type fakeUnit struct {
	name string
	log  *callLog

	mu         sync.Mutex
	state      supervisor.State
	startErr   error
	readyAfter time.Duration
	refuse     bool // Start leaves it Stopped (like a failed precheck)
}

type callLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *callLog) add(s string) {
	l.mu.Lock()
	l.calls = append(l.calls, s)
	l.mu.Unlock()
}

func (l *callLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.calls, " ")
}

func (f *fakeUnit) Status() supervisor.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return supervisor.Status{Name: f.name, State: f.state}
}

func (f *fakeUnit) set(s supervisor.State) {
	f.mu.Lock()
	f.state = s
	f.mu.Unlock()
}

func (f *fakeUnit) Start() error {
	f.log.add("start:" + f.name)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return f.startErr
	}
	if f.refuse {
		f.state = supervisor.Stopped
		return nil
	}
	if f.readyAfter > 0 {
		f.state = supervisor.Starting
		d := f.readyAfter
		go func() {
			time.Sleep(d)
			f.set(supervisor.Running)
		}()
	} else {
		f.state = supervisor.Running
	}
	return nil
}

func (f *fakeUnit) Stop() error {
	f.log.add("stop:" + f.name)
	f.set(supervisor.Stopped)
	return nil
}

func (f *fakeUnit) Restart() error {
	f.log.add("restart:" + f.name)
	f.set(supervisor.Running)
	return nil
}

func (f *fakeUnit) Close() error {
	f.log.add("close:" + f.name)
	f.set(supervisor.Stopped)
	return nil
}

func testGroup(t *testing.T) (*group, map[string]*fakeUnit, *callLog) {
	t.Helper()
	log := &callLog{}
	units := map[string]*fakeUnit{}
	mk := func(name string, deps ...string) member {
		u := &fakeUnit{name: name, log: log, state: supervisor.Stopped}
		units[name] = u
		return member{name: name, u: u, deps: deps}
	}
	g := newGroup([]member{mk("db"), mk("api", "db"), mk("web", "api"), mk("sensor", "api")}, nil)
	g.poll = 5 * time.Millisecond
	return g, units, log
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestGroupStartsInOrderOnlyOnceDependenciesRun(t *testing.T) {
	g, units, log := testGroup(t)
	units["db"].readyAfter = 60 * time.Millisecond
	units["api"].readyAfter = 60 * time.Millisecond
	g.StartAll()
	// While the database is starting, the API waits for it and nothing else has started.
	waitUntil(t, "api waiting for db", func() bool { return g.WaitingFor("api") == "db" })
	if got := log.String(); got != "start:db" {
		t.Fatalf("calls while db starts: %q", got)
	}
	waitUntil(t, "all running", func() bool {
		return units["web"].Status().State == supervisor.Running && units["sensor"].Status().State == supervisor.Running
	})
	if got := log.String(); got != "start:db start:api start:web start:sensor" {
		t.Fatalf("start order %q", got)
	}
	if g.WaitingFor("web") != "" {
		t.Fatal("web still marked waiting")
	}
	g.Close()
	if got := log.String(); !strings.HasSuffix(got, "close:sensor close:web close:api close:db") {
		t.Fatalf("close order %q", got)
	}
}

func TestGroupSkipsMembersWhoseDependencyFailed(t *testing.T) {
	g, units, log := testGroup(t)
	units["db"].refuse = true // like a precheck error: stays stopped
	g.StartAll()
	waitUntil(t, "sequence done", func() bool { return g.WaitingFor("api") == "" && strings.Contains(log.String(), "start:db") })
	time.Sleep(30 * time.Millisecond)
	if got := log.String(); got != "start:db" {
		t.Fatalf("calls %q: nothing that needs the database may start", got)
	}
	g.Close()
}

func TestGroupStartRefusedWhileDependencyDown(t *testing.T) {
	g, units, _ := testGroup(t)
	err := g.Start("api")
	if !errors.Is(err, errDependency) || !strings.Contains(err.Error(), "start db first") {
		t.Fatalf("start api with db stopped: %v", err)
	}
	units["db"].set(supervisor.Running)
	if err := g.Start("api"); err != nil {
		t.Fatal(err)
	}
	if units["api"].Status().State != supervisor.Running {
		t.Fatal("api not started")
	}
	g.Close()
}

func TestGroupStopStopsDependentsFirst(t *testing.T) {
	g, units, log := testGroup(t)
	for _, u := range units {
		u.set(supervisor.Running)
	}
	if err := g.Stop("api"); err != nil {
		t.Fatal(err)
	}
	if got := log.String(); got != "stop:sensor stop:web stop:api" {
		t.Fatalf("stop order %q", got)
	}
	if units["db"].Status().State != supervisor.Running {
		t.Fatal("db stopped although nothing it needs was stopped")
	}
	g.Close()
}

func TestGroupRestartBringsRunningDependentsBack(t *testing.T) {
	g, units, log := testGroup(t)
	for _, u := range units {
		u.set(supervisor.Running)
	}
	units["sensor"].set(supervisor.Stopped) // stopped by hand: stays stopped
	if err := g.Restart("db"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "web back", func() bool { return units["web"].Status().State == supervisor.Running })
	if got := log.String(); got != "stop:web stop:api restart:db start:api start:web" {
		t.Fatalf("restart sequence %q", got)
	}
	if units["sensor"].Status().State != supervisor.Stopped {
		t.Fatal("a stopped dependent was started by a restart")
	}
	g.Close()
}
