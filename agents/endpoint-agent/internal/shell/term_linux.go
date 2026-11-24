//go:build linux

package shell

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

// ptyTerm is the user's shell ($SHELL, else /bin/sh) on a pseudo terminal from /dev/ptmx, as its
// own session with the terminal as its controlling terminal (job control and Ctrl+C work).
type ptyTerm struct {
	master *os.File
	cmd    *exec.Cmd
	name   string
	done   chan struct{}
	code   int
	err    error
}

func startTerminal(cols, rows int) (Terminal, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	fd := int(master.Fd())
	// Unlock the slave and find its number.
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("unlock pty: %w", err)
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN)
	if err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("pty number: %w", err)
	}
	slave, err := os.OpenFile("/dev/pts/"+strconv.Itoa(int(n)), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("open pty: %w", err)
	}
	defer slave.Close()
	_ = unix.IoctlSetWinsize(int(slave.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})

	sh := userShell()
	cmd := exec.Command(sh, "-i")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("start %s: %w", sh, err)
	}
	t := &ptyTerm{master: master, cmd: cmd, name: sh, done: make(chan struct{})}
	go func() {
		defer close(t.done)
		t.err = cmd.Wait()
		t.code = cmd.ProcessState.ExitCode()
		if t.code < 0 {
			t.code = 128 + 9
		}
		if t.err != nil {
			if _, ok := t.err.(*exec.ExitError); ok {
				t.err = nil
			}
		}
	}()
	return t, nil
}

func userShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}
	for _, sh := range []string{"/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}
	return "/bin/sh"
}

// Read: EIO once the shell (the last holder of the slave) is gone is the end of the output.
func (t *ptyTerm) Read(p []byte) (int, error)  { return t.master.Read(p) }
func (t *ptyTerm) Write(p []byte) (int, error) { return t.master.Write(p) }
func (t *ptyTerm) Kind() string                { return "pty" }
func (t *ptyTerm) Name() string                { return t.name }

func (t *ptyTerm) Resize(cols, rows int) error {
	return unix.IoctlSetWinsize(int(t.master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
}

func (t *ptyTerm) Wait() (int, error) {
	<-t.done
	return t.code, t.err
}

// Kill ends the shell's session (process group) and everything in it.
func (t *ptyTerm) Kill() {
	if t.cmd.Process != nil {
		_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGHUP)
		_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (t *ptyTerm) Close() error {
	t.Kill()
	<-t.done
	return t.master.Close()
}
