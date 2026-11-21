package unifi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
)

func TestExtendedControls(t *testing.T) {
	wlanEnabled := true
	users := []map[string]any{
		{"_id": "u1", "mac": "aa:bb:cc:00:00:10", "name": "Server", "use_fixedip": true, "fixed_ip": "192.168.1.10"},
	}
	pfs := []map[string]any{}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(data any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": data})
		}
		switch {
		case r.URL.Path == "/api/auth/login":
			w.Header().Set("X-Csrf-Token", "csrf1")
			http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: "tok1"})
			_ = json.NewEncoder(w).Encode(map[string]any{"unique_id": "1"})
		case r.URL.Path == "/proxy/network/api/self/sites":
			ok([]map[string]any{{"name": "default"}})
		case r.URL.Path == "/proxy/network/api/s/default/stat/device":
			ok([]map[string]any{{"type": "udm", "mac": "00:11:22:33:44:55", "ip": "192.168.1.1", "uptime": 7200, "wan1": map[string]any{"up": true, "ip": "41.1.2.3", "dns": []string{"1.1.1.1"}}}})
		case r.URL.Path == "/proxy/network/api/s/default/stat/sta":
			ok([]map[string]any{{"mac": "aa:bb:cc:00:00:10", "essid": "CorpWiFi"}})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/wlanconf":
			ok([]map[string]any{{"_id": "w1", "name": "CorpWiFi", "enabled": wlanEnabled, "wlan_band": "5g", "x_passphrase": "UNIFI-SECRET-KEY"}})
		case r.Method == http.MethodPut && r.URL.Path == "/proxy/network/api/s/default/rest/wlanconf/w1":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			wlanEnabled = boolOf(b["enabled"])
			ok([]map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/user":
			ok(users)
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/rest/user":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["_id"] = "u2"
			users = append(users, b)
			ok([]map[string]any{b})
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/user/"):
			id := strings.TrimPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/user/")
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			for _, u := range users {
				if str(u["_id"]) == id {
					for k, v := range b {
						u[k] = v
					}
				}
			}
			ok([]map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/portforward":
			ok(pfs)
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/rest/portforward":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["_id"] = "pf1"
			pfs = append(pfs, b)
			ok([]map[string]any{b})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/portforward/"):
			pfs = nil
			ok([]map[string]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/cmd/devmgr":
			rebooted = true
			ok([]map[string]any{})
		default:
			ok([]map[string]any{})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "uf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "admin", []byte("pw"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.WiFi) != 1 || len(s.WiFi[0].ClientMACs) != 1 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: %+v", s)
	}
	if raw, _ := json.Marshal(s); strings.Contains(string(raw), "UNIFI-SECRET-KEY") {
		t.Fatal("Wi-Fi passphrase leaked into Settings")
	}
	if _, err := d.SetWiFiEnabled(ctx, "w1", false); err != nil || wlanEnabled {
		t.Fatalf("SetWiFiEnabled failed: %v", err)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.1.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "CoreDB"); err != nil {
		t.Fatalf("RenameClient failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "WireGuard", Protocol: "udp", ExternalStart: 51820, InternalIP: "192.168.1.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 {
		t.Fatalf("expected 1 pf, got %d", len(s2.PortForwards))
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if _, err := d.Reboot(ctx); err != nil || !rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, rebooted)
	}
}
