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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/config"
	"github.com/nigafiy/sensor/internal/netinfo"
	"github.com/nigafiy/sensor/internal/snmp"
	"github.com/nigafiy/sensor/internal/snmp/sim"
)

const (
	swWriteCommunity = "agent-w-community-55"
	swTargetID       = "22222222-2222-4222-8222-222222222222"
)

// switchAgent: an agent with one switch (the sim on loopback) and its write credentials in the
// delivered configuration; loopback is an authorized scope. The collector host's own MAC is learned
// on port 2 of the switch.
func switchAgent(t *testing.T, scope string, withWrite bool) (*Agent, *sim.Agent) {
	t.Helper()
	sw := sim.Switch("agent-ro", "sw-agent", 8, []sim.Device{
		{MAC: "00:0c:29:cc:00:01", Port: 1, VLAN: 10},
		{MAC: "02:00:00:00:00:aa", Port: 2, VLAN: 10}, // this collector host
	}, "core")
	sw.QBridge(8, []sim.VLAN{{ID: 1, Name: "default", Ports: []int{3, 4, 5, 6, 7}}, {ID: 10, Name: "Office", Ports: []int{1, 2}}, {ID: 99, Name: "Quarantine"}}, 8)
	sw.WriteCommunity = swWriteCommunity
	addr, err := sw.Start("127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind loopback UDP:", err)
	}
	t.Cleanup(sw.Stop)
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)

	cfg := &config.Config{ServerURL: "http://127.0.0.1:1", StateDir: t.TempDir(), AllowInsecureHTTP: true, AllowLoopbackScopes: true,
		Limits: config.Limits{MaxConcurrency: 8, MaxPPS: 500, PingTimeoutMs: 500}, SpoolMaxBatches: 100, LogLevel: "error"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		SNMPPoll:  snmp.Poll,
		LocalMACs: func() map[string]string { return map[string]string{"127.0.0.1": "02:00:00:00:00:AA"} },
		Gateway:   func(context.Context) string { return "" },
		Neighbors: func(context.Context) (map[string]netinfo.Neighbor, error) { return nil, nil },
	}
	a, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", testTuning())
	if err != nil {
		t.Fatal(err)
	}
	tg := snmp.Target{ID: swTargetID, Host: host, Port: port, Version: "2c", Community: "agent-ro", IntervalSeconds: 300}
	if withWrite {
		tg.Write = &snmp.Credentials{Version: "2c", Community: swWriteCommunity}
	}
	raw, _ := json.Marshal(snmpConfig{Targets: []snmp.Target{tg}})
	rc := &cloud.RemoteConfig{SNMP: raw}
	rc.Discovery.Scopes = []cloud.Scope{{ID: "s", CIDR: scope}}
	a.mu.Lock()
	a.remote = rc
	a.mu.Unlock()
	return a, sw
}

func (a *Agent) switchItems(t *testing.T) []map[string]any {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []map[string]any
	for _, raw := range a.queue {
		if strings.Contains(string(raw), swWriteCommunity) {
			t.Fatalf("a telemetry item carries the write community: %s", raw)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		out = append(out, m)
	}
	a.queue = nil
	return out
}

func portCmd(id string, fields map[string]any) cloud.Command {
	p := map[string]any{"request_id": id, "target_id": swTargetID, "expires_at": time.Now().Add(5 * time.Minute).UTC()}
	for k, v := range fields {
		p[k] = v
	}
	raw, _ := json.Marshal(p)
	return cloud.Command{ID: "cmd-" + id, Kind: cmdSetSwitchPort, Payload: raw}
}

func TestSetSwitchPortVerifiesAndRunsAtMostOnce(t *testing.T) {
	a, sw := switchAgent(t, "127.0.0.0/24", true)
	ctx := context.Background()
	id := "aaaaaaaa-0000-4000-8000-000000000001"
	cmd := portCmd(id, map[string]any{"if_index": 101, "op": "access_vlan", "vlan": 99, "method": "qbridge"})
	a.setSwitchPort(ctx, cmd)
	items := a.switchItems(t)
	if len(items) != 1 || items[0]["type"] != "switch_port_result" || items[0]["ok"] != true || items[0]["verified"] != true || items[0]["request_id"] != id {
		t.Fatalf("result: %+v", items)
	}
	if items[0]["before"].(map[string]any)["vlan"] != float64(10) || items[0]["after"].(map[string]any)["vlan"] != float64(99) {
		t.Fatalf("before/after: %+v", items[0])
	}
	writes := len(sw.Sets())
	// The cloud re-sends the command (not yet acknowledged) — even after a restart: never run twice.
	a.setSwitchPort(ctx, cmd)
	b, _ := New(a.cfg, a.deps, a.log, "test", testTuning())
	b.remote = a.remote
	b.setSwitchPort(ctx, cmd)
	if got := a.switchItems(t); len(got) != 0 {
		t.Fatalf("a second execution reported: %+v", got)
	}
	if len(sw.Sets()) != writes {
		t.Fatal("the switch was written again")
	}
}

func TestSetSwitchPortRevalidates(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name  string
		scope string
		write bool
		cmd   cloud.Command
		kind  string
	}{
		{"expired", "127.0.0.0/24", true, func() cloud.Command {
			raw, _ := json.Marshal(map[string]any{"request_id": "aaaaaaaa-0000-4000-8000-000000000010", "target_id": swTargetID, "if_index": 103, "op": "admin_status", "admin_up": false,
				"expires_at": time.Now().Add(-time.Minute).UTC()})
			return cloud.Command{ID: "c", Kind: cmdSetSwitchPort, Payload: raw}
		}(), "expired"},
		{"outside scope", "10.99.0.0/24", true, portCmd("aaaaaaaa-0000-4000-8000-000000000011", map[string]any{"if_index": 103, "op": "admin_status", "admin_up": false}), "out_of_scope"},
		{"no write credentials", "127.0.0.0/24", false, portCmd("aaaaaaaa-0000-4000-8000-000000000012", map[string]any{"if_index": 103, "op": "admin_status", "admin_up": false}), "not_configured"},
		{"unknown op", "127.0.0.0/24", true, portCmd("aaaaaaaa-0000-4000-8000-000000000013", map[string]any{"if_index": 103, "op": "set_oid", "oid": "1.3.6.1.2.1.1.5.0"}), "invalid_request"},
		{"self port", "127.0.0.0/24", true, portCmd("aaaaaaaa-0000-4000-8000-000000000014", map[string]any{"if_index": 102, "op": "admin_status", "admin_up": false}), "self_port"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, sw := switchAgent(t, c.scope, c.write)
			a.setSwitchPort(ctx, c.cmd)
			items := a.switchItems(t)
			if len(items) != 1 || items[0]["ok"] != false || items[0]["verified"] != false {
				t.Fatalf("%+v", items)
			}
			if k := items[0]["error"].(map[string]any)["kind"]; k != c.kind {
				t.Fatalf("kind %v, want %s", k, c.kind)
			}
			if len(sw.Sets()) != 0 {
				t.Fatalf("the switch was written: %v", sw.Sets())
			}
		})
	}
	// With an override reason the self-port guard lets an administrator proceed.
	a, _ := switchAgent(t, "127.0.0.0/24", true)
	a.setSwitchPort(ctx, portCmd("aaaaaaaa-0000-4000-8000-000000000015", map[string]any{"if_index": 102, "op": "admin_status", "admin_up": false, "override": true}))
	if items := a.switchItems(t); len(items) != 1 || items[0]["verified"] != true {
		t.Fatalf("override: %+v", items)
	}
}

func TestVLANItemFromPoll(t *testing.T) {
	a, _ := switchAgent(t, "127.0.0.0/24", false)
	tg, _ := a.switchTarget(swTargetID)
	a.pollSNMP(context.Background(), tg)
	items := a.switchItems(t)
	if len(items) != 2 || items[0]["type"] != "snmp_poll" || items[1]["type"] != "switch_vlans" {
		t.Fatalf("%+v", items)
	}
	v := items[1]
	if len(v["vlans"].([]any)) != 3 || len(v["ports"].([]any)) != 8 || v["methods"].([]any)[0] != "qbridge" {
		t.Fatalf("vlan item: %+v", v)
	}
}

// TestSetSwitchPortDeliveredByHeartbeat: the API's heartbeat answer (configuration with the
// switch's write credentials + a `set_switch_port` command, in the exact shape the API sends) is
// dispatched to setSwitchPort, the change is verified on the switch, the command is acknowledged,
// and the write credentials never reach the on-disk configuration cache.
func TestSetSwitchPortDeliveredByHeartbeat(t *testing.T) {
	a, sw := switchAgent(t, "127.0.0.0/24", true)
	a.mu.Lock()
	snmpRaw := a.remote.SNMP
	a.mu.Unlock()
	reqID := "bbbbbbbb-0000-4000-8000-000000000001"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/collector/heartbeat" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"server_time": time.Now().UTC(),
			"config": map[string]any{
				"heartbeat_interval_seconds": 30,
				"discovery":                  map[string]any{"interval_seconds": 300, "scopes": []map[string]any{{"id": "s", "cidr": "127.0.0.0/24"}}},
				"checks":                     []any{},
				"snmp":                       json.RawMessage(snmpRaw),
			},
			"commands": []map[string]any{{
				"id": "cmd-hb-1", "kind": "set_switch_port",
				"payload": map[string]any{"request_id": reqID, "target_id": swTargetID, "if_index": 101, "op": "access_vlan", "vlan": 99,
					"expires_at": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), "override": false, "method": "qbridge"},
			}},
		})
	}))
	t.Cleanup(srv.Close)
	client, err := cloud.New(srv.URL, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	client.SetCredential("ldc_test.secret")
	a.client = client
	bo := cloud.Backoff{Min: time.Second, Max: time.Minute}
	connected := true
	a.heartbeatOnce(context.Background(), &bo, &connected)
	a.cmdWG.Wait()

	items := a.switchItems(t)
	if len(items) != 1 || items[0]["request_id"] != reqID || items[0]["verified"] != true || items[0]["method"] != "qbridge" {
		t.Fatalf("result: %+v", items)
	}
	if len(sw.Sets()) == 0 {
		t.Fatal("the switch was not written")
	}
	a.mu.Lock()
	acked := append([]string{}, a.completed...)
	a.mu.Unlock()
	if len(acked) != 1 || acked[0] != "cmd-hb-1" {
		t.Fatalf("command not acknowledged: %v", acked)
	}
	cached, _ := os.ReadFile(a.configPath())
	if strings.Contains(string(cached), swWriteCommunity) {
		t.Fatal("the write credentials were written to the configuration cache")
	}
}
