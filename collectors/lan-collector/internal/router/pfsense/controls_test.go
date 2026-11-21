package pfsense

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
)

func TestExtendedControls(t *testing.T) {
	mappings := []map[string]any{
		{"id": 0, "parent_id": "lan", "mac": "aa:bb:cc:00:00:10", "ipaddr": "192.168.10.10"},
	}
	pfs := []map[string]any{}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": data}) }
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/status/system":
			ok(map[string]any{"uptime": 9900})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/status/interfaces":
			ok([]map[string]any{
				{"name": "lan", "status": "up", "ipaddr": "192.168.10.1", "subnet": 24},
				{"name": "wan", "status": "up", "ipaddr": "41.9.8.7", "subnet": 24},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/services/dhcp_server/static_mappings":
			ok(mappings)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/services/dhcp_server/static_mapping":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["id"] = 1
			mappings = append(mappings, b)
			ok(b)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v2/services/dhcp_server/static_mapping":
			mappings = mappings[:1]
			ok(map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/firewall/nat/port_forwards":
			ok(pfs)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/firewall/nat/port_forward":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["id"] = 7
			pfs = append(pfs, b)
			ok(b)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v2/firewall/nat/port_forward":
			pfs = nil
			ok(map[string]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/diagnostics/reboot":
			rebooted = true
			ok(map[string]any{})
		default:
			ok(map[string]any{})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "pf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "api-key", []byte("k1"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 9900 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.10.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "VPN", Protocol: "udp", ExternalStart: 1194, InternalIP: "192.168.10.10"}); err != nil {
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
