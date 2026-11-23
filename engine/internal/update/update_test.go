package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func staged(t *testing.T) (string, Request) {
	t.Helper()
	data := t.TempDir()
	os.MkdirAll(StagingDir(data), 0o700)
	p := filepath.Join(StagingDir(data), "Nigafiy-Setup-2.0.0.exe")
	os.WriteFile(p, []byte("MZ installer"), 0o600)
	sum := sha256.Sum256([]byte("MZ installer"))
	return data, Request{Installer: p, SHA256: hex.EncodeToString(sum[:]), Version: "2.0.0"}
}

type recorder struct {
	calls []string
	code  int
}

func (r *recorder) deps() Deps {
	return Deps{
		WaitExit: func(pid int, _ time.Duration) error { r.calls = append(r.calls, "wait"); return nil },
		RunInstaller: func(path string, args []string) (int, error) {
			r.calls = append(r.calls, "run "+filepath.Base(path)+" "+strings.Join(args, " "))
			return r.code, nil
		},
		StartService: func(name string) error { r.calls = append(r.calls, "service "+name); return nil },
		StartExe:     func(path string) error { r.calls = append(r.calls, "exe "+path); return nil },
	}
}

func TestApplyRunsTheInstallerSilentlyAndRestarts(t *testing.T) {
	data, req := staged(t)
	rec := &recorder{}
	res := Apply(Plan{DataDir: data, Request: req, InstallDir: `C:\Program Files\Nigafiy`, PerMachine: true, WaitPid: 99, ServiceName: "NigafiyEngine"}, rec.deps())
	if !res.OK || !res.Restarted || res.Error != "" || res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("result %+v", res)
	}
	want := `wait|run Nigafiy-Setup-2.0.0.exe /S /allusers --updated /D=C:\Program Files\Nigafiy|service NigafiyEngine`
	if got := strings.Join(rec.calls, "|"); got != want {
		t.Fatalf("calls %q", got)
	}
	saved, err := ReadResult(ResultPath(data))
	if err != nil || saved == nil || !saved.OK || saved.Version != "2.0.0" {
		t.Fatalf("saved %+v %v", saved, err)
	}
}

func TestApplyRefusesATamperedInstallerButStillRestarts(t *testing.T) {
	data, req := staged(t)
	os.WriteFile(req.Installer, []byte("MZ tampered"), 0o600)
	rec := &recorder{}
	res := Apply(Plan{DataDir: data, Request: req, InstallDir: `C:\X`, RestartExe: `C:\X\Nigafiy.exe`}, rec.deps())
	if res.OK || !strings.Contains(res.Error, "does not match the signed manifest") || !res.Restarted {
		t.Fatalf("result %+v", res)
	}
	if got := strings.Join(rec.calls, "|"); got != `exe C:\X\Nigafiy.exe` {
		t.Fatalf("calls %q (the installer must not run)", got)
	}
}

func TestApplyReportsInstallerFailure(t *testing.T) {
	data, req := staged(t)
	rec := &recorder{code: 2}
	res := Apply(Plan{DataDir: data, Request: req, InstallDir: `C:\X`}, rec.deps())
	if res.OK || res.Error != "the installer exited with code 2" || *res.ExitCode != 2 {
		t.Fatalf("result %+v", res)
	}
}

func TestApplyNeverRunsOverARunningEngine(t *testing.T) {
	data, req := staged(t)
	rec := &recorder{}
	d := rec.deps()
	d.WaitExit = func(int, time.Duration) error { return errors.New("still running") }
	res := Apply(Plan{DataDir: data, Request: req, InstallDir: `C:\X`, WaitPid: 5, ServiceName: "NigafiyEngine"}, d)
	if res.OK || !strings.Contains(res.Error, "did not stop") || len(rec.calls) != 0 {
		t.Fatalf("result %+v calls %v", res, rec.calls)
	}
}

func TestValidateAndThumbprint(t *testing.T) {
	data, req := staged(t)
	if err := req.Validate(data); err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]Request{
		"upper-case hash": {Installer: req.Installer, SHA256: strings.ToUpper(req.SHA256), Version: "2.0.0"},
		"bad version":     {Installer: req.Installer, SHA256: req.SHA256, Version: "2.0"},
		"relative":        {Installer: "Nigafiy-Setup-2.0.0.exe", SHA256: req.SHA256, Version: "2.0.0"},
		"sub folder":      {Installer: filepath.Join(StagingDir(data), "x", "a.exe"), SHA256: req.SHA256, Version: "2.0.0"},
		"dot-dot":         {Installer: filepath.Join(StagingDir(data), "..", "a.exe"), SHA256: req.SHA256, Version: "2.0.0"},
		"not exe":         {Installer: filepath.Join(StagingDir(data), "a.msi"), SHA256: req.SHA256, Version: "2.0.0"},
		"missing":         {Installer: filepath.Join(StagingDir(data), "missing.exe"), SHA256: req.SHA256, Version: "2.0.0"},
	} {
		if err := r.Validate(data); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if tp, err := NormalizeThumbprint("aa bb:" + strings.Repeat("c", 36)); err != nil || tp != "AABB"+strings.Repeat("C", 36) {
		t.Fatalf("thumbprint %q %v", tp, err)
	}
	if _, err := NormalizeThumbprint("xyz"); err == nil {
		t.Fatal("bad thumbprint accepted")
	}
}

func TestPerMachine(t *testing.T) {
	if filepath.Separator == '/' {
		t.Skip("Windows paths")
	}
	pf, pf86 := `C:\Program Files`, `C:\Program Files (x86)`
	for dir, want := range map[string]bool{
		`C:\Program Files\LAN Detective`:       true,
		`c:\program files (x86)\Nigafiy`:       true,
		`C:\Users\me\AppData\Local\Programs\N`: false,
		`C:\Program FilesX\N`:                  false,
	} {
		if got := PerMachine(dir, pf, pf86, ""); got != want {
			t.Errorf("%s: %v", dir, got)
		}
	}
	if got := strings.Join(InstallerArgs(`C:\U\N`, false), " "); got != `/S /currentuser --updated /D=C:\U\N` {
		t.Fatal(got)
	}
}

func TestRestartTargetFollowsTheRenamedApp(t *testing.T) {
	dir := filepath.Join("C:", "Users", "u", "AppData", "Local", "Programs", "LAN Detective")
	old := filepath.Join(dir, "LAN Detective.exe")
	renamed := filepath.Join(dir, "Nigafiy.exe")
	have := map[string]bool{}
	exists := func(p string) bool { return have[p] }

	have[renamed] = true
	if got := RestartTarget(old, dir, exists); got != renamed {
		t.Fatalf("old exe gone, new one there: %s", got)
	}
	have[old] = true
	if got := RestartTarget(old, dir, exists); got != old {
		t.Fatalf("old exe still there: %s", got)
	}
	delete(have, old)
	if got := RestartTarget(filepath.Join("D:", "elsewhere", "app.exe"), dir, exists); got != filepath.Join("D:", "elsewhere", "app.exe") {
		t.Fatalf("outside the install folder: %s", got)
	}
	delete(have, renamed)
	if got := RestartTarget(old, dir, exists); got != old {
		t.Fatalf("nothing found: %s", got)
	}
}
