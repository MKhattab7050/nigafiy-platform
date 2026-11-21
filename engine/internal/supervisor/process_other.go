//go:build !windows

package supervisor

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// prepareCommand puts the child in its own process group so its whole tree can be signalled.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// processTree is the child's process group.
type processTree struct{ pgid int }

func attachTree(p *os.Process) (*processTree, error) { return &processTree{pgid: p.Pid}, nil }

func (t *processTree) kill() error {
	err := syscall.Kill(-t.pgid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// active reports whether any process of the group is still running.
func (t *processTree) active() bool { return syscall.Kill(-t.pgid, 0) == nil }

// close kills whatever the child left behind in its group.
func (t *processTree) close() { t.kill() }

func requestStop(p *os.Process) error {
	err := p.Signal(syscall.SIGTERM)
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
