//go:build windows

package update

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32                             = windows.NewLazySystemDLL("kernel32.dll")
	procGetCurrentPackageFullName           = modKernel32.NewProc("GetCurrentPackageFullName")
	procGetCurrentPackageFamilyName         = modKernel32.NewProc("GetCurrentPackageFamilyName")
	errorInsufficientBuffer                 = uintptr(windows.ERROR_INSUFFICIENT_BUFFER) // 122: has a package identity
	appmodelErrorNoPackage          uintptr = 15700                                      // APPMODEL_ERROR_NO_PACKAGE
)

// SystemPackage reads this process's package identity (read-only; docs: "Detect package identity
// and runtime context"). Windows without the app model API (before Windows 8) has no packages.
func SystemPackage() (PackageIdentity, bool, error) {
	if procGetCurrentPackageFullName.Find() != nil || procGetCurrentPackageFamilyName.Find() != nil {
		return PackageIdentity{}, false, nil
	}
	full, ok, err := packageString(procGetCurrentPackageFullName)
	if err != nil || !ok {
		return PackageIdentity{}, false, err
	}
	family, _, err := packageString(procGetCurrentPackageFamilyName)
	if err != nil {
		return PackageIdentity{}, false, err
	}
	return PackageIdentity{FullName: full, FamilyName: family}, true, nil
}

func packageString(proc *windows.LazyProc) (string, bool, error) {
	var n uint32
	r, _, _ := proc.Call(uintptr(unsafe.Pointer(&n)), 0)
	switch r {
	case appmodelErrorNoPackage:
		return "", false, nil
	case errorInsufficientBuffer:
	default:
		return "", false, fmt.Errorf("%s: error %d", proc.Name, r)
	}
	if n == 0 || n > 1024 {
		return "", false, fmt.Errorf("%s: unexpected length %d", proc.Name, n)
	}
	buf := make([]uint16, n)
	r, _, _ = proc.Call(uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&buf[0])))
	if r != 0 {
		return "", false, fmt.Errorf("%s: error %d", proc.Name, r)
	}
	return windows.UTF16ToString(buf), true, nil
}
