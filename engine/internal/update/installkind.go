package update

import (
	"path/filepath"
	"strings"
)

// Registry is the read-only part of the Windows registry the engine needs to tell how it was
// installed and which programs were chosen. SystemRegistry is the real one (Windows only); tests
// use a map. Roots are "HKLM" and "HKCU"; paths use backslashes.
type Registry interface {
	SubKeys(root, path string) ([]string, error)
	ValueNames(root, path string) ([]string, error)
	String(root, path, name string) (string, bool)
	Integer(root, path, name string) (uint64, bool)
}

// The desktop app's installer identities (docs/architecture/naming.md, apps/desktop/package.json).
const (
	// MSIUpgradeCode never changes, so every Nigafiy MSI is found by it.
	MSIUpgradeCode = "6DA7D862-27E7-4AC8-809D-89B4128FB3AE"
	// NSISGUID is electron-builder's install key (Software\<GUID>, value InstallLocation).
	NSISGUID = "664f0038-fee2-574d-ae14-23d8a9c943e5"
)

const (
	uninstallKey    = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
	upgradeCodesKey = `SOFTWARE\Classes\Installer\UpgradeCodes`
)

// Install kinds.
const (
	KindMSI     = "msi"     // Windows Installer manages it: updates come from the administrator
	KindNSIS    = "nsis"    // the NSIS installer (per-user or per-machine): the in-app updater applies
	KindUnknown = "unknown" // neither registration names this folder (copied by hand, or not Windows)
	// KindMSIX (package.go): the Microsoft Store package.
)

// InstallInfo says how the desktop app in a folder was installed.
type InstallInfo struct {
	Kind string `json:"kind"`
	// ProductCode is the MSI product code ({GUID}) when Kind is msi.
	ProductCode string `json:"product_code,omitempty"`
	// Scope is "machine" or "user" when known.
	Scope string `json:"scope,omitempty"`
	// PackageFullName and PackageFamilyName name the Microsoft Store package when Kind is msix.
	PackageFullName   string `json:"package_full_name,omitempty"`
	PackageFamilyName string `json:"package_family_name,omitempty"`
}

// PackGUID turns {6DA7D862-27E7-4AC8-809D-89B4128FB3AE} into Windows Installer's packed form
// (each of the first three groups reversed, the rest byte-pair swapped): 268D7AD67E728CA408D9984B21F83BEA.
func PackGUID(guid string) string {
	g := strings.ToUpper(strings.Trim(guid, "{}"))
	parts := strings.Split(g, "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 {
		return ""
	}
	rev := func(s string) string {
		b := []byte(s)
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
		return string(b)
	}
	swap := func(s string) string {
		b := []byte(s)
		for i := 0; i+1 < len(b); i += 2 {
			b[i], b[i+1] = b[i+1], b[i]
		}
		return string(b)
	}
	return rev(parts[0]) + rev(parts[1]) + rev(parts[2]) + swap(parts[3]+parts[4])
}

// UnpackGUID is the inverse of PackGUID ("" when it is not a packed GUID).
func UnpackGUID(packed string) string {
	p := strings.ToUpper(packed)
	if len(p) != 32 {
		return ""
	}
	rev := func(s string) string {
		b := []byte(s)
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
		return string(b)
	}
	swap := func(s string) string {
		b := []byte(s)
		for i := 0; i+1 < len(b); i += 2 {
			b[i], b[i+1] = b[i+1], b[i]
		}
		return string(b)
	}
	tail := swap(p[16:])
	return "{" + rev(p[0:8]) + "-" + rev(p[8:12]) + "-" + rev(p[12:16]) + "-" + tail[0:4] + "-" + tail[4:] + "}"
}

func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(strings.TrimRight(a, `\/`)), filepath.Clean(strings.TrimRight(b, `\/`)))
}

// DetectInstall tells how the desktop app installed in installDir was installed:
//
//   - NSIS: Software\<NSISGUID> (HKCU, then HKLM) has InstallLocation = installDir;
//   - MSI: a product registered under the fixed upgrade code (Classes\Installer\UpgradeCodes) whose
//     uninstall entry has WindowsInstaller=1 and InstallLocation = installDir or no
//     InstallLocation at all; or any uninstall entry with WindowsInstaller=1 whose InstallLocation
//     is installDir (an MSI that was registered some other way).
//
// NSIS wins when both claim the folder (it is the one that wrote the files the engine runs from).
// A folder inside an MSIX package (…\WindowsApps\<package full name>\…) is the Store package before
// anything else (DetectInstallWith also asks the process's own package identity).
func DetectInstall(installDir string, reg Registry) InstallInfo {
	if id, ok := PackageFromPath(installDir); ok && installDir != "" {
		return InstallInfo{Kind: KindMSIX, Scope: "user", PackageFullName: id.FullName, PackageFamilyName: id.FamilyName}
	}
	if reg == nil || installDir == "" {
		return InstallInfo{Kind: KindUnknown}
	}
	for _, root := range []string{"HKCU", "HKLM"} {
		if loc, ok := reg.String(root, `SOFTWARE\`+NSISGUID, "InstallLocation"); ok && sameDir(loc, installDir) {
			scope := "user"
			if root == "HKLM" {
				scope = "machine"
			}
			return InstallInfo{Kind: KindNSIS, Scope: scope}
		}
	}
	isMSI := func(code string, allowNoLocation bool) bool {
		key := uninstallKey + `\` + code
		if v, ok := reg.Integer("HKLM", key, "WindowsInstaller"); !ok || v != 1 {
			return false
		}
		loc, ok := reg.String("HKLM", key, "InstallLocation")
		if !ok || loc == "" {
			return allowNoLocation
		}
		return sameDir(loc, installDir)
	}
	if packed := PackGUID(MSIUpgradeCode); packed != "" {
		if names, err := reg.ValueNames("HKLM", upgradeCodesKey+`\`+packed); err == nil {
			for _, n := range names {
				if code := UnpackGUID(n); code != "" && isMSI(code, true) {
					return InstallInfo{Kind: KindMSI, ProductCode: code, Scope: "machine"}
				}
			}
		}
	}
	if keys, err := reg.SubKeys("HKLM", uninstallKey); err == nil {
		for _, k := range keys {
			if strings.HasPrefix(k, "{") && isMSI(k, false) {
				return InstallInfo{Kind: KindMSI, ProductCode: k, Scope: "machine"}
			}
		}
	}
	return InstallInfo{Kind: KindUnknown}
}

// MapRegistry is a Registry in memory: "HKLM\\SOFTWARE\\X" → value name → string or uint64.
// Used by tests (and by nothing else).
type MapRegistry map[string]map[string]any

func mapKey(root, path string) string { return strings.ToUpper(root + `\` + path) }

func (m MapRegistry) SubKeys(root, path string) ([]string, error) {
	prefix := mapKey(root, path) + `\`
	seen := map[string]bool{}
	var out []string
	for k := range m {
		ku := strings.ToUpper(k)
		if !strings.HasPrefix(ku, prefix) {
			continue
		}
		rest := k[len(prefix):]
		if i := strings.IndexByte(rest, '\\'); i >= 0 {
			rest = rest[:i]
		}
		if !seen[strings.ToUpper(rest)] {
			seen[strings.ToUpper(rest)] = true
			out = append(out, rest)
		}
	}
	return out, nil
}

func (m MapRegistry) values(root, path string) map[string]any {
	want := mapKey(root, path)
	for k, v := range m {
		if strings.ToUpper(k) == want {
			return v
		}
	}
	return nil
}

func (m MapRegistry) ValueNames(root, path string) ([]string, error) {
	v := m.values(root, path)
	if v == nil {
		return nil, errNotFound
	}
	var out []string
	for n := range v {
		out = append(out, n)
	}
	return out, nil
}

func (m MapRegistry) String(root, path, name string) (string, bool) {
	s, ok := m.values(root, path)[name].(string)
	return s, ok
}

func (m MapRegistry) Integer(root, path, name string) (uint64, bool) {
	switch v := m.values(root, path)[name].(type) {
	case uint64:
		return v, true
	case int:
		return uint64(v), true
	}
	return 0, false
}
