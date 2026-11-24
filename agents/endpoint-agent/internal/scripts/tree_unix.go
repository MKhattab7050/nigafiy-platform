//go:build !windows

package scripts

import (
	"os/exec"
	"syscall"
)

// Elsewhere the script runs in its own process group, killed as a whole.
type tree struct{ pid int }

func prepareTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func trackTree(cmd *exec.Cmd) *tree { return &tree{pid: cmd.Process.Pid} }

func (t *tree) kill() {
	if t.pid > 0 {
		_ = syscall.Kill(-t.pid, syscall.SIGKILL)
	}
}

func (t *tree) close() {}
