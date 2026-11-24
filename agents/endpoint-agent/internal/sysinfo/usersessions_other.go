//go:build !windows

package sysinfo

// UserSessions: Windows only (Linux and macOS list their signed-in users in logged_in_users).
func UserSessions() []UserSession { return nil }
