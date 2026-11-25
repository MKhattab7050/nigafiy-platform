package engine

import (
	"path/filepath"
	"testing"

	"github.com/nigafiy/engine/internal/control"
	"github.com/nigafiy/engine/internal/update"
)

func TestNormalizePrograms(t *testing.T) {
	for in, want := range map[string]string{
		"":                         "all",
		" ALL ":                    "all",
		"radar,watch":              "hub,radar,watch",
		"Watch, radar ,watch,,hub": "hub,watch,radar",
		"hub,radar,watch,guard,fleet,mind,toolbox": "all",
		"toolbox": "hub,toolbox",
	} {
		got, err := NormalizePrograms(in)
		if err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"radar,doom", "radar;watch", "hub radar"} {
		if _, err := NormalizePrograms(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestResolveProgramsReadsTheRootOfTheInstall(t *testing.T) {
	userInstall := filepath.Join(`C:\Users\u\AppData\Local\Programs`, "Nigafiy")
	machineInstall := `C:\Program Files\Nigafiy`
	bundle := func(dir string) string { return filepath.Join(dir, "resources", "backend") }
	none := func(string) string { return "" }
	reg := update.MapRegistry{
		`HKCU\SOFTWARE\` + update.NSISGUID: {"InstallLocation": userInstall},
		`HKCU\` + ProgramsKey:              {"Programs": "radar,watch"},
		`HKLM\` + ProgramsKey:              {"Programs": "fleet"},
	}
	if got := ResolvePrograms(none, bundle(userInstall), reg); got != (ProgramsChoice{Value: "hub,radar,watch", Source: "HKCU"}) {
		t.Fatalf("per-user install: %+v", got)
	}
	// A per-machine install reads HKLM only, even when a user has an HKCU value.
	reg[`HKLM\SOFTWARE\`+update.NSISGUID] = map[string]any{"InstallLocation": machineInstall}
	if got := ResolvePrograms(none, bundle(machineInstall), reg); got != (ProgramsChoice{Value: "hub,fleet", Source: "HKLM"}) {
		t.Fatalf("per-machine install: %+v", got)
	}
	// The engine's own NIGAFIY_PROGRAMS wins.
	env := func(k string) string {
		if k == "NIGAFIY_PROGRAMS" {
			return "guard"
		}
		return ""
	}
	if got := ResolvePrograms(env, bundle(userInstall), reg); got.Source != "env" || programsEnv(got) != "" {
		t.Fatalf("env: %+v", got)
	}
	// Invalid recorded value: ignored, with the reason.
	bad := update.MapRegistry{`HKCU\` + ProgramsKey: {"Programs": "radar,doom"}}
	if got := ResolvePrograms(none, "", bad); got.Source != "invalid" || got.Error == "" || programsEnv(got) != "" {
		t.Fatalf("invalid: %+v", got)
	}
	if got := ResolvePrograms(none, "", update.MapRegistry{}); got.Source != "default" || programsEnv(got) != "" {
		t.Fatalf("nothing recorded: %+v", got)
	}
	if got := ResolvePrograms(none, "", nil); got.Source != "default" {
		t.Fatalf("no registry: %+v", got)
	}
	// The Store package reads HKCU (its private copy) only, even when HKLM has a value.
	store := `C:\Program Files\WindowsApps\Nigafiy.Hub_1.2.3.0_x64__8wekyb3d8bbwe\app`
	storeReg := update.MapRegistry{`HKLM\` + ProgramsKey: {"Programs": "fleet"}}
	if got := ResolvePrograms(none, bundle(store), storeReg); got.Source != "default" {
		t.Fatalf("Store package, HKLM only: %+v", got)
	}
	storeReg[`HKCU\`+ProgramsKey] = map[string]any{"Programs": "mind"}
	if got := ResolvePrograms(none, bundle(store), storeReg); got != (ProgramsChoice{Value: "hub,mind", Source: "HKCU"}) {
		t.Fatalf("Store package: %+v", got)
	}
	if programsEnv(ProgramsChoice{Value: "hub,radar", Source: "HKCU"}) != "NIGAFIY_PROGRAMS=hub,radar" {
		t.Fatal("programsEnv")
	}
}

func TestStatusReportsTheProgramsChoice(t *testing.T) {
	install := filepath.Join(t.TempDir(), "Nigafiy")
	old := installRegistry
	installRegistry = func() update.Registry {
		return update.MapRegistry{
			`HKCU\SOFTWARE\` + update.NSISGUID: {"InstallLocation": install},
			`HKCU\` + ProgramsKey:              {"Programs": "radar"},
		}
	}
	t.Cleanup(func() { installRegistry = old })
	t.Setenv("NIGAFIY_PROGRAMS", "")
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true; c.BundleDir = filepath.Join(install, "resources", "backend") })
	doc := r.waitStatus(t, "programs", func(d control.StatusDoc) bool { return d.Programs != nil })
	if doc.Programs.Value != "hub,radar" || doc.Programs.Source != "HKCU" {
		t.Fatalf("programs %+v", doc.Programs)
	}
}
