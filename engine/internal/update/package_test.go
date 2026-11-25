package update

import (
	"errors"
	"testing"
)

const storeFull = "Nigafiy.Hub_1.2.3.0_x64__8wekyb3d8bbwe"

func TestPackageFromPathRecognisesTheWindowsAppsFolder(t *testing.T) {
	id, ok := PackageFromPath(`C:\Program Files\WindowsApps\` + storeFull + `\app`)
	if !ok || id.FullName != storeFull || id.FamilyName != "Nigafiy.Hub_8wekyb3d8bbwe" {
		t.Fatalf("package folder: %+v %v", id, ok)
	}
	for _, dir := range []string{
		`C:\Program Files\Nigafiy`,
		`C:\Users\u\AppData\Local\Programs\Nigafiy`,
		`C:\Temp\` + storeFull + `\app`,                 // the name alone is not enough
		`C:\Program Files\WindowsApps\Nigafiy\app`,      // not a package full name
		`C:\Program Files\WindowsApps\a_1_x64__abc\app`, // malformed
		``,
	} {
		if _, ok := PackageFromPath(dir); ok {
			t.Errorf("%q taken for a package", dir)
		}
	}
}

func TestDetectInstallWithAFakeIdentityReader(t *testing.T) {
	user := `C:\Users\u\AppData\Local\Programs\Nigafiy`
	nsis := MapRegistry{`HKCU\SOFTWARE\` + NSISGUID: {"InstallLocation": user}}
	packaged := func() (PackageIdentity, bool, error) {
		return PackageIdentity{FullName: storeFull, FamilyName: "Nigafiy.Hub_8wekyb3d8bbwe"}, true, nil
	}
	// The process's own identity wins over an NSIS registration of the same folder.
	got := DetectInstallWith(user, nsis, packaged)
	if got.Kind != KindMSIX || got.Scope != "user" || got.PackageFullName != storeFull || got.PackageFamilyName != "Nigafiy.Hub_8wekyb3d8bbwe" {
		t.Fatalf("packaged process: %+v", got)
	}
	// No identity: the registry decides, as before.
	if got := DetectInstallWith(user, nsis, NoPackage); got.Kind != KindNSIS {
		t.Fatalf("unpackaged: %+v", got)
	}
	// An error reading the identity is not a package.
	broken := func() (PackageIdentity, bool, error) { return PackageIdentity{}, false, errors.New("error 87") }
	if got := DetectInstallWith(user, nsis, broken); got.Kind != KindNSIS {
		t.Fatalf("reader error: %+v", got)
	}
	// No identity but the folder is a package folder (a program started from it by something else).
	dir := `C:\Program Files\WindowsApps\` + storeFull + `\app`
	if got := DetectInstallWith(dir, MapRegistry{}, NoPackage); got.Kind != KindMSIX || got.PackageFamilyName != "Nigafiy.Hub_8wekyb3d8bbwe" {
		t.Fatalf("package folder: %+v", got)
	}
	if got := DetectInstall(dir, nil); got.Kind != KindMSIX {
		t.Fatalf("package folder without a registry: %+v", got)
	}
}

func TestSystemPackageInAnUnpackagedProcess(t *testing.T) {
	// `go test` is not packaged: no identity, and no error (APPMODEL_ERROR_NO_PACKAGE).
	id, ok, err := SystemPackage()
	if err != nil || ok || id != (PackageIdentity{}) {
		t.Fatalf("SystemPackage = %+v %v %v", id, ok, err)
	}
}
