//go:build windows

package main

import "golang.org/x/sys/windows"

// showError shows a message box: the launcher is a GUI-subsystem binary with no console window.
// NIGAFIY_LAUNCHER_QUIET=1 (tests, scripts) skips it.
func showError(title, msg string) {
	if quiet() {
		return
	}
	t, err1 := windows.UTF16PtrFromString(title)
	m, err2 := windows.UTF16PtrFromString(msg)
	if err1 != nil || err2 != nil {
		return
	}
	_, _ = windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
}
