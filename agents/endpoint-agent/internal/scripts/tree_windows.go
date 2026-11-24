//go:build windows

package scripts

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// On Windows the script and everything it starts go into a job object, so a timeout or a cancel
// stops the whole tree. A script that ends normally leaves what it started on purpose running
// (an installer started with Start-Process, say): the job is then only closed.
type tree struct{ job windows.Handle }

func prepareTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func trackTree(cmd *exec.Cmd) *tree {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return &tree{}
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err == nil {
		_ = windows.AssignProcessToJobObject(job, h)
		_ = windows.CloseHandle(h)
	}
	return &tree{job: job}
}

func (t *tree) kill() {
	if t.job != 0 {
		_ = windows.TerminateJobObject(t.job, 1)
	}
}

func (t *tree) close() {
	if t.job != 0 {
		_ = windows.CloseHandle(t.job)
		t.job = 0
	}
}
