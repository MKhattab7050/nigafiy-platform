//go:build !windows

package sysinfo

// SafeMode: only Windows has a safe mode the agent reports.
func SafeMode() bool { return false }
