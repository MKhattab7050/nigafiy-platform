//go:build !windows && !linux

package shell

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
)

// pipeTerm (macOS and other Unix systems) runs the user's shell with pipes instead of a pseudo
// terminal: commands and their output work, but there is no line editing, no job control, no
// resize and full-screen programs (vi, top) do not draw. Opening /dev/ptmx on macOS needs
// grantpt/unlockpt from libc, which pure Go (no cgo) cannot call.
type pipeTerm struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  *io.PipeReader
	name string
	done chan struct{}
	code int
	err  error
	once sync.Once
}

func startTerminal(cols, rows int) (Terminal, error) {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/sh"
	}
	cmd := exec.Command(sh, "-i")
	cmd.Env = append(os.Environ(), "TERM=dumb")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", sh, err)
	}
	t := &pipeTerm{cmd: cmd, in: in, out: pr, name: sh, done: make(chan struct{})}
	go func() {
		defer close(t.done)
		err := cmd.Wait()
		t.code = cmd.ProcessState.ExitCode()
		if _, ok := err.(*exec.ExitError); !ok {
			t.err = err
		}
		_ = pw.Close()
	}()
	return t, nil
}

func (t *pipeTerm) Read(p []byte) (int, error) { return t.out.Read(p) }

// Write turns the terminal's Enter (CR) into a newline: without a pty nothing translates it.
func (t *pipeTerm) Write(p []byte) (int, error) {
	q := make([]byte, len(p))
	for i, c := range p {
		if c == '\r' {
			c = '\n'
		}
		q[i] = c
	}
	if _, err := t.in.Write(q); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (t *pipeTerm) Kind() string          { return "pipes" }
func (t *pipeTerm) Name() string          { return t.name }
func (t *pipeTerm) Resize(int, int) error { return nil }
func (t *pipeTerm) Wait() (int, error)    { <-t.done; return t.code, t.err }

func (t *pipeTerm) Kill() {
	if t.cmd.Process != nil {
		_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (t *pipeTerm) Close() error {
	t.Kill()
	<-t.done
	return t.in.Close()
}
