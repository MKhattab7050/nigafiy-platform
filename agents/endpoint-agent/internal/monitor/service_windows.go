//go:build windows

package monitor

import (
	"errors"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func hideWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

// serviceState asks the Service Control Manager with query rights only (any account may).
func serviceState(name string) string {
	m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "unknown"
	}
	defer windows.CloseServiceHandle(m)
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return "not_found"
	}
	s, err := windows.OpenService(m, n, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return "not_found"
		}
		return "unknown"
	}
	defer windows.CloseServiceHandle(s)
	var st windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(s, &st); err != nil {
		return "unknown"
	}
	return WindowsStateName(st.CurrentState)
}

// WindowsStateName names SERVICE_STATUS.dwCurrentState.
func WindowsStateName(state uint32) string {
	switch state {
	case windows.SERVICE_RUNNING:
		return "running"
	case windows.SERVICE_STOPPED:
		return "stopped"
	case windows.SERVICE_PAUSED:
		return "paused"
	case windows.SERVICE_START_PENDING, windows.SERVICE_CONTINUE_PENDING:
		return "starting"
	case windows.SERVICE_STOP_PENDING, windows.SERVICE_PAUSE_PENDING:
		return "stopping"
	}
	return "unknown"
}
