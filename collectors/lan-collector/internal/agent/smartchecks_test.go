package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/config"
	"github.com/lan-detective/lan-collector/internal/dhcp"
	"github.com/lan-detective/lan-collector/internal/smart"
)

const smartScopeID = "5c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"

// smartFakes are test doubles for the smart-check Deps; they record every call.
type smartFakes struct {
	mu          sync.Mutex
	ifaces      []smart.DHCPInterface
	dhcpCalls   int
	listen      time.Duration
	dhcpFail    bool
	upnpCalls   int
	wifiCalls   int
	wifiErr     error
	bannerCalls [][]netip.Addr
	bannerPorts [][]int
}

func (f *smartFakes) deps() Deps {
	return Deps{
		SmartInterfaces: func([]netip.Prefix) []smart.DHCPInterface {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.ifaces
		},
		SmartDHCP: func(_ context.Context, ifaces []smart.DHCPInterface, listen time.Duration) []smart.DHCPInterfaceResult {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.dhcpCalls++
			f.listen = listen
			out := []smart.DHCPInterfaceResult{}
			for _, i := range ifaces {
				r := smart.DHCPInterfaceResult{Name: i.Name, Address: i.Address.String(), MAC: i.MAC.String(), ListenSeconds: 1, Offers: []smart.DHCPOffer{
					{ServerID: "192.168.1.2", SourceIP: "192.168.1.2", OfferedIP: "192.168.1.57", Routers: []string{"192.168.1.2"}, DNS: []string{"192.168.1.2", "1.1.1.1"}},
				}}
				if f.dhcpFail {
					r = smart.DHCPInterfaceResult{Name: i.Name, Address: i.Address.String(), MAC: i.MAC.String(),
						ListenError: "cannot listen on UDP 68 (DHCP client port) on 192.168.1.10: address in use"}
				}
				out = append(out, r)
			}
			return out
		},
		SmartUPnP: func(_ context.Context, locals []netip.Addr, _ []netip.Prefix) []smart.UPnPGateway {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.upnpCalls++
			return []smart.UPnPGateway{
				{Address: "192.168.1.2", FriendlyName: "VMG3625-T50B", ExternalIP: "203.0.113.7", Mappings: []smart.UPnPMapping{
					{Protocol: "TCP", ExternalPort: 32400, InternalClient: "192.168.1.30", InternalPort: 32400, Enabled: true}}},
				{Address: "10.9.9.9"}, // outside the authorized scope: never reported
			}
		},
		SmartWiFi: func(context.Context) (smart.WiFiReport, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.wifiCalls++
			if f.wifiErr != nil {
				return smart.WiFiReport{}, f.wifiErr
			}
			q := 70
			return smart.WiFiReport{Platform: "linux", Connected: true,
				Link: &smart.WiFiLink{WiFiNetwork: smart.WiFiNetwork{SSID: "HomeNet", BSSID: "aa:bb:cc:00:11:22", Channel: 36, Band: "5", FrequencyMHz: 5180, SignalPct: &q}},
				Networks: []smart.WiFiNetwork{
					{SSID: "HomeNet", BSSID: "aa:bb:cc:00:11:22", Channel: 36, Band: "5", FrequencyMHz: 5180, SignalPct: &q, Security: "WPA2-Personal"},
					{SSID: "odd", BSSID: "aa:bb:cc:00:11:99"}, // no frequency: left out
				}}, nil
		},
		SmartBanners: func(_ context.Context, targets []netip.Addr, ports []int, _ []netip.Prefix) smart.BannerReport {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.bannerCalls = append(f.bannerCalls, targets)
			f.bannerPorts = append(f.bannerPorts, ports)
			r := smart.BannerReport{Probed: []string{}, Results: []smart.Banner{}}
			for _, t := range targets {
				r.Probed = append(r.Probed, t.String())
				r.Results = append(r.Results, smart.Banner{IP: t.String(), Port: 80, Scheme: "http", Status: 200, Title: "Printer"})
			}
			r.Probed = append(r.Probed, "8.8.8.8") // a misbehaving prober: filtered out by the agent
			return r
		},
	}
}

func (f *smartFakes) counts() (dhcpCalls, upnpCalls, wifiCalls, bannerCalls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dhcpCalls, f.upnpCalls, f.wifiCalls, len(f.bannerCalls)
}

func smartAgent(t *testing.T, deps Deps) *Agent {
	t.Helper()
	cfg := &config.Config{ServerURL: "http://127.0.0.1:1", StateDir: t.TempDir(), AllowInsecureHTTP: true,
		Limits: config.Limits{MaxConcurrency: 8, MaxPPS: 500, PingTimeoutMs: 500}, SpoolMaxBatches: 100, LogLevel: "error"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	a, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", testTuning())
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func defaultSmartFakes() *smartFakes {
	return &smartFakes{ifaces: []smart.DHCPInterface{
		{Name: "eth0", Address: netip.MustParseAddr("192.168.1.10"), MAC: net.HardwareAddr{0x02, 0, 0, 0, 0, 0x10}},
		{Name: "vpn0", Address: netip.MustParseAddr("10.8.0.2"), MAC: net.HardwareAddr{0x02, 0, 0, 0, 0, 0x11}}, // not authorized
	}}
}

// smartCfg is a smart_checks configuration with every check disabled, changed by edit.
func smartCfg(edit func(m map[string]any)) map[string]any {
	m := map[string]any{
		"rogue_dhcp":        map[string]any{"enabled": false, "interval_seconds": 900, "listen_seconds": 4},
		"upnp":              map[string]any{"enabled": false, "interval_seconds": 3600},
		"wifi":              map[string]any{"enabled": false, "interval_seconds": 600},
		"banners":           map[string]any{"enabled": false, "interval_seconds": 1, "ports": []int{80, 443, 8080, 8443}, "targets": []string{}},
		"dhcp_fingerprints": map[string]any{"enabled": false, "interval_seconds": 300},
		"run_now":           []map[string]any{},
	}
	if edit != nil {
		edit(m)
	}
	return m
}

func (a *Agent) setSmartConfig(t *testing.T, smartChecks map[string]any) {
	t.Helper()
	raw, err := json.Marshal(smartChecks)
	if err != nil {
		t.Fatal(err)
	}
	rc := &cloud.RemoteConfig{SmartChecks: raw}
	rc.Discovery.Scopes = []cloud.Scope{{ID: smartScopeID, CIDR: "192.168.1.0/24"}}
	a.mu.Lock()
	a.remote = rc
	a.mu.Unlock()
}

// tick runs one scheduler pass at now and waits for the runs it started.
func (a *Agent) tick(now time.Time) {
	a.smartTick(context.Background(), now)
	a.smartRuns.wg.Wait()
}

// spooledItems takes every telemetry item written to the on-disk buffer, validating each.
func (a *Agent) spooledItems(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for {
		name, data, ok, err := a.spool.Oldest()
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
		var batch struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(data, &batch); err != nil {
			t.Fatal(err)
		}
		for _, raw := range batch.Items {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			validateSmartItem(t, m)
			out = append(out, m)
			if dir := os.Getenv("SMART_ITEMS_OUT"); dir != "" { // for checking against the server's zod schema
				_ = os.WriteFile(filepath.Join(dir, newUUID()+".json"), raw, 0o600)
			}
		}
		_ = a.spool.Remove(name)
	}
	return out
}

var (
	uuidRe       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	smartTopKeys = map[string]bool{"type": true, "ts": true, "run_id": true, "check": true, "trigger": true, "ok": true, "duration_ms": true,
		"error": true, "dhcp": true, "upnp": true, "wifi": true, "banners": true, "dhcp_fingerprints": true}
	blockKeys = map[string]map[string]bool{
		"dhcp":              {"interfaces": true},
		"upnp":              {"gateways": true},
		"wifi":              {"platform": true, "interface": true, "connected": true, "link": true, "networks": true, "truncated": true},
		"banners":           {"probed": true, "results": true},
		"dhcp_fingerprints": {"clients": true},
	}
)

// validateSmartItem checks the rules of smart-check-protocol.ts that matter for the collector:
// strict keys, the field types, and exactly the block that matches `check`.
func validateSmartItem(t *testing.T, m map[string]any) {
	t.Helper()
	for k := range m {
		if !smartTopKeys[k] {
			t.Errorf("unknown key %q in %v", k, m)
		}
	}
	if m["type"] != "smart_check" || !uuidRe.MatchString(m["run_id"].(string)) {
		t.Errorf("type/run_id: %v", m)
	}
	if _, err := time.Parse(time.RFC3339Nano, m["ts"].(string)); err != nil {
		t.Errorf("ts: %v", err)
	}
	check := m["check"].(string)
	if _, ok := blockKey[check]; !ok || (m["trigger"] != "scheduled" && m["trigger"] != "manual") {
		t.Errorf("check/trigger: %v", m)
	}
	ok := m["ok"].(bool)
	if d, isNum := m["duration_ms"].(float64); !isNum || d < 0 || d > maxSmartDurationMs || d != float64(int64(d)) {
		t.Errorf("duration_ms: %v", m["duration_ms"])
	}
	present := 0
	for _, key := range blockKey {
		if b, has := m[key]; has {
			present++
			if key != blockKey[check] {
				t.Errorf("block %q in a %s item", key, check)
			}
			for k := range b.(map[string]any) {
				if !blockKeys[key][k] {
					t.Errorf("unknown key %q in block %s", k, key)
				}
			}
		}
	}
	if ok && present != 1 {
		t.Errorf("a successful run carries exactly its own block: %v", m)
	}
	e, hasErr := m["error"].(map[string]any)
	if ok == hasErr {
		t.Errorf("error present iff ok is false: %v", m)
	}
	if hasErr && (!smartErrorKinds[e["kind"].(string)] || len(e["message"].(string)) > 400 || len(e) != 2) {
		t.Errorf("error: %v", e)
	}
}

func byCheck(items []map[string]any, check string) []map[string]any {
	var out []map[string]any
	for _, it := range items {
		if it["check"] == check {
			out = append(out, it)
		}
	}
	return out
}

func TestSmartChecksScheduleAndRunNow(t *testing.T) {
	f := defaultSmartFakes()
	a := smartAgent(t, f.deps())
	t0 := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	cfg := smartCfg(func(m map[string]any) {
		m["rogue_dhcp"] = map[string]any{"enabled": true, "interval_seconds": 3600, "listen_seconds": 2}
	})
	a.setSmartConfig(t, cfg)

	// One run at start, the next only after 3600 s.
	a.tick(t0)
	a.tick(t0.Add(time.Second))
	a.tick(t0.Add(3599 * time.Second))
	if d, u, w, b := f.counts(); d != 1 || u != 0 || w != 0 || b != 0 {
		t.Fatalf("calls dhcp=%d upnp=%d wifi=%d banners=%d", d, u, w, b)
	}
	a.tick(t0.Add(3600 * time.Second))
	if d, _, _, _ := f.counts(); d != 2 {
		t.Fatalf("second scheduled run: %d calls", d)
	}
	if f.listen != 2*time.Second {
		t.Errorf("listen_seconds not honoured: %v", f.listen)
	}
	items := a.spooledItems(t)
	if len(items) != 2 || items[0]["run_id"] == items[1]["run_id"] {
		t.Fatalf("two items with distinct run ids: %v", items)
	}
	it := items[0]
	ifs := it["dhcp"].(map[string]any)["interfaces"].([]any)
	if it["check"] != "rogue_dhcp" || it["trigger"] != "scheduled" || it["ok"] != true || len(ifs) != 1 {
		t.Fatalf("item %v", it)
	}
	if iface := ifs[0].(map[string]any); iface["name"] != "eth0" || iface["scope_id"] != smartScopeID || len(iface["offers"].([]any)) != 1 {
		t.Fatalf("only the authorized interface, with its scope: %v", iface)
	}

	// A run_now entry runs once with trigger "manual", even for a disabled check, and not again.
	t1 := t0.Add(4000 * time.Second)
	requested := t1.Add(-5 * time.Second).Format(time.RFC3339Nano)
	cfg["run_now"] = []map[string]any{{"check": "upnp", "requested_at": requested}}
	a.setSmartConfig(t, cfg)
	a.tick(t1)
	a.tick(t1.Add(time.Second))
	a.tick(t1.Add(2 * time.Second))
	if _, u, _, _ := f.counts(); u != 1 {
		t.Fatalf("run now: %d UPnP runs", u)
	}
	items = a.spooledItems(t)
	if len(items) != 1 || items[0]["check"] != "upnp" || items[0]["trigger"] != "manual" || items[0]["ok"] != true {
		t.Fatalf("items %v", items)
	}
	if gws := items[0]["upnp"].(map[string]any)["gateways"].([]any); len(gws) != 1 || gws[0].(map[string]any)["address"] != "192.168.1.2" {
		t.Fatalf("gateways %v", gws)
	}
	// A new request (a later requested_at) runs again.
	cfg["run_now"] = []map[string]any{{"check": "upnp", "requested_at": t1.Add(time.Minute).Format(time.RFC3339Nano)}}
	a.setSmartConfig(t, cfg)
	a.tick(t1.Add(2 * time.Minute))
	if _, u, _, _ := f.counts(); u != 2 {
		t.Fatalf("a new request: %d UPnP runs", u)
	}
	// A request older than the server's 15-minute window (a stale cache) and an unknown check are ignored.
	cfg["run_now"] = []map[string]any{{"check": "wifi", "requested_at": t1.Add(-time.Hour).Format(time.RFC3339Nano)}, {"check": "exec", "requested_at": requested}}
	a.setSmartConfig(t, cfg)
	a.tick(t1.Add(3 * time.Minute))

	// The disabled checks never ran by schedule.
	if _, _, w, b := f.counts(); w != 0 || b != 0 {
		t.Fatalf("disabled checks ran: wifi=%d banners=%d", w, b)
	}
	_ = a.spooledItems(t)
}

func TestSmartChecksErrorKinds(t *testing.T) {
	f := defaultSmartFakes()
	f.dhcpFail = true
	f.wifiErr = &smart.WiFiError{Kind: "not_supported", Message: "the Wi-Fi analyzer runs on Windows and Linux collectors"}
	a := smartAgent(t, f.deps())
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	a.setSmartConfig(t, smartCfg(func(m map[string]any) {
		m["rogue_dhcp"] = map[string]any{"enabled": true, "interval_seconds": 900, "listen_seconds": 4}
		m["wifi"] = map[string]any{"enabled": true, "interval_seconds": 600}
	}))
	a.tick(now)
	items := a.spooledItems(t)
	d := byCheck(items, "rogue_dhcp")
	if len(d) != 1 || d[0]["ok"] != false || d[0]["error"].(map[string]any)["kind"] != "listen_failed" || d[0]["dhcp"] == nil {
		t.Fatalf("UDP 68 busy: %v", d)
	}
	w := byCheck(items, "wifi")
	if len(w) != 1 || w[0]["ok"] != false || w[0]["error"].(map[string]any)["kind"] != "not_supported" || w[0]["wifi"] != nil {
		t.Fatalf("no Wi-Fi on this platform: %v", w)
	}

	// No interface inside the authorized scopes: no_interface, and nothing is sent.
	f.mu.Lock()
	f.ifaces = []smart.DHCPInterface{{Name: "vpn0", Address: netip.MustParseAddr("10.8.0.2"), MAC: net.HardwareAddr{2, 0, 0, 0, 0, 1}}}
	f.mu.Unlock()
	a.tick(now.Add(time.Hour))
	d = byCheck(a.spooledItems(t), "rogue_dhcp")
	if len(d) != 1 || d[0]["error"].(map[string]any)["kind"] != "no_interface" || f.dhcpCalls != 1 {
		t.Fatalf("outside every scope: %v (probe calls %d)", d, f.dhcpCalls)
	}

	// Any other error is internal; a panic in a check is reported, not fatal.
	f.wifiErr = errors.New("boom")
	a.tick(now.Add(2 * time.Hour))
	if w := byCheck(a.spooledItems(t), "wifi"); len(w) != 1 || w[0]["error"].(map[string]any)["kind"] != "internal" {
		t.Fatalf("plain error: %v", w)
	}
	a.deps.SmartWiFi = func(context.Context) (smart.WiFiReport, error) { panic("driver bug") }
	a.tick(now.Add(3 * time.Hour))
	if w := byCheck(a.spooledItems(t), "wifi"); len(w) != 1 || !strings.Contains(w[0]["error"].(map[string]any)["message"].(string), "driver bug") {
		t.Fatalf("panic: %v", w)
	}

	// A check disabled on this collector (nil Dep) answers "run now" with not_supported and never runs by schedule.
	a.deps.SmartUPnP = nil
	cfg := smartCfg(func(m map[string]any) { m["upnp"] = map[string]any{"enabled": true, "interval_seconds": 3600} })
	a.setSmartConfig(t, cfg)
	a.tick(now.Add(4 * time.Hour))
	if u := byCheck(a.spooledItems(t), "upnp"); len(u) != 0 {
		t.Fatalf("a nil Dep ran by schedule: %v", u)
	}
	cfg["run_now"] = []map[string]any{{"check": "upnp", "requested_at": now.Add(4 * time.Hour).Format(time.RFC3339Nano)}}
	a.setSmartConfig(t, cfg)
	a.tick(now.Add(4*time.Hour + time.Second))
	if u := byCheck(a.spooledItems(t), "upnp"); len(u) != 1 || u[0]["trigger"] != "manual" || u[0]["error"].(map[string]any)["kind"] != "not_supported" {
		t.Fatalf("run now on a nil Dep: %v", u)
	}
}

func TestSmartWiFiItemCarriesOnlyWhatTheProtocolAccepts(t *testing.T) {
	f := defaultSmartFakes()
	a := smartAgent(t, f.deps())
	a.setSmartConfig(t, smartCfg(func(m map[string]any) { m["wifi"] = map[string]any{"enabled": true, "interval_seconds": 600} }))
	a.tick(time.Now())
	w := byCheck(a.spooledItems(t), "wifi")
	if len(w) != 1 || w[0]["ok"] != true {
		t.Fatalf("%v", w)
	}
	block := w[0]["wifi"].(map[string]any)
	if nets := block["networks"].([]any); len(nets) != 1 || block["link"] == nil || block["platform"] != "linux" {
		t.Fatalf("block %v", block)
	}
}

func TestSmartBannersStayInScope(t *testing.T) {
	f := defaultSmartFakes()
	a := smartAgent(t, f.deps())
	t0 := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	cfg := smartCfg(func(m map[string]any) {
		m["banners"] = map[string]any{"enabled": true, "interval_seconds": 1, "ports": []int{80, 443, 0, 99999, 80},
			"targets": []string{"192.168.1.20", "10.0.0.5", "192.168.1.20", "fe80::1", "not-an-ip", "192.168.1.21"}}
	})
	a.setSmartConfig(t, cfg)
	a.tick(t0)
	if len(f.bannerCalls) != 1 || len(f.bannerCalls[0]) != 2 || f.bannerCalls[0][0].String() != "192.168.1.20" || f.bannerCalls[0][1].String() != "192.168.1.21" {
		t.Fatalf("targets %v", f.bannerCalls)
	}
	if p := f.bannerPorts[0]; len(p) != 2 || p[0] != 80 || p[1] != 443 {
		t.Fatalf("ports %v", p)
	}
	items := byCheck(a.spooledItems(t), "banners")
	b := items[0]["banners"].(map[string]any)
	if probed := b["probed"].([]any); len(probed) != 2 || len(b["results"].([]any)) != 2 {
		t.Fatalf("only authorized addresses are reported: %v", b)
	}
	// The server still lists them as due (it has not received the result yet): the schedule waits.
	a.tick(t0.Add(2 * time.Minute))
	if len(f.bannerCalls) != 1 {
		t.Fatalf("re-probed by schedule: %v", f.bannerCalls)
	}
	// "Run now" probes them again.
	cfg["run_now"] = []map[string]any{{"check": "banners", "requested_at": t0.Add(3 * time.Minute).Format(time.RFC3339Nano)}}
	a.setSmartConfig(t, cfg)
	a.tick(t0.Add(3*time.Minute + time.Second))
	if len(f.bannerCalls) != 2 {
		t.Fatalf("run now: %d calls", len(f.bannerCalls))
	}
	// A scheduled pass with nothing due sends nothing.
	cfg["run_now"] = []map[string]any{}
	cfg["banners"].(map[string]any)["targets"] = []string{}
	a.setSmartConfig(t, cfg)
	_ = a.spooledItems(t)
	a.tick(t0.Add(time.Hour))
	if items := a.spooledItems(t); len(items) != 0 || len(f.bannerCalls) != 2 {
		t.Fatalf("nothing due: %v", items)
	}
}

func TestSmartFingerprintsFromPassiveListener(t *testing.T) {
	f := defaultSmartFakes()
	deps := f.deps()
	deps.DHCPListen = ":67" // not opened in this test: the listener state is set below
	a := smartAgent(t, deps)
	t0 := time.Now()
	cfg := smartCfg(func(m map[string]any) {
		m["dhcp_fingerprints"] = map[string]any{"enabled": true, "interval_seconds": 300}
	})
	a.setSmartConfig(t, cfg)

	a.dhcpListening, a.dhcpListenErr = false, "listen udp4 :67: bind: address already in use"
	a.tick(t0)
	fp := byCheck(a.spooledItems(t), "dhcp_fingerprints")
	if len(fp) != 1 || fp[0]["ok"] != false || fp[0]["error"].(map[string]any)["kind"] != "listen_failed" {
		t.Fatalf("listener down: %v", fp)
	}

	a.dhcpListening = true
	m := dhcp.ClientMessage{PRL: "1,3,6,15,119,252", ServerID: "192.168.1.2", Type: 3}
	m.MAC, m.Hostname, m.VendorClass = "aa:bb:cc:00:00:01", "Galaxy-A52", "android-dhcp-14"
	a.observeDHCP(m)
	a.observeDHCP(m)
	a.tick(t0.Add(5 * time.Minute))
	fp = byCheck(a.spooledItems(t), "dhcp_fingerprints")
	if len(fp) != 1 || fp[0]["ok"] != true {
		t.Fatalf("%v", fp)
	}
	clients := fp[0]["dhcp_fingerprints"].(map[string]any)["clients"].([]any)
	if len(clients) != 1 || clients[0].(map[string]any)["prl"] != "1,3,6,15,119,252" || clients[0].(map[string]any)["server_id"] != "192.168.1.2" {
		t.Fatalf("clients %v", clients)
	}

	// Turned off: what is overheard is discarded, nothing is reported.
	cfg["dhcp_fingerprints"] = map[string]any{"enabled": false, "interval_seconds": 300}
	a.setSmartConfig(t, cfg)
	a.observeDHCP(m)
	a.tick(t0.Add(20 * time.Minute))
	if a.fingerprints.Len() != 0 || len(a.spooledItems(t)) != 0 {
		t.Fatal("fingerprints kept or reported while the check is off")
	}
}

func TestSmartChecksNotCachedWhenAbsent(t *testing.T) {
	now := time.Now()
	fc := &fakeCloud{batches: map[string]map[string]any{}, scopes: []map[string]string{{"id": smartScopeID, "cidr": "192.168.1.0/24"}},
		smart: smartCfg(func(m map[string]any) {
			m["rogue_dhcp"] = map[string]any{"enabled": true, "interval_seconds": 900, "listen_seconds": 1}
			m["run_now"] = []map[string]any{{"check": "upnp", "requested_at": now.UTC().Format(time.RFC3339Nano)}}
		})}
	srv := httptest.NewServer(fc.handler())
	defer srv.Close()
	stateDir := t.TempDir()
	a := newTestAgent(t, srv.URL, stateDir, goodToken, &recordingProber{})
	f := defaultSmartFakes()
	sd := f.deps()
	a.deps.SmartInterfaces, a.deps.SmartDHCP, a.deps.SmartUPnP = sd.SmartInterfaces, sd.SmartDHCP, sd.SmartUPnP
	ctx := context.Background()
	if err := a.ensureEnrolled(ctx); err != nil {
		t.Fatal(err)
	}
	bo := cloud.Backoff{Min: time.Millisecond, Max: time.Millisecond}
	connected := true
	a.heartbeatOnce(ctx, &bo, &connected)

	cached, err := os.ReadFile(filepath.Join(stateDir, "remote-config.json"))
	if err != nil || !strings.Contains(string(cached), `"smart_checks"`) || strings.Contains(string(cached), "run_now") {
		t.Fatalf("the schedule is cached without its run-now requests: %s (%v)", cached, err)
	}
	a.tick(now)
	if d, u, _, _ := f.counts(); d != 1 || u != 1 {
		t.Fatalf("runs dhcp=%d upnp=%d", d, u)
	}

	// The next heartbeat carries no smart_checks: every scheduled check stops, and the cache forgets them.
	fc.mu.Lock()
	fc.smart = nil
	fc.mu.Unlock()
	a.heartbeatOnce(ctx, &bo, &connected)
	a.tick(now.Add(24 * time.Hour))
	if d, u, _, _ := f.counts(); d != 1 || u != 1 {
		t.Fatalf("checks ran without smart_checks: dhcp=%d upnp=%d", d, u)
	}
	cached, _ = os.ReadFile(filepath.Join(stateDir, "remote-config.json"))
	if strings.Contains(string(cached), "smart_checks") {
		t.Fatalf("stale smart_checks cached: %s", cached)
	}
	// A restart from that cache runs nothing either.
	b := newTestAgent(t, srv.URL, stateDir, goodToken, &recordingProber{})
	b.deps.SmartInterfaces, b.deps.SmartDHCP = sd.SmartInterfaces, sd.SmartDHCP
	b.loadCachedConfig()
	b.tick(now.Add(48 * time.Hour))
	if d, _, _, _ := f.counts(); d != 1 {
		t.Fatalf("ran from a cache without smart_checks: %d", d)
	}
	for _, it := range a.spooledItems(t) {
		if it["check"] == "upnp" && it["trigger"] != "manual" {
			t.Errorf("run now reported as %v", it["trigger"])
		}
	}
}
