package monitor

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReportServicesAndCachedEvents(t *testing.T) {
	var runs atomic.Int32
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	var gotEnv []string
	p := &Prober{
		GOOS: "windows",
		Run: func(_ context.Context, env []string, name string, args ...string) (string, error) {
			runs.Add(1)
			gotEnv = env
			return `{"ok":true,"count":3,"sample":"Service Control Manager 7034 at 2026-11-24T09:58:00Z"}`, nil
		},
		ServiceState: func(n string) string { return map[string]string{"Spooler": "running"}[n] + "" },
		Now:          func() time.Time { return now },
	}
	if p.Report(context.Background()) != nil {
		t.Fatal("nothing asked: no report")
	}
	q := EventQuery{ID: "r1", Log: "System", IDs: []int{7034, 7031}, Level: "error", Match: "'; Remove-Item C:\\ -Recurse #", WindowMinutes: 30}
	p.SetSpec(Spec{Services: []string{"Spooler", "Missing"}, Events: []EventQuery{q}})
	r := p.Report(context.Background())
	if r.Services["Spooler"] != "running" || r.Services["Missing"] != "" {
		t.Fatalf("%+v", r.Services)
	}
	deadline := time.Now().Add(2 * time.Second)
	for runs.Load() == 0 || p.Report(context.Background()).Events["r1"].Count == 0 {
		if time.Now().After(deadline) {
			t.Fatal("event query did not run")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if res := p.Report(context.Background()).Events["r1"]; res.Count != 3 || !strings.Contains(res.Sample, "7034") {
		t.Fatalf("%+v", res)
	}
	// Within a minute the cached count is reused.
	before := runs.Load()
	p.Report(context.Background())
	time.Sleep(20 * time.Millisecond)
	if runs.Load() != before {
		t.Fatal("event queries run at most once a minute")
	}
	// The rule's values are data in the environment, never in the script text.
	joined := strings.Join(gotEnv, "\n")
	if !strings.Contains(joined, "NIGAFIY_MON_MATCH='; Remove-Item C:\\ -Recurse #") || !strings.Contains(joined, "NIGAFIY_MON_IDS=7034,7031") {
		t.Fatalf("%v", gotEnv)
	}
	if strings.Contains(windowsEventScript, "Remove-Item") {
		t.Fatal("script text is fixed")
	}
	// A rule removed from the spec drops its result.
	p.SetSpec(Spec{Services: []string{"Spooler"}})
	if _, ok := p.Report(context.Background()).Events["r1"]; ok {
		t.Fatal("dropped")
	}
}

func TestParsersAndArgs(t *testing.T) {
	res := ParseWindowsEventResult(`{"ok":false,"error":"The specified channel could not be found."}`, nil, EventResult{})
	if !strings.Contains(res.Error, "channel could not be found") {
		t.Fatalf("%+v", res)
	}
	res = ParseWindowsEventResult(``, errors.New("exit status 1"), EventResult{})
	if !strings.Contains(res.Error, "exit status 1") {
		t.Fatalf("%+v", res)
	}
	args := strings.Join(JournalArgs(EventQuery{Source: "nginx.service", Level: "error", WindowMinutes: 15}), " ")
	if args != "--no-pager -q -o json --since -15min -u nginx.service -p err" {
		t.Fatal(args)
	}
	out := `{"MESSAGE":"upstream timed out","_SYSTEMD_UNIT":"nginx.service","__REALTIME_TIMESTAMP":"1795600000000000"}
{"MESSAGE":"started","_SYSTEMD_UNIT":"nginx.service","__REALTIME_TIMESTAMP":"1795600001000000"}
not json`
	n, s := CountJournal(out, "TIMED OUT")
	if n != 1 || !strings.HasPrefix(s, "nginx.service at ") || strings.Contains(s, "upstream") {
		t.Fatalf("%d %q (never the message text)", n, s)
	}
	if n, _ := CountJournal(out, ""); n != 2 {
		t.Fatal(n)
	}
	p := &Prober{GOOS: "linux", Now: time.Now, Run: func(context.Context, []string, string, ...string) (string, error) { return "", nil }}
	if r := p.QueryEvents(context.Background(), EventQuery{IDs: []int{1}}); !strings.Contains(r.Error, "Windows only") {
		t.Fatal(r.Error)
	}
	p.GOOS = "darwin"
	if r := p.QueryEvents(context.Background(), EventQuery{}); !strings.Contains(r.Error, "Linux") {
		t.Fatal(r.Error)
	}
	if SystemctlState("active\n") != "running" || SystemctlState("failed\n") != "stopped" || SystemctlState("") != "not_found" {
		t.Fatal("systemctl")
	}
	if LaunchctlState("{\n\t\"PID\" = 412;\n}", nil) != "running" || LaunchctlState("Could not find service \"x\"", errors.New("exit 113")) != "not_found" {
		t.Fatal("launchctl")
	}
}

// Read-only, on this computer: the state of a service that exists on every Windows (RpcSs), one
// that does not, and a count from the System log.
func TestRealWindowsServiceAndEventLog(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	if s := serviceState("RpcSs"); s != "running" {
		t.Fatalf("RpcSs: %s", s)
	}
	if s := serviceState("NigafiyNoSuchService"); s != "not_found" {
		t.Fatalf("missing: %s", s)
	}
	p := New()
	res := p.QueryEvents(context.Background(), EventQuery{ID: "x", Log: "System", WindowMinutes: 1440, Level: "any"})
	if res.Error != "" {
		t.Fatalf("System log: %s", res.Error)
	}
	t.Logf("System log entries in the last 24 h: %d (newest: %s)", res.Count, res.Sample)
	res = p.QueryEvents(context.Background(), EventQuery{ID: "y", Log: "Nigafiy-No-Such-Log", WindowMinutes: 5})
	if res.Error == "" {
		t.Fatal("an unknown log is an error, not zero")
	}
}
