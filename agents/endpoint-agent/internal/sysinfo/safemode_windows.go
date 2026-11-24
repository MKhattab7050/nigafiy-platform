//go:build windows

package sysinfo

import "golang.org/x/sys/windows"

var procGetSystemMetrics = windows.NewLazySystemDLL("user32.dll").NewProc("GetSystemMetrics")

// SafeMode: Windows started in safe mode (SM_CLEANBOOT: 1 minimal, 2 with networking).
func SafeMode() bool {
	r, _, _ := procGetSystemMetrics.Call(67)
	return r != 0
}
