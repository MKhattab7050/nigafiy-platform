package supervisor

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// drainTimeout: after a child that was asked to stop has exited, the processes it started get this
// long to finish exiting on their own before what is left of the tree is killed.
const drainTimeout = 5 * time.Second

// ExecStarter starts real processes. Each one is placed in its own process tree container (a Job
// Object on Windows, a process group elsewhere) so that stopping it also stops everything it
// started, and nothing it started outlives it.
type ExecStarter struct{}

type execProc struct {
	pid   int
	proc  *os.Process
	stdin *os.File
	tree  *processTree

	done chan struct{}
	err  error

	stdinOnce     sync.Once
	stopRequested atomic.Bool
}

// Start launches spec. The child's stdin is a pipe held by the engine; closing it is the graceful
// stop request (see RequestStop).
func (ExecStarter) Start(spec *Spec) (Process, error) {
	outR, outW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return nil, err
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.Stdin = inR
	cmd.Stdout = outW
	cmd.Stderr = outW
	prepareCommand(cmd)
	if err := cmd.Start(); err != nil {
		outR.Close()
		outW.Close()
		inR.Close()
		inW.Close()
		return nil, err
	}
	// The child holds its own copies now.
	outW.Close()
	inR.Close()

	tree, err := attachTree(cmd.Process)
	if err != nil {
		cmd.Process.Kill()
		cmd.Process.Wait()
		outR.Close()
		inW.Close()
		return nil, fmt.Errorf("could not contain the process tree: %w", err)
	}

	p := &execProc{pid: cmd.Process.Pid, proc: cmd.Process, stdin: inW, tree: tree, done: make(chan struct{})}

	output := spec.Output
	if output == nil {
		output = io.Discard
	}
	copied := make(chan struct{})
	go func() {
		io.Copy(output, outR)
		outR.Close()
		close(copied)
	}()

	go func() {
		state, werr := cmd.Process.Wait()
		if p.stopRequested.Load() {
			// A clean stop: let the child's own children finish shutting down.
			for deadline := time.Now().Add(drainTimeout); tree.active() && time.Now().Before(deadline); {
				time.Sleep(100 * time.Millisecond)
			}
		}
		// Whatever the child left behind dies with it.
		tree.close()
		p.closeStdin()
		// Every writer of the output pipe is gone now, so the copy ends; the timeout only guards
		// against a process that escaped the tree still holding the pipe.
		select {
		case <-copied:
		case <-time.After(2 * time.Second):
		}
		if f, ok := output.(interface{ Flush() }); ok {
			f.Flush()
		}
		p.err = exitError(state, werr)
		close(p.done)
	}()
	return p, nil
}

func exitError(state *os.ProcessState, err error) error {
	if err != nil {
		return err
	}
	if state == nil {
		return errors.New("exited")
	}
	if state.Success() {
		return nil
	}
	if code := state.ExitCode(); code >= 0 {
		return fmt.Errorf("exited with code %d", code)
	}
	return fmt.Errorf("exited: %s", state.String())
}

func (p *execProc) Pid() int              { return p.pid }
func (p *execProc) Done() <-chan struct{} { return p.done }
func (p *execProc) Err() error            { return p.err }

func (p *execProc) closeStdin() {
	p.stdinOnce.Do(func() { p.stdin.Close() })
}

// RequestStop closes the child's stdin (scripts/local.mjs started with --engine-status-file stops
// cleanly on that) and, on POSIX systems, also sends SIGTERM.
func (p *execProc) RequestStop() error {
	p.stopRequested.Store(true)
	p.closeStdin()
	return requestStop(p.proc)
}

// Kill kills the whole process tree.
func (p *execProc) Kill() error {
	select {
	case <-p.done:
		return nil
	default:
	}
	err := p.tree.kill()
	if kerr := p.proc.Kill(); err == nil && kerr != nil && !errors.Is(kerr, os.ErrProcessDone) {
		err = kerr
	}
	return err
}
