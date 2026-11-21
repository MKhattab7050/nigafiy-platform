//go:build windows

package sysinfo

import (
	"os/exec"
	"syscall"
)

func HideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func hideWindow(cmd *exec.Cmd) {
	HideWindow(cmd)
}

