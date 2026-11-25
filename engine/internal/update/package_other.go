//go:build !windows

package update

// SystemPackage: MSIX packages exist only on Windows.
func SystemPackage() (PackageIdentity, bool, error) { return PackageIdentity{}, false, nil }
