package engine

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/nigafiy/engine/internal/supervisor"
)

// unit is one supervised child as the group sees it (*supervisor.Child in the engine, fakes in tests).
type unit interface {
	Status() supervisor.Status
	Start() error
	Stop() error
	Restart() error
	Close() error
}

// member is a unit with the names of the units that must be running before it starts.
type member struct {
	name string
	u    unit
	deps []string
}

// errDependency means a child was asked to start while something it depends on is not running.
var errDependency = errors.New("dependency not running")

// group starts its members in order (each one only once everything it depends on is running) and
// stops them in reverse order. Every member keeps its own restart backoff, ready check and health
// check (the supervisor); the group only orders starts and stops.
//
//	db → api → web, and api → sensor
type group struct {
	members []member // in start order; a member's deps come before it
	poll    time.Duration
	logf    func(format string, args ...any)

	ops sync.Mutex // one start / stop / restart sequence at a time

	mu      sync.Mutex
	waiting map[string]string // member → the dependency it is waiting for
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	closed  bool
}

func newGroup(members []member, logf func(string, ...any)) *group {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &group{members: members, poll: 200 * time.Millisecond, logf: logf, waiting: map[string]string{}}
}

func (g *group) find(name string) (member, bool) {
	for _, m := range g.members {
		if m.name == name {
			return m, true
		}
	}
	return member{}, false
}

// dependents is every member that needs name, directly or through another member, in start order.
func (g *group) dependents(name string) []member {
	need := map[string]bool{name: true}
	var out []member
	for _, m := range g.members {
		for _, d := range m.deps {
			if need[d] {
				need[m.name] = true
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// WaitingFor is the dependency a member is waiting for before it starts ("" when it is not waiting).
func (g *group) WaitingFor(name string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.waiting[name]
}

func (g *group) setWaiting(name, dep string) {
	g.mu.Lock()
	if dep == "" {
		delete(g.waiting, name)
	} else {
		g.waiting[name] = dep
	}
	g.mu.Unlock()
}

// background runs fn with a context that Close cancels.
func (g *group) background(fn func(ctx context.Context)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return
	}
	if g.cancel != nil {
		g.cancel() // a newer start sequence replaces an older one
	}
	ctx, cancel := context.WithCancel(context.Background())
	g.cancel = cancel
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		fn(ctx)
	}()
}

// StartAll starts every member in order in the background.
func (g *group) StartAll() {
	g.background(func(ctx context.Context) { g.startChain(ctx, g.members) })
}

// startChain starts the given members in order, each once its dependencies are running. A member
// whose dependency has stopped or failed for good is not started (and neither is anything after it
// that needs it); it is logged and left for a manual start.
func (g *group) startChain(ctx context.Context, chain []member) {
	for _, m := range chain {
		if err := g.waitDeps(ctx, m); err != nil {
			if ctx.Err() == nil {
				g.logf("%s: not started: %v", m.name, err)
			}
			continue
		}
		if ctx.Err() != nil {
			return
		}
		g.ops.Lock()
		if ctx.Err() == nil {
			m.u.Start()
		}
		g.ops.Unlock()
	}
}

// waitDeps blocks until every dependency of m is running. It gives up when one is stopped or
// failed (it will not come back by itself) or when ctx ends.
func (g *group) waitDeps(ctx context.Context, m member) error {
	defer g.setWaiting(m.name, "")
	for _, d := range m.deps {
		dep, ok := g.find(d)
		if !ok {
			return fmt.Errorf("unknown dependency %q", d)
		}
		g.setWaiting(m.name, d)
		for {
			st := dep.u.Status()
			if st.State == supervisor.Running {
				break
			}
			if st.State == supervisor.Failed || (st.State == supervisor.Stopped && g.WaitingFor(d) == "") {
				return fmt.Errorf("%w: %s is %s", errDependency, d, st.State)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(g.poll):
			}
		}
	}
	return nil
}

// Start starts one member now. It is refused while something it depends on is not running.
func (g *group) Start(name string) error {
	m, ok := g.find(name)
	if !ok {
		return fmt.Errorf("no child %q", name)
	}
	for _, d := range m.deps {
		dep, _ := g.find(d)
		if st := dep.u.Status(); st.State != supervisor.Running {
			return fmt.Errorf("%w: start %s first (it is %s)", errDependency, d, st.State)
		}
	}
	g.ops.Lock()
	defer g.ops.Unlock()
	return m.u.Start()
}

// Stop stops everything that depends on name (in reverse start order), then name itself.
func (g *group) Stop(name string) error {
	m, ok := g.find(name)
	if !ok {
		return fmt.Errorf("no child %q", name)
	}
	g.ops.Lock()
	defer g.ops.Unlock()
	deps := g.dependents(name)
	for i := len(deps) - 1; i >= 0; i-- {
		if err := deps[i].u.Stop(); err != nil {
			return err
		}
	}
	return m.u.Stop()
}

// Restart stops the members that depend on name, restarts name, and starts those members again in
// order (in the background) once name is running. Members that were stopped stay stopped.
func (g *group) Restart(name string) error {
	m, ok := g.find(name)
	if !ok {
		return fmt.Errorf("no child %q", name)
	}
	g.ops.Lock()
	deps := g.dependents(name)
	var again []member
	for _, d := range deps {
		// Running (or on its way) now, or queued behind name by an earlier start sequence.
		if st := d.u.Status(); (st.State != supervisor.Stopped && st.State != supervisor.Failed) || g.WaitingFor(d.name) != "" {
			again = append(again, d)
		}
	}
	for i := len(deps) - 1; i >= 0; i-- {
		if slices.ContainsFunc(again, func(x member) bool { return x.name == deps[i].name }) {
			deps[i].u.Stop()
		}
	}
	err := m.u.Restart()
	g.ops.Unlock()
	if err != nil {
		return err
	}
	if len(again) > 0 {
		for _, d := range again {
			g.setWaiting(d.name, name)
		}
		g.background(func(ctx context.Context) { g.startChain(ctx, again) })
	}
	return nil
}

// Close cancels any start sequence and closes every member in reverse start order.
func (g *group) Close() {
	g.mu.Lock()
	g.closed = true
	if g.cancel != nil {
		g.cancel()
	}
	g.mu.Unlock()
	g.wg.Wait()
	g.ops.Lock()
	defer g.ops.Unlock()
	for i := len(g.members) - 1; i >= 0; i-- {
		g.members[i].u.Close()
	}
}
