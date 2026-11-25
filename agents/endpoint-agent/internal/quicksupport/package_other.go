//go:build !windows

package quicksupport

// Packaged: MSIX packages exist only on Windows.
func Packaged() bool { return false }
