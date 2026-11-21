package mikrotik

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
	wifiDisabled := "false"
	leases := []map[string]any{
		{".id": "*L1", "mac-address": "AA:BB:CC:00:00:10", "address": "192.168.88.10", "dynamic": "false", "disabled": "false", "comment": "Nas"},
	}
	nats := []map[string]any{
		{".id": "*N1", "chain": "dstnat", "action": "dst-nat", "protocol": "tcp", "dst-port": "8080", "to-addresses": "192.168.88.10", "to-ports": "80", "comment": "admin web", "disabled": "false"},
	}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/rest/system/resource":
			_ = json.NewEncoder(w).Encode(map[string]any{"board-name": "hEX", "version": "7.15", "uptime": "1d2h3m4s"})
		case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/address":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"address": "192.168.88.1/24", "interface": "bridge"},
				{"address": "41.10.20.30/24", "interface": "ether1"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/dns":
			_ = json.NewEncoder(w).Encode(map[string]any{"servers": "1.1.1.1,8.8.8.8"})
		case r.Method == http.MethodGet && r.URL.Path == "/rest/interface/wifi":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{".id": "*W1", "name": "wifi1", "configuration.ssid": "Office5G", "disabled": wifiDisabled, "channel.band": "5ghz-ax", "configuration.security.passphrase": "TOP-SECRET-KEY"},
			})
		case r.Method == http.MethodPatch && r.URL.Path == "/rest/interface/wifi/*W1":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			wifiDisabled = strVal(body["disabled"])
			_ = json.NewEncoder(w).Encode(map[string]any{".id": "*W1", "disabled": wifiDisabled})
		case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/dhcp-server/lease":
			_ = json.NewEncoder(w).Encode(leases)
		case r.Method == http.MethodPut && r.URL.Path == "/rest/ip/dhcp-server/lease":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			body[".id"] = "*L2"
			body["dynamic"] = "false"
			leases = append(leases, body)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(body)
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/rest/ip/dhcp-server/lease/"):
			id := strings.TrimPrefix(r.URL.Path, "/rest/ip/dhcp-server/lease/")
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			for _, l := range leases {
				if strVal(l[".id"]) == id {
					for k, v := range body {
						l[k] = v
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{".id": id})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/rest/ip/dhcp-server/lease/"):
			id := strings.TrimPrefix(r.URL.Path, "/rest/ip/dhcp-server/lease/")
			var next []map[string]any
			for _, l := range leases {
				if strVal(l[".id"]) != id {
					next = append(next, l)
				}
			}
			leases = next
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/firewall/nat":
			_ = json.NewEncoder(w).Encode(nats)
		case r.Method == http.MethodPut && r.URL.Path == "/rest/ip/firewall/nat":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			body[".id"] = "*N2"
			nats = append(nats, body)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(body)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/rest/ip/firewall/nat/"):
			id := strings.TrimPrefix(r.URL.Path, "/rest/ip/firewall/nat/")
			var next []map[string]any
			for _, n := range nats {
				if strVal(n[".id"]) != id {
					next = append(next, n)
				}
			}
			nats = next
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/rest/system/reboot":
			rebooted = true
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "mk", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
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
	if s.Overview == nil || s.Overview.UptimeSeconds == nil || *s.Overview.UptimeSeconds != 93784 || len(s.Overview.WAN) != 1 {
		t.Fatalf("unexpected overview: %+v", s.Overview)
	}
	if len(s.WiFi) != 1 || s.WiFi[0].SSID != "Office5G" || !s.WiFi[0].Enabled {
		t.Fatalf("unexpected wifi: %+v", s.WiFi)
	}
	if raw, _ := json.Marshal(s); strings.Contains(string(raw), "TOP-SECRET-KEY") {
		t.Fatal("Wi-Fi secret leaked into Settings")
	}
	if _, err := d.SetWiFiEnabled(ctx, "wifi:*W1", false); err != nil || wifiDisabled != "true" {
		t.Fatalf("wifi toggle failed: err=%v disabled=%s", err, wifiDisabled)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.88.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Main NAS"); err != nil {
		t.Fatalf("RenameClient failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Plex", Protocol: "tcp", ExternalStart: 32400, InternalIP: "192.168.88.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %d", len(s2.PortForwards))
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[1]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if _, err := d.Reboot(ctx); err != nil || !rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, rebooted)
	}
}
