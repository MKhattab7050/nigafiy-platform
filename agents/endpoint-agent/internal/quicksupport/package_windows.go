//go:build windows

package quicksupport

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetCurrentPackageFullName = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCurrentPackageFullName")

// Packaged reports whether this process runs as an MSIX package (the Microsoft Store version):
// GetCurrentPackageFullName answers ERROR_INSUFFICIENT_BUFFER (122) with package identity and
// APPMODEL_ERROR_NO_PACKAGE (15700) without. Any other answer is treated as not packaged.
func Packaged() bool {
	if procGetCurrentPackageFullName.Find() != nil {
		return false
	}
	var n uint32
	r, _, _ := procGetCurrentPackageFullName.Call(uintptr(unsafe.Pointer(&n)), 0)
	return r == uintptr(windows.ERROR_INSUFFICIENT_BUFFER)
}
