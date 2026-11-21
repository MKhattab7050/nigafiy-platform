package launcher

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func TestProgramsAndIdentity(t *testing.T) {
	want := []string{"hub", "radar", "watch", "guard", "fleet", "mind", "toolbox"}
	if !reflect.DeepEqual(Programs, want) {
		t.Fatalf("Programs = %v, want the shared program table %v", Programs, want)
	}
	ids := map[string]bool{}
	for _, p := range Programs {
		id := AppUserModelID(p)
		if ids[id] {
			t.Fatalf("duplicate AppUserModelID %s", id)
		}
		ids[id] = true
	}
	if got := AppUserModelID("radar"); got != "Nigafiy.Radar" {
		t.Fatalf("AppUserModelID(radar) = %s", got)
	}
	if got := AppUserModelID("evil"); got != "Nigafiy.Hub" {
		t.Fatalf("AppUserModelID(evil) = %s", got)
	}
	if ValidProgram("") || ValidProgram("Radar") || ValidProgram("../hub") {
		t.Fatal("ValidProgram accepted an id that is not in the table")
	}
}

func TestArgsKeepOnlyTheProgramAndWellFormedLinks(t *testing.T) {
	got, err := Args("guard", []string{
		"nigafiy://guard/devices/7/block",
		"NIGAFIY://Radar/devices?trust=unreviewed",
		"--remote-debugging-port=9222",
		"--program=hub",
		"nigafiy://radar/../settings",
		"nigafiy://radar/..",
		"nigafiy://radar/a b",
		"https://example.com",
		"nigafiy://radar/x?<script>",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--program=guard", "nigafiy://guard/devices/7/block", "NIGAFIY://Radar/devices?trust=unreviewed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Args = %q, want %q", got, want)
	}
	if _, err := Args("evil", nil); !errors.Is(err, ErrUnknownProgram) {
		t.Fatalf("Args(evil) error = %v, want ErrUnknownProgram", err)
	}
}

func abs(parts ...string) string {
	root := "/opt"
	if runtime.GOOS == "windows" {
		root = `C:\`
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

type fakeInfo struct{ dir bool }

func (f fakeInfo) Name() string { return "x" }
func (f fakeInfo) Size() int64  { return 1 }
func (f fakeInfo) Mode() fs.FileMode {
	if f.dir {
		return fs.ModeDir
	}
	return 0
}
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.dir }
func (f fakeInfo) Sys() any           { return nil }

func statOf(files map[string]bool) func(string) (fs.FileInfo, error) {
	return func(name string) (fs.FileInfo, error) {
		if dir, ok := files[filepath.Clean(name)]; ok {
			return fakeInfo{dir: dir}, nil
		}
		return nil, fs.ErrNotExist
	}
}

func TestFindOrder(t *testing.T) {
	envRuntime := abs("custom", "Nigafiy.exe")
	regRuntime := abs("Program Files", "Nigafiy", "runtime", "Nigafiy.exe")
	exe := abs("Nigafiy", "launchers", "nigafiy-radar.exe")
	beside := filepath.Clean(filepath.Join(filepath.Dir(exe), "..", "runtime", RuntimeName))

	l := Locator{
		Exe:      exe,
		Env:      func(k string) string { return map[string]string{RuntimeEnv: envRuntime}[k] },
		Registry: func() (string, error) { return regRuntime, nil },
		Stat:     statOf(map[string]bool{envRuntime: false, regRuntime: false, beside: false}),
	}
	if got, err := l.Find(); err != nil || got != envRuntime {
		t.Fatalf("env first: got %q, %v", got, err)
	}
	l.Env = func(string) string { return "" }
	if got, err := l.Find(); err != nil || got != regRuntime {
		t.Fatalf("registry second: got %q, %v", got, err)
	}
	l.Registry = func() (string, error) { return "", errors.New("access denied") }
	if got, err := l.Find(); err != nil || got != beside {
		t.Fatalf("beside the launcher last: got %q, %v", got, err)
	}
	// A directory, a relative path or a missing file is never started.
	l.Env = func(k string) string { return map[string]string{RuntimeEnv: "relative\\Nigafiy.exe"}[k] }
	l.Registry = func() (string, error) { return abs("dir"), nil }
	l.Stat = statOf(map[string]bool{abs("dir"): true})
	if _, err := l.Find(); !errors.Is(err, ErrNoRuntime) {
		t.Fatalf("no runtime: err = %v", err)
	}
}

func TestLaunchStartsTheRuntimeWithTheProgram(t *testing.T) {
	dir := t.TempDir()
	rt := filepath.Join(dir, "runtime", RuntimeName)
	if err := os.MkdirAll(filepath.Dir(rt), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rt, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "launchers", "nigafiy-fleet.exe")
	var started []string
	var startedArgs []string
	got, err := Launch("fleet", []string{"nigafiy://fleet/endpoints/7"}, Locator{Exe: exe, Env: func(string) string { return "" }}, func(r string, a []string) error {
		started = append(started, r)
		startedArgs = a
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != rt || len(started) != 1 || started[0] != rt {
		t.Fatalf("started %v, want %s", started, rt)
	}
	if !reflect.DeepEqual(startedArgs, []string{"--program=fleet", "nigafiy://fleet/endpoints/7"}) {
		t.Fatalf("args = %q", startedArgs)
	}
	if _, err := Launch("nope", nil, Locator{Exe: exe}, func(string, []string) error { t.Fatal("must not start"); return nil }); !errors.Is(err, ErrUnknownProgram) {
		t.Fatalf("unknown program: %v", err)
	}
	if _, err := Launch("fleet", nil, Locator{Exe: filepath.Join(t.TempDir(), "launchers", "x.exe"), Env: func(string) string { return "" }}, func(string, []string) error { t.Fatal("must not start"); return nil }); !errors.Is(err, ErrNoRuntime) {
		t.Fatalf("missing runtime: %v", err)
	}
	boom := errors.New("boom")
	if _, err := Launch("fleet", nil, Locator{Exe: exe, Env: func(string) string { return "" }}, func(string, []string) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("start error not returned: %v", err)
	}
}

func TestRegistryRuntimeReadsWithoutWriting(t *testing.T) {
	// Read-only: on this machine the value is normally absent (the M5 installers write it).
	v, err := RegistryRuntime()
	if err != nil {
		t.Fatalf("RegistryRuntime: %v", err)
	}
	if v != "" && !filepath.IsAbs(v) {
		t.Fatalf("registered runtime path is not absolute: %q", v)
	}
}
