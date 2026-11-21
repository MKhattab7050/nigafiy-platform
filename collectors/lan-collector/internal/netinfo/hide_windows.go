//go:build windows

package netinfo

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps subprocesses from flashing a console window when the collector runs without one.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
