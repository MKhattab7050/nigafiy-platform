package engine

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/nigafiy/engine/internal/update"
)

// Programs chosen at install time (docs/operations/installers.md, "Choose programs").
//
// The installer stores the choice as REG_SZ Programs under Software\Nigafiy\Hub: in HKCU for a
// per-user NSIS install, in HKLM for a per-machine NSIS install and for the MSI (property
// PROGRAMS). The engine passes it to the stack as NIGAFIY_PROGRAMS, the variable the API already
// reads to tell which programs are installed. NIGAFIY_PROGRAMS set in the engine's own environment
// wins (an administrator's override, and the source checkout).

// ProgramsKey is the registry key of the choice.
const ProgramsKey = `SOFTWARE\Nigafiy\Hub`

// ProgramIDs are the programs NIGAFIY_PROGRAMS may name (the API's list).
var ProgramIDs = []string{"hub", "radar", "watch", "guard", "fleet", "mind", "toolbox"}

// NormalizePrograms checks a choice: "all" (or empty), or a comma list of ProgramIDs. The result
// is lower case, without spaces or repeats, with hub first (Hub is always installed).
func NormalizePrograms(v string) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "" || v == "all" {
		return "all", nil
	}
	seen := map[string]bool{"hub": true}
	out := []string{"hub"}
	for _, id := range strings.Split(v, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		known := false
		for _, p := range ProgramIDs {
			known = known || p == id
		}
		if !known {
			return "", fmt.Errorf("unknown program %q (known: %s)", id, strings.Join(ProgramIDs, ", "))
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) == len(ProgramIDs) {
		return "all", nil
	}
	return strings.Join(out, ","), nil
}

// ProgramsChoice is where the programs setting came from.
type ProgramsChoice struct {
	// Value is "all" or the comma list ("" when nothing was chosen: the API's default, all).
	Value string `json:"value"`
	// Source: "env" (NIGAFIY_PROGRAMS of the engine), "HKCU" or "HKLM" (the installer's choice),
	// "default" (none recorded), or "invalid" (a recorded value that is not a valid list; ignored).
	Source string `json:"source"`
	Error  string `json:"error,omitempty"`
}

// ResolvePrograms reads the programs choice for the desktop app installed under bundleDir
// (<install>\resources\backend): the engine's own NIGAFIY_PROGRAMS first, then the registry root
// that belongs to the way it was installed.
func ResolvePrograms(getenv func(string) string, bundleDir string, reg update.Registry) ProgramsChoice {
	if v := getenv("NIGAFIY_PROGRAMS"); strings.TrimSpace(v) != "" {
		return ProgramsChoice{Value: strings.TrimSpace(v), Source: "env"}
	}
	if reg == nil {
		return ProgramsChoice{Source: "default"}
	}
	roots := []string{"HKCU", "HKLM"}
	if bundleDir != "" {
		install := filepath.Dir(filepath.Dir(bundleDir))
		switch info := update.DetectInstall(install, reg); {
		case info.Kind == update.KindMSI, info.Kind == update.KindNSIS && info.Scope == "machine":
			roots = []string{"HKLM"}
		case info.Kind == update.KindNSIS && info.Scope == "user":
			roots = []string{"HKCU"}
		}
	}
	for _, root := range roots {
		raw, ok := reg.String(root, ProgramsKey, "Programs")
		if !ok {
			continue
		}
		v, err := NormalizePrograms(raw)
		if err != nil {
			return ProgramsChoice{Source: "invalid", Error: fmt.Sprintf("%s\\%s Programs: %v", root, ProgramsKey, err)}
		}
		return ProgramsChoice{Value: v, Source: root}
	}
	return ProgramsChoice{Source: "default"}
}

// programsEnv is the NIGAFIY_PROGRAMS entry for the stack's environment ("" when the engine's own
// environment already carries it or nothing was chosen).
func programsEnv(c ProgramsChoice) string {
	if c.Source == "HKCU" || c.Source == "HKLM" {
		return "NIGAFIY_PROGRAMS=" + c.Value
	}
	return ""
}

// InstallInfoDoc is what `nigafiy-engine install-info` prints.
type InstallInfoDoc struct {
	InstallDir string             `json:"install_dir"`
	Install    update.InstallInfo `json:"install"`
	Programs   ProgramsChoice     `json:"programs"`
}

// InstallInfo reads the install kind and the programs choice for the app under bundleDir.
func InstallInfo(bundleDir string, getenv func(string) string) InstallInfoDoc {
	install := filepath.Dir(filepath.Dir(bundleDir))
	reg := installRegistry()
	return InstallInfoDoc{InstallDir: install, Install: update.DetectInstall(install, reg), Programs: ResolvePrograms(getenv, bundleDir, reg)}
}
