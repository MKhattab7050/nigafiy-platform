package update

import (
	"path/filepath"
	"regexp"
	"strings"
)

// KindMSIX: the desktop app runs as the Microsoft Store package (docs/operations/microsoft-store.md).
// The Store installs and updates it; the in-app updater is off.
const KindMSIX = "msix"

// PackageIdentity is a process's MSIX package identity.
type PackageIdentity struct {
	FullName   string
	FamilyName string
}

// PackageReader returns this process's package identity: ok=false when the process has none.
// SystemPackage is the real one (Windows: GetCurrentPackageFullName / GetCurrentPackageFamilyName);
// tests pass a fake.
type PackageReader func() (PackageIdentity, bool, error)

// NoPackage is a PackageReader for a process without package identity.
func NoPackage() (PackageIdentity, bool, error) { return PackageIdentity{}, false, nil }

// <Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>: the folder Windows installs a package into.
var packageDirRE = regexp.MustCompile(`^([A-Za-z0-9.-]{3,50})_(\d+\.\d+\.\d+\.\d+)_(x64|x86|arm64|arm|neutral)_([A-Za-z0-9.-]*)_([a-z0-9]{13})$`)

// PackageFromPath recognises an installation folder inside a package (…\WindowsApps\<package full
// name>\app, as the desktop package lays it out). It works when the process itself has no package
// identity (a program started from the package folder by something outside it).
func PackageFromPath(installDir string) (PackageIdentity, bool) {
	parts := strings.Split(filepath.ToSlash(filepath.Clean(installDir)), "/")
	for i := 1; i < len(parts); i++ {
		if !strings.EqualFold(parts[i-1], "WindowsApps") {
			continue
		}
		if m := packageDirRE.FindStringSubmatch(parts[i]); m != nil {
			return PackageIdentity{FullName: parts[i], FamilyName: m[1] + "_" + m[5]}, true
		}
	}
	return PackageIdentity{}, false
}

// DetectInstallWith is DetectInstall that first asks whether this process runs as an MSIX package
// (its own identity, then the folder it runs from). A Store package wins over any registry entry:
// its files are the package's, whatever an NSIS or MSI registration of the same product says.
func DetectInstallWith(installDir string, reg Registry, pkg PackageReader) InstallInfo {
	if pkg != nil {
		if id, ok, err := pkg(); err == nil && ok {
			return InstallInfo{Kind: KindMSIX, Scope: "user", PackageFullName: id.FullName, PackageFamilyName: id.FamilyName}
		}
	}
	return DetectInstall(installDir, reg)
}
