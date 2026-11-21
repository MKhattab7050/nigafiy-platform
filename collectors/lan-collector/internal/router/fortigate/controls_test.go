package fortigate

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
	reserved := []map[string]any{{"id": 1, "mac": "aa:bb:cc:00:00:10", "ip": "192.168.30.10", "action": "reserved"}}
	vips := []map[string]any{}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/monitor/system/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"version": "v7.4", "results": map[string]any{"uptime": 5400}})
		case r.URL.Path == "/api/v2/monitor/system/interface":
			_ = json.NewEncoder(w).Encode(map[string]any{"results": map[string]any{
				"lan":  map[string]any{"ip": "192.168.30.1", "link": true},
				"wan1": map[string]any{"ip": "41.8.8.8", "link": true, "type": "physical"},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/cmdb/system.dhcp/server":
			_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"id": 1, "interface": "lan", "reserved-address": reserved}}})
		case r.Method == http.MethodPut && r.URL.Path == "/api/v2/cmdb/system.dhcp/server/1":
			var b struct{ Reserved []map[string]any `json:"reserved-address"` }
			_ = json.NewDecoder(r.Body).Decode(&b)
			reserved = b.Reserved
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/cmdb/firewall/vip":
			_ = json.NewEncoder(w).Encode(map[string]any{"results": vips})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/cmdb/firewall/vip":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			vips = append(vips, b)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v2/cmdb/firewall/vip/"):
			vips = nil
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/monitor/system/os/reboot":
			rebooted = true
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "fg", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "token", []byte("tok"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 5400 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.30.22"); err != nil || len(reserved) != 2 {
		t.Fatalf("AddReservation failed: err=%v len=%d", err, len(reserved))
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || len(reserved) != 1 {
		t.Fatalf("RemoveReservation failed: err=%v len=%d", err, len(reserved))
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Web", Protocol: "tcp", ExternalStart: 8443, InternalIP: "192.168.30.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 {
		t.Fatalf("expected 1 vip, got %d", len(s2.PortForwards))
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if _, err := d.Reboot(ctx); err != nil || !rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, rebooted)
	}
}
