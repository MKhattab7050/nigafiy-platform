//go:build !windows

package main

// showError: outside Windows the message on stderr is enough.
func showError(_, _ string) {}
