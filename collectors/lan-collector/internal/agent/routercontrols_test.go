package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/nigafiy/sensor/internal/router"
	"github.com/nigafiy/sensor/internal/router/zyxel/zyxeltest"
)

// Router controls beyond blocking (docs/features/router-controls.md), end to end through the
// agent's command handling against the Zyxel test double.

func routerControlsFixture() zyxeltest.Config {
	cfg := routerFixture()
	cfg.Hosts[0].Layer1 = "Device.WiFi.SSID.5" // laptop-1 on the 5 GHz main network
	cfg.Hosts[1].Layer1 = "Device.WiFi.SSID.1" // android-x on the 2.4 GHz main network
	cfg.LANIP, cfg.LANMask = "192.168.1.1", "255.255.255.0"
	cfg.Status = map[string]any{
		"DeviceInfo": map[string]any{"UpTime": float64(86400)},
		"WanLanInfo": []any{map[string]any{"Name": "ETHWAN", "Enable": true, "Status": "Up", "LinkType": "ETH",
			"IPv4Address": []any{map[string]any{"IPAddress": "41.0.0.10"}}}},
	}
	cfg.WLAN = []map[string]any{
		{"SSID": "Home", "band": "2.4GHz", "MainSSID": true, "wlEnable": true, "SecurityMode": "WPA2-Personal", "psk_value": "never-leaks-1"},
		{"SSID": "Home_guest1", "band": "2.4GHz", "MainSSID": false, "wlEnable": false, "SecurityMode": "WPA2-Personal"},
		{"SSID": "", "band": "2.4GHz", "MainSSID": false, "wlEnable": false},
		{"SSID": "", "band": "2.4GHz", "MainSSID": false, "wlEnable": false},
		{"SSID": "Home5", "band": "5GHz", "MainSSID": true, "wlEnable": true, "SecurityMode": "WPA2-Personal"},
	}
	cfg.StaticDHCP = []map[string]any{}
	cfg.NAT = []map[string]any{{"Index": float64(1), "Enable": true, "Protocol": "TCP", "Description": "admin web cam", "ExternalPortStart": float64(8080),
		"ExternalPortEnd": float64(8080), "InternalPortStart": float64(80), "InternalPortEnd": float64(80), "InternalClient": "192.168.1.22"}}
	return cfg
}

func one(t *testing.T, a *Agent, what string) map[string]any {
	t.Helper()
	items := a.takeItems(t)
	if len(items) != 1 {
		t.Fatalf("%s: want one result, got %+v", what, items)
	}
	raw, _ := json.Marshal(items[0])
	for _, secret := range []string{"never-leaks-1", "psk_value"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("%s: result carries a Wi-Fi secret: %s", what, raw)
		}
	}
	return items[0]
}

func okResult(t *testing.T, a *Agent, what, action string) map[string]any {
	t.Helper()
	r := one(t, a, what)
	if r["ok"] != true || r["action"] != action {
		t.Fatalf("%s: %+v", what, r)
	}
	return r
}

func TestRouterControlsAgainstDouble(t *testing.T) {
	srv := zyxeltest.Start(routerControlsFixture())
	defer srv.Close()
	a, tg := routerAgent(t, srv, "127.0.0.0/24", routerTestPassword)
	ctx := context.Background()
	run := func(kind string, p map[string]any) {
		p["router_id"] = tg.ID
		if _, ok := p["request_id"]; !ok {
			p["request_id"] = "req-" + kind
		}
		a.routerCommand(ctx, command(kind, p))
	}

	// Refresh carries the settings, in the wire shape the API accepts.
	run(cmdRouterRefresh, map[string]any{})
	r := okResult(t, a, "refresh", "refresh")
	s, _ := r["settings"].(map[string]any)
	if s == nil {
		t.Fatalf("refresh without settings: %+v", r)
	}
	ov := s["overview"].(map[string]any)
	if ov["lan_ip"] != "192.168.1.1" || ov["uptime_seconds"] != float64(86400) || len(ov["wan"].([]any)) != 1 {
		t.Errorf("overview: %+v", ov)
	}
	wifi := s["wifi"].([]any)
	if len(wifi) != 3 {
		t.Fatalf("wifi: want the 3 named networks, got %+v", wifi)
	}
	if w := wifi[0].(map[string]any); w["id"] != "1" || w["main"] != true || w["band"] != "2.4GHz" || len(w["client_macs"].([]any)) != 1 {
		t.Errorf("main 2.4: %+v", w)
	}
	pf := s["port_forwards"].([]any)
	if len(pf) != 1 || pf[0].(map[string]any)["owner"] != "administrator" || pf[0].(map[string]any)["protocol"] != "tcp" {
		t.Errorf("port forwards: %+v", pf)
	}
	if res, ok := s["reservations"].([]any); !ok || len(res) != 0 {
		t.Errorf("reservations: want an empty list (read, none), got %+v", s["reservations"])
	}

	// Rename.
	run(cmdRouterRename, map[string]any{"mac": "aa:bb:cc:00:00:01", "name": "Study laptop"})
	r = okResult(t, a, "rename", "rename")
	if ch := r["change"].(map[string]any); ch["applied"] != true || ch["mac"] != "aa:bb:cc:00:00:01" || r["settings"] == nil {
		t.Errorf("rename result: %+v", r)
	}
	if h := srv.Host("AA:BB:CC:00:00:01"); h.DeviceName != "Study laptop" && h.CurName != "Study laptop" {
		t.Errorf("rename not applied on the router: %+v", h)
	}

	// Wi-Fi: guest network on, then off; the result reports the router's new state.
	run(cmdRouterWiFi, map[string]any{"wifi_id": "2", "enabled": true})
	r = okResult(t, a, "wifi on", "wifi")
	if srv.WLAN()[1]["wlEnable"] != true || r["change"].(map[string]any)["mac"] != "" {
		t.Errorf("guest on: %+v %+v", srv.WLAN()[1], r)
	}
	if w := r["settings"].(map[string]any)["wifi"].([]any)[1].(map[string]any); w["id"] != "2" || w["enabled"] != true {
		t.Errorf("re-read after Wi-Fi change: %+v", w)
	}
	run(cmdRouterWiFi, map[string]any{"wifi_id": "2", "enabled": false})
	okResult(t, a, "wifi off", "wifi")
	if srv.WLAN()[1]["wlEnable"] != false {
		t.Errorf("guest off: %+v", srv.WLAN()[1])
	}
	// Missing state: refused before the router is touched.
	run(cmdRouterWiFi, map[string]any{"wifi_id": "2"})
	if r = one(t, a, "wifi no state"); r["ok"] != false || r["error"].(map[string]any)["kind"] != "invalid_argument" {
		t.Errorf("wifi without enabled: %+v", r)
	}

	// Reservation, then removal (clear: true -> unreserve).
	run(cmdRouterReservation, map[string]any{"mac": "aa:bb:cc:00:00:01", "ip": "192.168.1.50"})
	r = okResult(t, a, "reserve", "reserve")
	res := r["settings"].(map[string]any)["reservations"].([]any)
	if len(res) != 1 || res[0].(map[string]any)["ip"] != "192.168.1.50" || res[0].(map[string]any)["mac"] != "aa:bb:cc:00:00:01" {
		t.Errorf("reservation re-read: %+v", res)
	}
	run(cmdRouterReservation, map[string]any{"mac": "aa:bb:cc:00:00:01", "clear": true})
	okResult(t, a, "unreserve", "unreserve")
	if len(srv.StaticDHCP()) != 0 {
		t.Errorf("reservation still on the router: %+v", srv.StaticDHCP())
	}

	// Port forward: add (gets the product prefix), then remove by the rule as listed.
	run(cmdRouterPortForward, map[string]any{"port_forward": map[string]any{"description": "game server", "protocol": "tcp",
		"external_start": 45678, "external_end": 45678, "internal_start": 45678, "internal_end": 45678, "internal_ip": "192.168.1.20"}})
	r = okResult(t, a, "add port forward", "add_port_forward")
	var added map[string]any
	for _, x := range r["settings"].(map[string]any)["port_forwards"].([]any) {
		if m := x.(map[string]any); m["external_start"] == float64(45678) {
			added = m
		}
	}
	if added == nil || added["owner"] != "lan-detective" || added["description"] != "LAN Detective: game server" {
		t.Fatalf("added rule: %+v", r["settings"])
	}
	// A rule on the router's own web port is refused by the collector too.
	run(cmdRouterPortForward, map[string]any{"port_forward": map[string]any{"description": "x", "protocol": "tcp",
		"external_start": 443, "external_end": 443, "internal_start": 443, "internal_end": 443, "internal_ip": "192.168.1.20"}})
	if r = one(t, a, "mgmt port"); r["ok"] != false {
		t.Errorf("management port forwarded: %+v", r)
	}
	// Removal of a rule that changed on the router is refused.
	stale := map[string]any{}
	for k, v := range added {
		stale[k] = v
	}
	stale["internal_ip"] = "192.168.1.99"
	run(cmdRouterPortForward, map[string]any{"clear": true, "port_forward": stale})
	if r = one(t, a, "stale removal"); r["ok"] != false || r["action"] != "remove_port_forward" {
		t.Errorf("stale removal: %+v", r)
	}
	run(cmdRouterPortForward, map[string]any{"clear": true, "port_forward": added})
	okResult(t, a, "remove port forward", "remove_port_forward")
	if len(srv.NAT()) != 1 {
		t.Errorf("rule still on the router: %+v", srv.NAT())
	}

	// Reboot: accepted, no settings re-read (the router is going away).
	run(cmdRouterReboot, map[string]any{})
	r = okResult(t, a, "reboot", "reboot")
	if srv.Reboots != 1 || r["settings"] != nil {
		t.Errorf("reboot: reboots=%d %+v", srv.Reboots, r)
	}
	if srv.ActiveSessions() != 0 {
		t.Fatalf("every operation must log out; %d session(s) left", srv.ActiveSessions())
	}
}

// The collector refuses to turn off the Wi-Fi network its own computer is on.
func TestRouterWiFiOffRefusedForCollectorHost(t *testing.T) {
	srv := zyxeltest.Start(routerControlsFixture())
	defer srv.Close()
	a, tg := routerAgent(t, srv, "127.0.0.0/24", routerTestPassword)
	a.deps.LocalMACs = func() map[string]string { return map[string]string{"192.168.1.20": "AA-BB-CC-00-00-01"} }
	a.routerCommand(context.Background(), command(cmdRouterWiFi, map[string]any{"request_id": "r", "router_id": tg.ID, "wifi_id": "5", "enabled": false}))
	r := one(t, a, "own wifi off")
	if r["ok"] != false || !strings.Contains(r["error"].(map[string]any)["message"].(string), "cut LAN Detective off") {
		t.Fatalf("own Wi-Fi off: %+v", r)
	}
	if srv.WLAN()[4]["wlEnable"] != true {
		t.Fatalf("the collector's own network was turned off")
	}
}

// Bad ports, missing ids and an unnamed WAN must not make the whole result invalid for the API.
func TestWireSettingsDropsEntriesTheAPIWouldRefuse(t *testing.T) {
	w := wireSettings(router.Settings{
		Overview:     &router.Overview{WAN: []router.WANLink{{Name: " ", Status: "Up"}}},
		WiFi:         []router.WiFiNetwork{{ID: "", SSID: "x"}},
		Reservations: []router.Reservation{{ID: "", MAC: "aa:bb:cc:00:00:01", IP: "192.168.1.5"}},
		PortForwards: []router.PortForward{
			{ID: "ok", Protocol: "tcp", ExternalStart: 1000, ExternalEnd: 1000, InternalStart: 1000, InternalEnd: 1000, InternalIP: "192.168.1.5"},
			{ID: "zero", Protocol: "tcp", InternalIP: "192.168.1.5"},
			{ID: "", Protocol: "tcp", ExternalStart: 1, ExternalEnd: 1, InternalStart: 1, InternalEnd: 1, InternalIP: "192.168.1.5"},
		},
	})
	if pf := w["port_forwards"].([]map[string]any); len(pf) != 1 || pf[0]["id"] != "ok" {
		t.Errorf("port forwards: %+v", pf)
	}
	if res := w["reservations"].([]map[string]any); len(res) != 0 {
		t.Errorf("reservation without id kept: %+v", res)
	}
	if wifi := w["wifi"].([]map[string]any); len(wifi) != 0 {
		t.Errorf("wifi without id kept: %+v", wifi)
	}
	wan := w["overview"].(map[string]any)["wan"].([]map[string]any)
	if wan[0]["name"] != "WAN" || wan[0]["status"] != "unknown" {
		t.Errorf("unnamed WAN: %+v", wan)
	}
}
