package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeCtl is a service manager in memory: no real service is touched. onStart plays the started
// program (it may write a health marker, crash, or do nothing).
type fakeCtl struct {
	exists   bool
	binary   string
	running  bool
	calls    []string
	startErr error
	onStart  func(binary string) (running bool)
}

func (f *fakeCtl) Exists(string) (bool, error)       { return f.exists, nil }
func (f *fakeCtl) BinaryPath(string) (string, error) { return f.binary, nil }
func (f *fakeCtl) Running(string) (bool, error)      { return f.running, nil }
func (f *fakeCtl) Stop(string, time.Duration) error {
	f.calls = append(f.calls, "stop")
	f.running = false
	return nil
}
func (f *fakeCtl) Start(string) error {
	f.calls = append(f.calls, "start")
	if f.startErr != nil {
		err := f.startErr
		f.startErr = nil // only the first start (the new version) fails
		return err
	}
	f.running = f.onStart == nil || f.onStart(f.binary)
	return nil
}

type upgradeFixture struct {
	dir, state, target, newExe string
	clock                      time.Time
}

func newUpgradeFixture(t *testing.T) *upgradeFixture {
	t.Helper()
	f := &upgradeFixture{dir: t.TempDir(), state: t.TempDir(), clock: time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)}
	f.target = filepath.Join(f.dir, BinaryName())
	f.newExe = filepath.Join(t.TempDir(), BinaryName())
	must(t, os.WriteFile(f.target, []byte("old version"), 0o755))
	must(t, os.WriteFile(f.newExe, []byte("new version"), 0o755))
	must(t, os.WriteFile(filepath.Join(f.state, "credential.json"), []byte(`{"endpoint_id":"ep-1","credential":"lda_keep"}`), 0o600))
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *upgradeFixture) upgrade(ctl *fakeCtl) *Upgrade {
	return &Upgrade{
		Name: "NigafiyEndpointAgent", NewExe: f.newExe, Version: "1.2.3", StateDir: f.state, Ctl: ctl,
		Timeout: 10 * time.Second, Poll: time.Second,
		Now:   func() time.Time { return f.clock },
		Sleep: func(d time.Duration) { f.clock = f.clock.Add(d) },
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestUpgradeSwapsTheBinaryKeepsThePreviousAndWaitsForTheNewVersionsMarker(t *testing.T) {
	f := newUpgradeFixture(t)
	ctl := &fakeCtl{exists: true, binary: f.target, running: true}
	ctl.onStart = func(bin string) bool {
		// The started program is the new file; it writes its marker a little later.
		if read(t, bin) != "new version" {
			t.Errorf("the service started %q", read(t, bin))
		}
		must(t, WriteHealth(f.state, Health{Version: "1.2.3", PID: 4242, StartedAt: f.clock.Add(3 * time.Second), LastHeartbeatAt: f.clock.Add(4 * time.Second)}))
		return true
	}
	res, err := f.upgrade(ctl).Run()
	if err != nil {
		t.Fatal(err)
	}
	if read(t, f.target) != "new version" || read(t, PreviousName(f.target)) != "old version" {
		t.Fatalf("binary %q, previous %q", read(t, f.target), read(t, PreviousName(f.target)))
	}
	if res.Previous != PreviousName(f.target) || !res.Heartbeat {
		t.Fatalf("result %+v", res)
	}
	if strings.Join(ctl.calls, ",") != "stop,start" {
		t.Fatalf("calls %v", ctl.calls)
	}
	if read(t, filepath.Join(f.state, "credential.json")) != `{"endpoint_id":"ep-1","credential":"lda_keep"}` {
		t.Fatal("the credential changed")
	}
}

func TestUpgradeRollsBackWhenTheNewVersionNeverWritesItsMarker(t *testing.T) {
	for name, tc := range map[string]struct {
		onStart  func(f *upgradeFixture) func(string) bool
		startErr error
		want     string
	}{
		"running but silent": {onStart: func(*upgradeFixture) func(string) bool { return func(string) bool { return true } }, want: "health marker"},
		"crashes at once": {onStart: func(*upgradeFixture) func(string) bool {
			// The new version exits at once; the previous one runs again after the rollback.
			return func(bin string) bool { b, _ := os.ReadFile(bin); return string(b) != "new version" }
		}, want: "not report it running"},
		"old marker only": {onStart: func(f *upgradeFixture) func(string) bool {
			return func(string) bool {
				// A marker from the previous version (or from before the upgrade) does not count.
				_ = WriteHealth(f.state, Health{Version: "1.2.2", PID: 1, StartedAt: f.clock})
				return true
			}
		}, want: "health marker"},
		"start refused": {startErr: errors.New("access denied"), want: "did not start"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newUpgradeFixture(t)
			ctl := &fakeCtl{exists: true, binary: f.target, running: true, startErr: tc.startErr}
			if tc.onStart != nil {
				ctl.onStart = tc.onStart(f)
			}
			// Stale marker written by the old version before the upgrade began.
			must(t, WriteHealth(f.state, Health{Version: "1.2.3", PID: 7, StartedAt: f.clock.Add(-time.Hour)}))
			_, err := f.upgrade(ctl).Run()
			if !errors.Is(err, ErrRolledBack) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want a rollback mentioning %q", err, tc.want)
			}
			if read(t, f.target) != "old version" {
				t.Fatalf("after the rollback the binary is %q", read(t, f.target))
			}
			if _, err := os.Stat(PreviousName(f.target)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("the previous binary was not moved back")
			}
			if !ctl.running {
				t.Fatal("the previous version was not started again")
			}
			if last := ctl.calls[len(ctl.calls)-1]; last != "start" {
				t.Fatalf("calls %v", ctl.calls)
			}
		})
	}
}

func TestUpgradeRefusals(t *testing.T) {
	f := newUpgradeFixture(t)
	cases := map[string]struct {
		ctl  *fakeCtl
		prep func(u *Upgrade)
		want string
	}{
		"no service":       {ctl: &fakeCtl{exists: false}, want: "use install"},
		"same file":        {ctl: &fakeCtl{exists: true, binary: f.target}, prep: func(u *Upgrade) { u.NewExe = f.target }, want: "new version's file"},
		"other folder":     {ctl: &fakeCtl{exists: true, binary: f.target}, prep: func(u *Upgrade) { u.InstallDir = t.TempDir() }, want: "-install-dir"},
		"not enrolled":     {ctl: &fakeCtl{exists: true, binary: f.target}, prep: func(u *Upgrade) { u.StateDir = t.TempDir() }, want: "never enrolls"},
		"bad service name": {ctl: &fakeCtl{exists: true, binary: f.target}, prep: func(u *Upgrade) { u.Name = "a b" }, want: "not valid"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			u := f.upgrade(tc.ctl)
			if tc.prep != nil {
				tc.prep(u)
			}
			_, err := u.Run()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if len(tc.ctl.calls) != 0 {
				t.Fatalf("the service was touched: %v", tc.ctl.calls)
			}
			if read(t, f.target) != "old version" {
				t.Fatal("the installed binary changed")
			}
		})
	}
}

func TestUpgradeCopyFailurePutsTheOldBinaryBackAndRestartsIt(t *testing.T) {
	f := newUpgradeFixture(t)
	ctl := &fakeCtl{exists: true, binary: f.target, running: true}
	u := f.upgrade(ctl)
	u.Copy = func(string, string) error { return errors.New("disk full") }
	_, err := u.Run()
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("err = %v", err)
	}
	if read(t, f.target) != "old version" || !ctl.running || strings.Join(ctl.calls, ",") != "stop,start" {
		t.Fatalf("binary %q running %v calls %v", read(t, f.target), ctl.running, ctl.calls)
	}
}

func TestPlaceBinaryCopiesIntoTheInstallFolder(t *testing.T) {
	src := filepath.Join(t.TempDir(), "download", BinaryName())
	must(t, os.MkdirAll(filepath.Dir(src), 0o755))
	must(t, os.WriteFile(src, []byte("agent"), 0o755))
	dir := filepath.Join(t.TempDir(), "Nigafiy", "Endpoint Agent")
	target, created, err := PlaceBinary(src, dir)
	if err != nil || !created || target != filepath.Join(dir, BinaryName()) || read(t, target) != "agent" {
		t.Fatalf("%s %v %v", target, created, err)
	}
	if _, err := os.Stat(target + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary copy left behind")
	}
	// Run from the install folder itself: nothing to copy.
	again, created, err := PlaceBinary(target, dir)
	if err != nil || created || again != target {
		t.Fatalf("%s %v %v", again, created, err)
	}
	// An existing file is replaced but not reported as created (a failed install keeps it).
	must(t, os.WriteFile(src, []byte("agent v2"), 0o755))
	if _, created, err := PlaceBinary(src, dir); err != nil || created || read(t, target) != "agent v2" {
		t.Fatalf("%v %v", created, err)
	}
	RemovePlaced(target)
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("RemovePlaced left the empty folder")
	}
}

func TestPreviousName(t *testing.T) {
	if got := PreviousName(`C:\Program Files\Nigafiy\Endpoint Agent\nigafiy-agent.exe`); got != `C:\Program Files\Nigafiy\Endpoint Agent\nigafiy-agent.previous.exe` {
		t.Fatal(got)
	}
	if got := PreviousName("/opt/nigafiy-agent/nigafiy-agent"); got != "/opt/nigafiy-agent/nigafiy-agent.previous" {
		t.Fatal(got)
	}
}
