package update

import "testing"

func TestPackGUIDMatchesWindowsInstallerForTheUpgradeCode(t *testing.T) {
	// The packed form Windows Installer writes under Classes\Installer\UpgradeCodes.
	if got := PackGUID("{" + MSIUpgradeCode + "}"); got != "268D7AD67E728CA408D9984B21F83BEA" {
		t.Fatalf("PackGUID = %s", got)
	}
	if got := UnpackGUID("268D7AD67E728CA408D9984B21F83BEA"); got != "{"+MSIUpgradeCode+"}" {
		t.Fatalf("UnpackGUID = %s", got)
	}
	for _, bad := range []string{"", "nope", "6DA7D862-27E7-4AC8-809D"} {
		if PackGUID(bad) != "" {
			t.Fatalf("%q packed", bad)
		}
	}
	if UnpackGUID("short") != "" {
		t.Fatal("short accepted")
	}
}

const (
	msiProduct = "{11111111-2222-3333-4444-555555555555}"
	installDir = `C:\Program Files\Nigafiy`
)

func msiRegistry(location string) MapRegistry {
	entry := map[string]any{"WindowsInstaller": uint64(1), "DisplayName": "Nigafiy"}
	if location != "" {
		entry["InstallLocation"] = location
	}
	return MapRegistry{
		`HKLM\SOFTWARE\Classes\Installer\UpgradeCodes\268D7AD67E728CA408D9984B21F83BEA`: {PackGUID(msiProduct): ""},
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + msiProduct:        entry,
	}
}

func TestDetectInstallRecognisesAnMSIManagedInstall(t *testing.T) {
	for name, reg := range map[string]MapRegistry{
		"upgrade code, no InstallLocation": msiRegistry(""),
		"upgrade code, same folder":        msiRegistry(installDir + `\`),
		"uninstall entry only": {
			`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + msiProduct: {"WindowsInstaller": uint64(1), "InstallLocation": `c:\program files\nigafiy`},
		},
	} {
		got := DetectInstall(installDir, reg)
		if got.Kind != KindMSI || got.ProductCode != msiProduct || got.Scope != "machine" {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

func TestDetectInstallNSISAndUnknown(t *testing.T) {
	user := `C:\Users\u\AppData\Local\Programs\Nigafiy`
	nsisUser := MapRegistry{`HKCU\SOFTWARE\` + NSISGUID: {"InstallLocation": user}}
	if got := DetectInstall(user, nsisUser); got.Kind != KindNSIS || got.Scope != "user" {
		t.Fatalf("per-user NSIS: %+v", got)
	}
	nsisMachine := MapRegistry{`HKLM\SOFTWARE\` + NSISGUID: {"InstallLocation": installDir}}
	if got := DetectInstall(installDir, nsisMachine); got.Kind != KindNSIS || got.Scope != "machine" {
		t.Fatalf("per-machine NSIS: %+v", got)
	}
	// NSIS wins over an MSI registration for the same folder.
	both := msiRegistry(installDir)
	both[`HKLM\SOFTWARE\`+NSISGUID] = map[string]any{"InstallLocation": installDir}
	if got := DetectInstall(installDir, both); got.Kind != KindNSIS {
		t.Fatalf("both: %+v", got)
	}
	// An MSI elsewhere, a non-MSI uninstall entry, or nothing at all: not MSI.
	for name, reg := range map[string]MapRegistry{
		"msi in another folder": msiRegistry(`D:\Other`),
		"not windows installer": {`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + msiProduct: {"WindowsInstaller": uint64(0), "InstallLocation": installDir}},
		"empty":                 {},
	} {
		if got := DetectInstall(installDir, reg); got.Kind != KindUnknown {
			t.Errorf("%s: %+v", name, got)
		}
	}
	if got := DetectInstall(installDir, nil); got.Kind != KindUnknown {
		t.Fatalf("no registry: %+v", got)
	}
}
