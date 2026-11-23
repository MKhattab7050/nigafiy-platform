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
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/config"
	"github.com/nigafiy/sensor/internal/router"
	_ "github.com/nigafiy/sensor/internal/router/zyxel"
	"github.com/nigafiy/sensor/internal/router/zyxel/zyxeltest"
	"github.com/nigafiy/sensor/internal/snmp"
)

const routerTestPassword = "router-admin-pass-7f3"

func routerFixture() zyxeltest.Config {
	return zyxeltest.Config{
		Model: "VMG3625-T50B", Firmware: "V5.50(TEST)", User: "admin", Password: routerTestPassword, LockAfter: 3,
		Hosts: []zyxeltest.Host{
			{MAC: "AA:BB:CC:00:00:01", IP: "192.168.1.20", DeviceName: "laptop-1", Icon: "iPC", ConnType: "Wi-Fi 5GHz"},
			{MAC: "AA:BB:CC:00:00:03", IP: "192.168.1.22", DeviceName: "android-x", ConnType: "Wi-Fi 2.4GHz", Blocked: true},
		},
	}
}

// routerAgent is an agent whose configuration authorizes loopback (the test double listens there).
func routerAgent(t *testing.T, srv *zyxeltest.Server, scope string, password string) (*Agent, routerTarget) {
	t.Helper()
	cfg := &config.Config{ServerURL: "http://127.0.0.1:1", StateDir: t.TempDir(), AllowInsecureHTTP: true, AllowLoopbackScopes: true,
		Limits: config.Limits{MaxConcurrency: 8, MaxPPS: 500, PingTimeoutMs: 500}, SpoolMaxBatches: 100, LogLevel: "error"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	deps := Deps{RouterOpen: router.Open, RouterCertificate: router.FetchCertificate}
	a, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", testTuning())
	if err != nil {
		t.Fatal(err)
	}
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	tg := routerTarget{ID: "11111111-1111-4111-8111-111111111111", Vendor: "zyxel", Address: host, Port: port, Transport: "https-pinned",
		PinSHA256: srv.PinSHA256(), Username: "admin", Password: password, CredentialsVersion: "v1"}
	a.setRouterConfig(t, scope, tg)
	return a, tg
}

func (a *Agent) setRouterConfig(t *testing.T, scope string, targets ...routerTarget) {
	t.Helper()
	raw, _ := json.Marshal(routersConfig{Targets: targets})
	rc := &cloud.RemoteConfig{Routers: raw}
	rc.Discovery.Scopes = []cloud.Scope{{ID: "s", CIDR: scope}}
	a.mu.Lock()
	a.remote = rc
	a.mu.Unlock()
}

func (a *Agent) takeItems(t *testing.T) []map[string]any {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []map[string]any
	for _, raw := range a.queue {
		if strings.Contains(string(raw), routerTestPassword) {
			t.Fatalf("a telemetry item carries the router password: %s", raw)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		out = append(out, m)
	}
	a.queue = nil
	return out
}

func command(kind string, payload map[string]any) cloud.Command {
	raw, _ := json.Marshal(payload)
	return cloud.Command{ID: "cmd-" + kind, Kind: kind, Payload: raw}
}

func TestRouterRefreshBlockUnblockAgainstDouble(t *testing.T) {
	srv := zyxeltest.Start(routerFixture())
	defer srv.Close()
	a, tg := routerAgent(t, srv, "127.0.0.0/24", routerTestPassword)
	ctx := context.Background()

	a.routerCommand(ctx, command(cmdRouterRefresh, map[string]any{"request_id": "req-1", "router_id": tg.ID}))
	items := a.takeItems(t)
	if len(items) != 1 || items[0]["ok"] != true || items[0]["request_id"] != "req-1" || items[0]["action"] != "refresh" {
		t.Fatalf("refresh: %+v", items)
	}
	r := items[0]
	if r["identity"].(map[string]any)["model"] != "VMG3625-T50B" || len(r["clients"].([]any)) != 2 || r["capabilities"] == nil {
		t.Fatalf("refresh content: %+v", r)
	}
	if blocked := r["blocked"].([]any); len(blocked) != 1 || blocked[0].(map[string]any)["mac"] != "aa:bb:cc:00:00:03" {
		t.Fatalf("blocked: %+v", r["blocked"])
	}

	a.routerCommand(ctx, command(cmdRouterBlock, map[string]any{"request_id": "req-2", "router_id": tg.ID, "mac": "AA-BB-CC-00-00-01"}))
	items = a.takeItems(t)
	ch := items[0]["change"].(map[string]any)
	if items[0]["ok"] != true || ch["applied"] != true || ch["already_in_effect"] != false || !srv.HostBlocked("AA:BB:CC:00:00:01") {
		t.Fatalf("block: %+v", items)
	}
	// A block that the administrator already made is reported as already in effect.
	a.routerCommand(ctx, command(cmdRouterBlock, map[string]any{"request_id": "req-3", "router_id": tg.ID, "mac": "aa:bb:cc:00:00:03"}))
	items = a.takeItems(t)
	if items[0]["change"].(map[string]any)["already_in_effect"] != true {
		t.Fatalf("pre-existing block: %+v", items)
	}
	a.routerCommand(ctx, command(cmdRouterUnblock, map[string]any{"request_id": "req-4", "router_id": tg.ID, "mac": "aa:bb:cc:00:00:01"}))
	items = a.takeItems(t)
	if items[0]["ok"] != true || srv.HostBlocked("AA:BB:CC:00:00:01") {
		t.Fatalf("unblock: %+v", items)
	}
	// Rate limiting is not implemented by this driver: a typed "unsupported" error, nothing changed.
	a.routerCommand(ctx, command(cmdRouterRateLimit, map[string]any{"request_id": "req-5", "router_id": tg.ID, "mac": "aa:bb:cc:00:00:01", "limit": map[string]int{"down_kbps": 1000}}))
	items = a.takeItems(t)
	if items[0]["ok"] != false || items[0]["error"].(map[string]any)["kind"] != "unsupported" {
		t.Fatalf("rate limit: %+v", items)
	}
	if srv.ActiveSessions() != 0 {
		t.Fatalf("every operation must log out; %d session(s) left", srv.ActiveSessions())
	}
	a.mu.Lock()
	acked := len(a.completed)
	a.mu.Unlock()
	if acked != 5 {
		t.Fatalf("every command is acknowledged, got %d", acked)
	}

	// Certificate fetch for trust on first use: a TLS handshake only, no login.
	logins := srv.Logins
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	a.routerCommand(ctx, command(cmdRouterFetchCertificate, map[string]any{"request_id": "req-6", "router_id": tg.ID, "address": host, "port": port}))
	items = a.takeItems(t)
	cert := items[0]["certificate"].(map[string]any)
	pin, _ := router.ParsePin(cert["sha256"].(string))
	want, _ := router.ParsePin(srv.PinSHA256())
	if items[0]["ok"] != true || string(pin) != string(want) || srv.Logins != logins {
		t.Fatalf("certificate: %+v", items)
	}
}

func TestRouterOutsideScopeIsNeverContacted(t *testing.T) {
	srv := zyxeltest.Start(routerFixture())
	defer srv.Close()
	a, tg := routerAgent(t, srv, "192.168.1.0/24", routerTestPassword)
	a.routerCommand(context.Background(), command(cmdRouterBlock, map[string]any{"request_id": "r", "router_id": tg.ID, "mac": "aa:bb:cc:00:00:01"}))
	items := a.takeItems(t)
	if items[0]["ok"] != false || items[0]["error"].(map[string]any)["kind"] != "not_authorized" || srv.Logins+srv.FailedLogins != 0 {
		t.Fatalf("out of scope: %+v", items)
	}
	a.routerCommand(context.Background(), command(cmdRouterRefresh, map[string]any{"request_id": "r2", "router_id": "unknown-router"}))
	if items := a.takeItems(t); items[0]["error"].(map[string]any)["kind"] != "not_configured" {
		t.Fatalf("unknown router: %+v", items)
	}
}

// Rejected credentials pause logins until the administrator changes them: the router never sees
// a second wrong attempt from us, so we can never lock the administrator out.
func TestRouterBadCredentialsPauseLogins(t *testing.T) {
	srv := zyxeltest.Start(routerFixture())
	defer srv.Close()
	a, tg := routerAgent(t, srv, "127.0.0.0/24", "wrong-password")
	ctx := context.Background()
	for i := 0; i < 4; i++ {
		a.routerCommand(ctx, command(cmdRouterRefresh, map[string]any{"request_id": "r", "router_id": tg.ID}))
	}
	items := a.takeItems(t)
	if items[0]["error"].(map[string]any)["kind"] != "bad_credentials" {
		t.Fatalf("first: %+v", items[0])
	}
	for _, it := range items[1:] {
		if it["error"].(map[string]any)["kind"] != "login_suspended" {
			t.Fatalf("later attempts must be suspended: %+v", it)
		}
	}
	if srv.FailedLogins != 1 {
		t.Fatalf("the router saw %d failed logins; want exactly 1", srv.FailedLogins)
	}
	// New credentials (new version) lift the pause.
	tg.Password, tg.CredentialsVersion = routerTestPassword, "v2"
	a.setRouterConfig(t, "127.0.0.0/24", tg)
	a.routerCommand(ctx, command(cmdRouterRefresh, map[string]any{"request_id": "r", "router_id": tg.ID}))
	if items := a.takeItems(t); items[0]["ok"] != true {
		t.Fatalf("after new credentials: %+v", items)
	}
}

func TestRouterLockedOutWaitsRetryAfter(t *testing.T) {
	sp := newRouterState()
	tg := routerTarget{ID: "r", CredentialsVersion: "v1"}
	now := time.Now()
	sp.suspend(tg, now.Add(time.Minute), "locked_out")
	if _, ok := sp.suspension(tg, now); !ok {
		t.Fatal("must be suspended during the lock")
	}
	if _, ok := sp.suspension(tg, now.Add(2*time.Minute)); ok {
		t.Fatal("must resume after the retry-after")
	}
}

// The on-disk configuration cache never contains router credentials.
func TestRouterCredentialsNeverCachedOnDisk(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"server_time": time.Now(),
			"config": map[string]any{"heartbeat_interval_seconds": 30, "discovery": map[string]any{"interval_seconds": 300, "scopes": []any{}}, "checks": []any{},
				"routers": map[string]any{"targets": []any{map[string]any{"id": "r1", "vendor": "zyxel", "address": "192.168.1.1", "transport": "https",
					"username": "admin", "password": routerTestPassword, "credentials_version": "v1"}}}},
			"commands": []any{},
		})
	}))
	defer srv.Close()
	stateDir := t.TempDir()
	a := newTestAgent(t, srv.URL, stateDir, "", &recordingProber{})
	a.client.SetCredential("ldc_x")
	bo := cloud.Backoff{Min: time.Millisecond, Max: time.Millisecond}
	connected := true
	a.heartbeatOnce(context.Background(), &bo, &connected)
	if _, ok := a.routerTarget("r1"); !ok {
		t.Fatal("router config not applied in memory")
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "remote-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), routerTestPassword) || strings.Contains(string(raw), "routers") {
		t.Fatalf("router credentials reached the disk cache: %s", raw)
	}
}

func TestRouterStatePruneAndSNMPPrune(t *testing.T) {
	rs := newRouterState()
	ctx := context.Background()
	relKeep, ok := rs.acquire(ctx, "keep")
	if !ok {
		t.Fatal("acquire keep")
	}
	relKeep()
	relBusy, ok := rs.acquire(ctx, "gone-busy")
	if !ok {
		t.Fatal("acquire gone-busy")
	}
	relIdle, ok := rs.acquire(ctx, "gone-idle")
	if !ok {
		t.Fatal("acquire gone-idle")
	}
	relIdle()

	now := time.Now()
	rs.suspend(routerTarget{ID: "keep", CredentialsVersion: "v1"}, now.Add(time.Minute), "locked")
	rs.suspend(routerTarget{ID: "gone-idle", CredentialsVersion: "v1"}, now.Add(time.Minute), "locked")
	rs.mu.Lock()
	rs.last["keep"] = now
	rs.last["gone-idle"] = now
	rs.refused["keep"] = true
	rs.refused["gone-idle"] = true
	rs.mu.Unlock()

	rs.prune(map[string]bool{"keep": true})

	rs.mu.Lock()
	if rs.busy["keep"] == nil || rs.last["keep"].IsZero() || !rs.refused["keep"] {
		t.Fatalf("active router state was pruned unexpectedly: busy=%v last=%v refused=%v", rs.busy["keep"] != nil, rs.last, rs.refused)
	}
	if _, ok := rs.suspended["keep"]; !ok {
		t.Fatal("active suspension was pruned")
	}
	if _, ok := rs.busy["gone-busy"]; !ok {
		t.Fatal("busy channel with active lock (len==1) must not be pruned mid-operation")
	}
	if _, ok := rs.busy["gone-idle"]; ok {
		t.Fatal("idle deleted router busy channel should be pruned")
	}
	if _, ok := rs.suspended["gone-idle"]; ok {
		t.Fatal("deleted router suspension should be pruned")
	}
	if _, ok := rs.last["gone-idle"]; ok {
		t.Fatal("deleted router last timestamp should be pruned")
	}
	if _, ok := rs.refused["gone-idle"]; ok {
		t.Fatal("deleted router refused flag should be pruned")
	}
	rs.mu.Unlock()

	// Once the in-flight operation finishes, the next prune removes gone-busy.
	relBusy()
	rs.prune(map[string]bool{"keep": true})
	rs.mu.Lock()
	if _, ok := rs.busy["gone-busy"]; ok {
		t.Fatal("released deleted router busy channel should be pruned")
	}
	rs.mu.Unlock()

	last := map[string]time.Time{"s1": now, "s2": now}
	var refusedMu sync.Mutex
	refused := map[string]bool{"s1": true, "s2": true}
	pruneSNMPState([]snmp.Target{{ID: "s1"}}, last, &refusedMu, refused)
	if _, ok := last["s1"]; !ok || len(last) != 1 {
		t.Fatalf("unexpected last after SNMP prune: %v", last)
	}
	if !refused["s1"] || len(refused) != 1 {
		t.Fatalf("unexpected refused after SNMP prune: %v", refused)
	}
}
