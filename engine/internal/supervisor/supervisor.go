// Package supervisor runs one child process and keeps it running: it restarts a crashed child with
// exponential backoff, gives up on a child that keeps crashing, and stops it gracefully (then by
// killing its whole process tree) on request.
package supervisor

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// State is where a child is in its life cycle.
type State string

const (
	Stopped  State = "stopped"  // not running and not going to start by itself
	Starting State = "starting" // process started, not ready yet
	Running  State = "running"  // process started and ready
	Backoff  State = "backoff"  // crashed; waiting before the next start
	Failed   State = "failed"   // crashed too often; left stopped until started by hand
)

// Policy is the restart policy.
type Policy struct {
	InitialBackoff time.Duration // first restart delay
	MaxBackoff     time.Duration // delays double up to this cap
	ResetAfter     time.Duration // running healthy this long resets the delay to InitialBackoff
	MaxDeaths      int           // this many deaths within DeathWindow → Failed
	DeathWindow    time.Duration
}

// DefaultPolicy is the engine's restart policy: 1 s doubling to 60 s, reset after 5 min healthy,
// failed after 5 deaths within 10 min.
func DefaultPolicy() Policy {
	return Policy{
		InitialBackoff: time.Second,
		MaxBackoff:     60 * time.Second,
		ResetAfter:     5 * time.Minute,
		MaxDeaths:      5,
		DeathWindow:    10 * time.Minute,
	}
}

// Spec describes the child process.
type Spec struct {
	Name string
	Path string
	Args []string
	Env  []string // full environment; nil inherits the engine's
	Dir  string
	// Output receives the child's stdout and stderr. If it has a Flush() method it is called after
	// the child exits. nil discards the output.
	Output io.Writer
	// Graceful: ask the child to stop (stdin is closed; on POSIX also SIGTERM) and wait up to
	// StopTimeout before killing its process tree. false: kill the tree straight away.
	Graceful    bool
	StopTimeout time.Duration
	// Precheck runs before every start. An error leaves the child Stopped with that error as its
	// last error (for example "not enrolled"); it is not counted as a crash.
	Precheck func() error
	// ReadyCheck is polled every ReadyPoll while the child is Starting. nil: the child counts as
	// Running as soon as it has started. An error is recorded as the last error.
	ReadyCheck   func(pid int) (bool, error)
	ReadyPoll    time.Duration
	ReadyTimeout time.Duration // 0: wait as long as the process lives
}

// Status is a snapshot of a child.
type Status struct {
	Name      string
	State     State
	Pid       int // 0 when no process is running
	Restarts  int // automatic restarts since the engine started
	LastError string
	StartedAt time.Time     // zero when no process is running
	RetryIn   time.Duration // in Backoff: the delay before the next start
}

// Process is a started child.
type Process interface {
	Pid() int
	// Done is closed once the process has exited and its process tree has been cleaned up.
	Done() <-chan struct{}
	// Err is the exit result once Done is closed: nil for exit code 0.
	Err() error
	// RequestStop asks the process to stop on its own.
	RequestStop() error
	// Kill kills the process and everything it started.
	Kill() error
}

// Starter starts processes. ExecStarter starts real ones; tests use fakes.
type Starter interface {
	Start(spec *Spec) (Process, error)
}

// Options are the supervisor's collaborators. Zero values mean the real ones.
type Options struct {
	Clock   Clock
	Starter Starter
	Policy  *Policy
	Logf    func(format string, args ...any)
}

type cmdKind int

const (
	cmdStart cmdKind = iota
	cmdStop
	cmdRestart
	cmdClose
)

type command struct {
	kind cmdKind
	done chan struct{}
}

// Child supervises one process. Its methods are safe for concurrent use.
type Child struct {
	spec    Spec
	clock   Clock
	starter Starter
	policy  Policy
	logf    func(format string, args ...any)

	cmds   chan command
	closed chan struct{}

	mu   sync.Mutex
	snap Status
}

// ErrClosed is returned by a Child after Close.
var ErrClosed = errors.New("supervisor closed")

// New returns a stopped child. Call Start to run it.
func New(spec Spec, opts Options) *Child {
	c := &Child{
		spec:    spec,
		clock:   opts.Clock,
		starter: opts.Starter,
		logf:    opts.Logf,
		cmds:    make(chan command),
		closed:  make(chan struct{}),
	}
	if c.clock == nil {
		c.clock = RealClock{}
	}
	if c.starter == nil {
		c.starter = ExecStarter{}
	}
	if opts.Policy != nil {
		c.policy = *opts.Policy
	} else {
		c.policy = DefaultPolicy()
	}
	if c.logf == nil {
		c.logf = func(string, ...any) {}
	}
	if c.spec.ReadyPoll <= 0 {
		c.spec.ReadyPoll = 500 * time.Millisecond
	}
	if c.spec.StopTimeout <= 0 {
		c.spec.StopTimeout = 10 * time.Second
	}
	c.snap = Status{Name: spec.Name, State: Stopped}
	go c.loop()
	return c
}

// Name is the child's name.
func (c *Child) Name() string { return c.spec.Name }

// Status returns the latest snapshot.
func (c *Child) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snap
}

func (c *Child) send(kind cmdKind) error {
	cmd := command{kind: kind, done: make(chan struct{})}
	select {
	case c.cmds <- cmd:
	case <-c.closed:
		return ErrClosed
	}
	select {
	case <-cmd.done:
	case <-c.closed:
	}
	return nil
}

// Start starts the child (a manual start: a Failed child gets a fresh restart budget). It returns
// once the process has been launched (or the precheck refused it); it does not wait for readiness.
func (c *Child) Start() error { return c.send(cmdStart) }

// Stop stops the child and waits until its process tree is gone.
func (c *Child) Stop() error { return c.send(cmdStop) }

// Restart stops the child (if running) and starts it again, with a fresh restart budget.
func (c *Child) Restart() error { return c.send(cmdRestart) }

// Close stops the child and ends its supervisor.
func (c *Child) Close() error {
	err := c.send(cmdClose)
	if errors.Is(err, ErrClosed) {
		return nil
	}
	return err
}

// loop owns all of the child's state; commands, exits and timers are handled one at a time.
func (c *Child) loop() {
	var (
		st      = Status{Name: c.spec.Name, State: Stopped}
		proc    Process
		procEnd <-chan struct{}

		retryC, readyC, killC <-chan time.Time

		stopping       bool
		startAfterStop bool
		closing        bool
		waiters        []chan struct{}

		deaths       []time.Time
		nextDelay    = c.policy.InitialBackoff
		runningSince time.Time
		exitReason   string // set when the supervisor itself killed the process (ready timeout)
		readyErr     string // the last error ReadyCheck reported for the current process
	)
	publish := func() {
		c.mu.Lock()
		c.snap = st
		c.mu.Unlock()
	}
	freshBudget := func() {
		deaths = nil
		nextDelay = c.policy.InitialBackoff
	}

	// died records a crash (or a failed start) and schedules the next start, or gives up.
	died := func(now time.Time, wasRunning bool) {
		if wasRunning && now.Sub(runningSince) >= c.policy.ResetAfter {
			nextDelay = c.policy.InitialBackoff
		}
		deaths = append(deaths, now)
		cut := now.Add(-c.policy.DeathWindow)
		kept := deaths[:0]
		for _, d := range deaths {
			if d.After(cut) {
				kept = append(kept, d)
			}
		}
		deaths = kept
		st.Pid = 0
		st.StartedAt = time.Time{}
		st.RetryIn = 0
		if len(deaths) >= c.policy.MaxDeaths {
			st.State = Failed
			st.LastError = fmt.Sprintf("%s; stopped after %d crashes within %s, start it again by hand", st.LastError, len(deaths), c.policy.DeathWindow)
			c.logf("%s: %s", c.spec.Name, st.LastError)
			return
		}
		delay := nextDelay
		nextDelay *= 2
		if nextDelay > c.policy.MaxBackoff {
			nextDelay = c.policy.MaxBackoff
		}
		st.State = Backoff
		st.RetryIn = delay
		retryC = c.clock.After(delay)
		c.logf("%s: %s; restarting in %s", c.spec.Name, st.LastError, delay)
	}

	launch := func() {
		readyC, killC, retryC = nil, nil, nil
		exitReason, readyErr = "", ""
		if c.spec.Precheck != nil {
			if err := c.spec.Precheck(); err != nil {
				st.State = Stopped
				st.Pid = 0
				st.StartedAt = time.Time{}
				st.RetryIn = 0
				st.LastError = err.Error()
				c.logf("%s: not started: %s", c.spec.Name, st.LastError)
				return
			}
		}
		now := c.clock.Now()
		p, err := c.starter.Start(&c.spec)
		if err != nil {
			st.LastError = "could not start: " + err.Error()
			died(now, false)
			return
		}
		proc = p
		procEnd = p.Done()
		st.Pid = p.Pid()
		st.StartedAt = now
		st.RetryIn = 0
		if c.spec.ReadyCheck == nil {
			st.State = Running
			st.LastError = ""
			runningSince = now
		} else {
			st.State = Starting
			readyC = c.clock.After(c.spec.ReadyPoll)
		}
		c.logf("%s: started (pid %d)", c.spec.Name, st.Pid)
	}

	beginStop := func() {
		if stopping || proc == nil {
			return
		}
		stopping = true
		readyC = nil
		if c.spec.Graceful {
			if err := proc.RequestStop(); err != nil {
				c.logf("%s: graceful stop request failed: %v", c.spec.Name, err)
			}
			killC = c.clock.After(c.spec.StopTimeout)
		} else {
			proc.Kill()
		}
	}

	finish := func(ch chan struct{}) {
		publish()
		close(ch)
	}

	for {
		select {
		case cmd := <-c.cmds:
			switch cmd.kind {
			case cmdStart:
				switch {
				case stopping:
					startAfterStop = true
				case proc == nil:
					freshBudget()
					launch()
				}
				finish(cmd.done)
			case cmdRestart:
				freshBudget()
				if proc == nil {
					launch()
					finish(cmd.done)
				} else {
					startAfterStop = true
					waiters = append(waiters, cmd.done)
					beginStop()
				}
			case cmdStop, cmdClose:
				retryC = nil
				startAfterStop = false
				if cmd.kind == cmdClose {
					closing = true
				}
				if proc == nil {
					if st.State == Backoff {
						st.State = Stopped
						st.RetryIn = 0
					} else if st.State != Failed {
						st.State = Stopped
					}
					finish(cmd.done)
					if closing {
						close(c.closed)
						return
					}
				} else {
					waiters = append(waiters, cmd.done)
					beginStop()
				}
			}

		case <-procEnd:
			now := c.clock.Now()
			exitErr := proc.Err()
			wasRunning := st.State == Running
			proc, procEnd = nil, nil
			readyC, killC = nil, nil
			if stopping {
				stopping = false
				st.State = Stopped
				st.Pid = 0
				st.StartedAt = time.Time{}
				c.logf("%s: stopped", c.spec.Name)
				if startAfterStop && !closing {
					startAfterStop = false
					launch()
				}
				publish()
				for _, w := range waiters {
					close(w)
				}
				waiters = nil
				if closing {
					close(c.closed)
					return
				}
				continue
			}
			if st.State == Starting && c.spec.ReadyCheck != nil && readyErr == "" {
				// The child may have reported why it is giving up just before exiting.
				if _, err := c.spec.ReadyCheck(st.Pid); err != nil {
					readyErr = err.Error()
				}
			}
			exitText := "exited unexpectedly with code 0"
			if exitErr != nil {
				exitText = exitErr.Error()
			}
			switch {
			case exitReason != "":
				st.LastError = exitReason
			case readyErr != "":
				// What the child reported before dying says more than its exit code.
				st.LastError = readyErr + " (" + exitText + ")"
			default:
				st.LastError = exitText
			}
			died(now, wasRunning)

		case <-retryC:
			retryC = nil
			st.Restarts++
			launch()

		case <-readyC:
			readyC = nil
			if proc == nil || stopping {
				break
			}
			ready, err := c.spec.ReadyCheck(st.Pid)
			if err != nil {
				readyErr = err.Error()
				st.LastError = readyErr
			}
			now := c.clock.Now()
			switch {
			case ready:
				st.State = Running
				st.LastError = ""
				runningSince = now
				c.logf("%s: ready", c.spec.Name)
			case c.spec.ReadyTimeout > 0 && now.Sub(st.StartedAt) >= c.spec.ReadyTimeout:
				exitReason = fmt.Sprintf("did not become ready within %s", c.spec.ReadyTimeout)
				if st.LastError != "" {
					exitReason = st.LastError + " (" + exitReason + ")"
				}
				c.logf("%s: %s; killing it", c.spec.Name, exitReason)
				proc.Kill()
			default:
				readyC = c.clock.After(c.spec.ReadyPoll)
			}

		case <-killC:
			killC = nil
			if proc != nil {
				c.logf("%s: did not stop within %s; killing its process tree", c.spec.Name, c.spec.StopTimeout)
				proc.Kill()
			}
		}
		publish()
	}
}
