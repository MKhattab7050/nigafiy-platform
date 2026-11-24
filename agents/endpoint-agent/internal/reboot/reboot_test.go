package reboot

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fake records every command; nothing real runs (never bcdedit or a restart on the test machine).
type fake struct {
	calls   []string
	fail    map[string]string // command prefix → output of a failure
	restart error
	msgs    []string
}

func (f *fake) run(_ context.Context, name string, args ...string) ([]byte, error) {
	line := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, line)
	for prefix, out := range f.fail {
		if strings.HasPrefix(line, prefix) {
			return []byte(out), errors.New("exit status 1")
		}
	}
	return nil, nil
}

func newManager(t *testing.T, f *fake) *Manager {
	return &Manager{
		StateDir: t.TempDir(), ServiceName: "NigafiyEndpointAgent", GOOS: "windows", InService: true, Run: f.run,
		Restart: func(_ context.Context, msg string) error { f.msgs = append(f.msgs, msg); return f.restart },
	}
}

func TestSafeModeRestartSetsFlagThenClearsAtNextStart(t *testing.T) {
	f := &fake{}
	m := newManager(t, f)
	set, err := m.RestartForReconnect(context.Background(), "safe_mode", "it@corp.test", "Remove driver")
	if err != nil || !set {
		t.Fatalf("set=%v err=%v", set, err)
	}
	want := []string{
		`reg add HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\NigafiyEndpointAgent /ve /t REG_SZ /d Service /f`,
		"bcdedit /set {current} safeboot network",
	}
	if strings.Join(f.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(f.calls, "\n"))
	}
	if !m.SafeBootPending() {
		t.Fatal("marker missing after setting safe boot")
	}
	if len(f.msgs) != 1 || !strings.Contains(f.msgs[0], "it@corp.test") || !strings.Contains(f.msgs[0], "Safe Mode with Networking") || !strings.Contains(f.msgs[0], "Remove driver") {
		t.Fatalf("restart message: %q", f.msgs)
	}
	// The agent starts again (in safe mode): the flag goes before anything else.
	f.calls = nil
	cleared, err := m.ClearAtStart(context.Background())
	if err != nil || !cleared || m.SafeBootPending() {
		t.Fatalf("cleared=%v err=%v pending=%v", cleared, err, m.SafeBootPending())
	}
	if f.calls[0] != "bcdedit /deletevalue {current} safeboot" || !strings.HasPrefix(f.calls[1], "reg delete ") {
		t.Fatalf("clear calls: %q", f.calls)
	}
	// Nothing pending: nothing runs.
	f.calls = nil
	if c, _ := m.ClearAtStart(context.Background()); c || len(f.calls) != 0 {
		t.Fatalf("second start ran %q", f.calls)
	}
}

func TestSafeBootIsRolledBackWhenSettingOrRestartingFails(t *testing.T) {
	f := &fake{fail: map[string]string{"bcdedit /set": "The boot configuration data store could not be opened."}}
	m := newManager(t, f)
	if _, err := m.RestartForReconnect(context.Background(), "safe_mode", "op", "why"); err == nil {
		t.Fatal("expected bcdedit failure")
	}
	if m.SafeBootPending() || len(f.msgs) != 0 {
		t.Fatalf("pending=%v restarted=%v", m.SafeBootPending(), f.msgs)
	}
	if !contains(f.calls, "bcdedit /deletevalue {current} safeboot") {
		t.Fatalf("no rollback: %q", f.calls)
	}

	f2 := &fake{restart: errors.New("shutdown refused")}
	m2 := newManager(t, f2)
	set, err := m2.RestartForReconnect(context.Background(), "safe_mode", "op", "why")
	if err == nil || set || m2.SafeBootPending() {
		t.Fatalf("set=%v err=%v pending=%v", set, err, m2.SafeBootPending())
	}
}

func TestClearKeepsTheMarkerWhenTheFlagCannotBeRemoved(t *testing.T) {
	f := &fake{}
	m := newManager(t, f)
	if err := m.SetSafeBoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.fail = map[string]string{"bcdedit /deletevalue": "Access is denied."}
	if err := m.Clear(context.Background()); err == nil || !m.SafeBootPending() {
		t.Fatalf("err=%v pending=%v", err, m.SafeBootPending())
	}
	// "Element not found" means it is already gone.
	f.fail = map[string]string{"bcdedit /deletevalue": "An error has occurred setting the element data.\nElement not found."}
	if err := m.Clear(context.Background()); err != nil || m.SafeBootPending() {
		t.Fatalf("err=%v pending=%v", err, m.SafeBootPending())
	}
}

func TestSafeModeNeedsWindowsAndTheService(t *testing.T) {
	f := &fake{}
	m := newManager(t, f)
	m.InService = false
	if _, err := m.RestartForReconnect(context.Background(), "safe_mode", "op", "why"); !errors.Is(err, ErrNeedsService) {
		t.Fatalf("err=%v", err)
	}
	m.GOOS = "linux"
	if _, err := m.RestartForReconnect(context.Background(), "safe_mode", "op", "why"); !errors.Is(err, ErrNotWindows) {
		t.Fatalf("err=%v", err)
	}
	// A normal restart works anywhere and touches no boot setting.
	set, err := m.RestartForReconnect(context.Background(), "normal", "", "Apply update")
	if err != nil || set || len(f.calls) != 0 || !strings.HasPrefix(f.msgs[0], "Nigafiy: An IT operator restarts this computer.") {
		t.Fatalf("set=%v err=%v calls=%q msgs=%q", set, err, f.calls, f.msgs)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
