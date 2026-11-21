package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/config"
	"github.com/lan-detective/lan-collector/internal/dhcp"
	"github.com/lan-detective/lan-collector/internal/netinfo"
	"github.com/lan-detective/lan-collector/internal/probe"
	"github.com/lan-detective/lan-collector/internal/tools"
)

const goodToken = "lde_test-token-0123456789"

// fakeCloud is a stand-in for the LAN Detective API speaking collector protocol v1.
type fakeCloud struct {
	mu          sync.Mutex
	outage      atomic.Bool
	enrollments int
	heartbeats  int
	batches     map[string]map[string]any // batch_id → batch
	deliveries  int
	pendingCmd  string
	acked       []string
	scopes      []map[string]string
	checks      []map[string]any
}

func (f *fakeCloud) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/collector/enroll", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["enrollment_token"] != goodToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.enrollments++
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"collector_id": "c-1", "credential": "ldc_c-1.secret"})
	})
	authed := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if f.outage.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			if r.Header.Get("Authorization") != "Bearer ldc_c-1.secret" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("/api/v1/collector/heartbeat", authed(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CompletedCommands []string `json:"completed_commands"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.heartbeats++
		f.acked = append(f.acked, body.CompletedCommands...)
		for _, id := range body.CompletedCommands {
			if id == f.pendingCmd {
				f.pendingCmd = ""
			}
		}
		commands := []map[string]string{}
		if f.pendingCmd != "" {
			commands = append(commands, map[string]string{"id": f.pendingCmd, "kind": "run_discovery"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"server_time": time.Now(),
			"config": map[string]any{
				"heartbeat_interval_seconds": 1,
				"discovery":                  map[string]any{"interval_seconds": 300, "scopes": f.scopes},
				"checks":                     f.checks,
			},
			"commands": commands,
		})
	}))
	mux.HandleFunc("/api/v1/collector/telemetry", authed(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var batch map[string]any
		if json.Unmarshal(raw, &batch) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.deliveries++
		f.batches[batch["batch_id"].(string)] = batch
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"accepted":1}`))
	}))
	return mux
}

func (f *fakeCloud) items(kind string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, b := range f.batches {
		for _, raw := range b["items"].([]any) {
			if item := raw.(map[string]any); item["type"] == kind {
				out = append(out, item)
			}
		}
	}
	return out
}

func (f *fakeCloud) requestScan(id string) {
	f.mu.Lock()
	f.pendingCmd = id
	f.mu.Unlock()
}

type recordingProber struct {
	mu     sync.Mutex
	probed []string
}

func (p *recordingProber) Ping(_ context.Context, ip string, _ time.Duration) (time.Duration, bool) {
	p.mu.Lock()
	p.probed = append(p.probed, ip)
	p.mu.Unlock()
	return time.Millisecond, ip == "192.168.50.1" || ip == "192.168.50.2"
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func testTuning() Tuning {
	return Tuning{MinHeartbeat: 50 * time.Millisecond, MinDiscoveryInterval: time.Hour, MinCheckInterval: 100 * time.Millisecond,
		FlushInterval: 50 * time.Millisecond, CheckTick: 20 * time.Millisecond, MaxBackoff: 150 * time.Millisecond}
}

func newTestAgent(t *testing.T, serverURL, stateDir, token string, prober *recordingProber) *Agent {
	t.Helper()
	cfg := &config.Config{ServerURL: serverURL, EnrollmentToken: token, StateDir: stateDir, AllowInsecureHTTP: true,
		Limits: config.Limits{MaxConcurrency: 8, MaxPPS: 500, PingTimeoutMs: 500}, SpoolMaxBatches: 100, LogLevel: "error"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		Prober: prober,
		ICMPCheck: func(_ context.Context, ip string) probe.Result {
			v, l := 1.5, 0.0
			return probe.Result{OK: true, LatencyMs: &v, LossPct: &l, Resolved: ip}
		},
		TCPCheck: func(context.Context, string, int) probe.Result { return probe.Result{Error: "connection refused"} },
		DNSCheck: func(context.Context, string) probe.Result {
			v := 9.0
			return probe.Result{OK: true, LatencyMs: &v, Resolved: "93.184.216.34"}
		},
		Neighbors: func(context.Context) (map[string]netinfo.Neighbor, error) {
			return map[string]netinfo.Neighbor{"192.168.50.1": {MAC: "00:11:22:33:44:55", Reachable: true}}, nil
		},
		Gateway:     func(context.Context) string { return "192.168.50.1" },
		ReverseName: func(context.Context, string) string { return "" },
		ResolveIPv4: func(context.Context, string) (string, error) { return "192.168.50.2", nil },
		Tool: func(_ context.Context, req tools.Request) (map[string]any, error) {
			return map[string]any{"tool": req.Tool, "target": req.Target, "replied": true}, nil
		},
	}
	a, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", testTuning())
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestCollectorLifecycle(t *testing.T) {
	cloud := &fakeCloud{
		batches: map[string]map[string]any{},
		scopes: []map[string]string{
			{"id": "scope-ok", "cidr": "192.168.50.0/29"},
			{"id": "scope-public", "cidr": "8.8.8.0/29"}, // a compromised/misconfigured cloud must not make us probe this
			{"id": "scope-huge", "cidr": "10.0.0.0/8"},   // nor this
		},
		checks: []map[string]any{
			{"id": "chk-gw", "kind": "icmp", "target": "auto:gateway", "port": nil, "interval_seconds": 1},
			{"id": "chk-dns", "kind": "dns", "target": "example.com", "port": nil, "interval_seconds": 1},
			{"id": "chk-tcp", "kind": "tcp", "target": "intranet.lan", "port": 443, "interval_seconds": 1},
			{"id": "chk-weird", "kind": "exec", "target": "rm -rf /", "port": nil, "interval_seconds": 1},
		},
	}
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()
	stateDir := t.TempDir()
	prober := &recordingProber{}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	agent := newTestAgent(t, srv.URL, stateDir, goodToken, prober)
	go func() { done <- agent.Run(ctx) }()

	// 1. Starts, enrolls, stores its credential privately, heartbeats.
	waitFor(t, "first heartbeat", func() bool { cloud.mu.Lock(); defer cloud.mu.Unlock(); return cloud.heartbeats > 0 })
	raw, err := os.ReadFile(filepath.Join(stateDir, "credential.json"))
	if err != nil || !strings.Contains(string(raw), "ldc_c-1.secret") {
		t.Fatalf("credential not persisted: %v", err)
	}

	// 2. Discovers devices in the permitted scope only, and reports checks.
	waitFor(t, "scheduled discovery upload", func() bool { return len(cloud.items("discovery_run")) >= 1 })
	run := cloud.items("discovery_run")[0]
	hosts := run["hosts"].([]any)
	if run["scope_id"] != "scope-ok" || run["hosts_probed"].(float64) != 6 || len(hosts) != 2 {
		t.Fatalf("unexpected discovery run: %+v", run)
	}
	first := hosts[0].(map[string]any)
	if first["ip"] != "192.168.50.1" || first["mac"] != "00:11:22:33:44:55" {
		t.Fatalf("unexpected host: %+v", first)
	}
	waitFor(t, "check results", func() bool { return len(cloud.items("check_result")) >= 3 })
	kinds := map[string]map[string]any{}
	for _, item := range cloud.items("check_result") {
		kinds[item["check_id"].(string)] = item
	}
	if kinds["chk-gw"]["resolved_target"] != "192.168.50.1" || kinds["chk-gw"]["ok"] != true {
		t.Errorf("gateway check wrong: %+v", kinds["chk-gw"])
	}
	if kinds["chk-tcp"]["ok"] != false || kinds["chk-tcp"]["error"] != "connection refused" {
		t.Errorf("tcp check wrong: %+v", kinds["chk-tcp"])
	}
	if _, executed := kinds["chk-weird"]; executed {
		t.Errorf("an unknown check kind must be ignored")
	}

	// 3. Survives a cloud outage: keeps measuring, buffers on disk, sends nothing.
	cloud.outage.Store(true)
	time.Sleep(150 * time.Millisecond)
	cloud.mu.Lock()
	deliveredBefore, checksBefore := cloud.deliveries, 0
	cloud.mu.Unlock()
	checksBefore = len(cloud.items("check_result"))
	waitFor(t, "batches buffered during outage", func() bool { return agent.spool.Depth() >= 3 })
	cloud.mu.Lock()
	if cloud.deliveries != deliveredBefore {
		t.Fatalf("no batch can be accepted during the outage")
	}
	cloud.mu.Unlock()

	// 4. Reconnects with backoff and delivers everything it buffered; manual scan command works.
	cloud.outage.Store(false)
	cloud.requestScan("cmd-1")
	waitFor(t, "buffer drained after reconnect", func() bool { return agent.spool.Depth() == 0 && len(cloud.items("check_result")) > checksBefore+3 })
	waitFor(t, "manual scan executed and acknowledged", func() bool {
		cloud.mu.Lock()
		defer cloud.mu.Unlock()
		return len(cloud.acked) > 0 && cloud.acked[0] == "cmd-1"
	})
	manual := 0
	for _, r := range cloud.items("discovery_run") {
		if r["trigger"] == "manual" {
			manual++
		}
	}
	if manual != 1 {
		t.Errorf("expected exactly one manual discovery run, got %d", manual)
	}

	// 5. Respects scanning limits: never a single probe outside the authorized, bounded scope.
	prober.mu.Lock()
	for _, ip := range prober.probed {
		if !strings.HasPrefix(ip, "192.168.50.") {
			t.Fatalf("probed %s, which is outside the permitted scope", ip)
		}
	}
	prober.mu.Unlock()

	// 6. Graceful shutdown, then restart: identity is reused, no second enrollment.
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("collector did not shut down")
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan error, 1)
	cloud.mu.Lock()
	hbBefore := cloud.heartbeats
	cloud.mu.Unlock()
	go func() { done2 <- newTestAgent(t, srv.URL, stateDir, "", prober).Run(ctx2) }()
	waitFor(t, "heartbeat after restart", func() bool { cloud.mu.Lock(); defer cloud.mu.Unlock(); return cloud.heartbeats > hbBefore })
	cancel2()
	<-done2
	if cloud.enrollments != 1 {
		t.Fatalf("expected exactly 1 enrollment, got %d", cloud.enrollments)
	}
}

func TestEnrollmentRefusedIsFatal(t *testing.T) {
	cloud := &fakeCloud{batches: map[string]map[string]any{}}
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := newTestAgent(t, srv.URL, t.TempDir(), "lde_wrong-token-000000000", &recordingProber{}).Run(ctx)
	if err == nil || !strings.Contains(err.Error(), "enrollment refused") {
		t.Fatalf("expected a refused-enrollment error, got %v", err)
	}
	err = newTestAgent(t, srv.URL, t.TempDir(), "", &recordingProber{}).Run(ctx)
	if err == nil || !strings.Contains(err.Error(), "not enrolled") {
		t.Fatalf("expected a not-enrolled error, got %v", err)
	}
}

func TestMonitoringResumesFromCachedConfigWhileCloudIsDown(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(stateDir, "credential.json"), []byte(`{"collector_id":"c-1","credential":"ldc_c-1.secret"}`), 0o600)
	_ = os.WriteFile(filepath.Join(stateDir, "remote-config.json"),
		[]byte(`{"heartbeat_interval_seconds":30,"discovery":{"interval_seconds":300,"scopes":[]},"checks":[{"id":"chk-dns","kind":"dns","target":"example.com","port":null,"interval_seconds":1}]}`), 0o600)
	// Nothing is listening on this address: the cloud is unreachable from the first second.
	agent := newTestAgent(t, "http://127.0.0.1:1", stateDir, "", &recordingProber{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx) }()
	waitFor(t, "checks buffered with no cloud at all", func() bool { return agent.spool.Depth() >= 2 })
	cancel()
	<-done
}

func TestRunToolEnqueuesResultAndAcknowledgesCommand(t *testing.T) {
	a := newTestAgent(t, "http://127.0.0.1:1", t.TempDir(), "", &recordingProber{})
	a.runTool(context.Background(), cloud.Command{
		ID:      "cmd-tool-1",
		Kind:    "run_tool",
		Payload: json.RawMessage(`{"run_id":"run-1","tool":"ping","target":"192.168.50.1"}`),
	})
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.completed) != 1 || a.completed[0] != "cmd-tool-1" {
		t.Fatalf("expected cmd-tool-1 completed, got %+v", a.completed)
	}
	if len(a.queue) != 1 {
		t.Fatalf("expected 1 queued tool_result, got %d", len(a.queue))
	}
	var item map[string]any
	if err := json.Unmarshal(a.queue[0], &item); err != nil {
		t.Fatal(err)
	}
	if item["type"] != "tool_result" || item["run_id"] != "run-1" || item["ok"] != true {
		t.Fatalf("unexpected tool_result item: %+v", item)
	}
}

func TestDHCPNamesPersistAcrossCollectorRestart(t *testing.T) {
	fc := &fakeCloud{
		batches: map[string]map[string]any{},
		scopes:  []map[string]string{{"id": "scope-1", "cidr": "192.168.50.0/29"}},
	}
	srv := httptest.NewServer(fc.handler())
	defer srv.Close()
	stateDir := t.TempDir()
	prober := &recordingProber{}

	// Reserve an ephemeral UDP port for passive DHCP listening in the first collector run.
	probeConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dhcpAddr := probeConn.LocalAddr().String()
	_ = probeConn.Close()

	ag1 := newTestAgent(t, srv.URL, stateDir, goodToken, prober)
	ag1.deps.DHCPListen = dhcpAddr

	ctx1, cancel1 := context.WithCancel(context.Background())
	done1 := make(chan error, 1)
	go func() { done1 <- ag1.Run(ctx1) }()

	waitFor(t, "first heartbeat before DHCP broadcast", func() bool {
		fc.mu.Lock()
		defer fc.mu.Unlock()
		return fc.heartbeats > 0
	})

	// Record a DHCP-announced hostname while the first collector is running, then shut down
	// before SaveDebounce (30s) expires so the shutdown path must flush dhcp-names.json.
	ag1.dhcp.Record(dhcp.Request{
		MAC: "00:11:22:33:44:55",
		Lease: dhcp.Lease{
			Hostname:    "Galaxy-S24-DHCP",
			VendorClass: "android-dhcp-14",
			RequestedIP: "192.168.50.1",
		},
	}, time.Now().UTC())

	cancel1()
	select {
	case err := <-done1:
		if err != nil {
			t.Fatalf("first Run returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("first collector did not shut down")
	}

	// Verify state_dir/dhcp-names.json was written on shutdown.
	dhcpPath := filepath.Join(stateDir, dhcp.FileName)
	raw, err := os.ReadFile(dhcpPath)
	if err != nil {
		t.Fatalf("expected %s to exist after shutdown: %v", dhcpPath, err)
	}
	if !strings.Contains(string(raw), "Galaxy-S24-DHCP") {
		t.Fatalf("expected %s to contain learned hostname, got %s", dhcpPath, string(raw))
	}

	// Construct a second collector with DHCPListen disabled; it must restore the learned name from disk.
	ag2 := newTestAgent(t, srv.URL, stateDir, "", prober)
	lease, ok := ag2.dhcp.Lookup("00:11:22:33:44:55")
	if !ok || lease.Hostname != "Galaxy-S24-DHCP" || lease.VendorClass != "android-dhcp-14" {
		t.Fatalf("expected DHCP table to be restored on New(), got %+v ok=%v", lease, ok)
	}

	// Run the second collector and trigger a discovery sweep to verify the restored DHCP name is used.
	fc.mu.Lock()
	fc.batches = map[string]map[string]any{}
	fc.mu.Unlock()

	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan error, 1)
	go func() { done2 <- ag2.Run(ctx2) }()

	waitFor(t, "discovery run on second collector", func() bool {
		return len(fc.items("discovery_run")) >= 1
	})
	cancel2()
	<-done2

	runs := fc.items("discovery_run")
	hosts := runs[0]["hosts"].([]any)
	firstHost := hosts[0].(map[string]any)
	rawJSON, _ := json.Marshal(firstHost)
	if firstHost["ip"] != "192.168.50.1" || !strings.Contains(string(rawJSON), "Galaxy-S24-DHCP") || !strings.Contains(string(rawJSON), "android-dhcp-14") {
		t.Fatalf("expected discovered host 192.168.50.1 to carry restored DHCP hostname and vendor class, got %+v", firstHost)
	}
}
