package opnsense

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
	rows := []map[string]any{
		{"uuid": "r1", "hw_address": "aa:bb:cc:00:00:10", "ip_address": "192.168.20.10"},
	}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/diagnostics/system/systemTime":
			_ = json.NewEncoder(w).Encode(map[string]any{"uptime": "1 day, 02:00:00"})
		case r.URL.Path == "/api/diagnostics/interface/getInterfaceConfig":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"lan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "192.168.20.1"}}},
				"wan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "41.3.4.5"}}},
			})
		case r.URL.Path == "/api/kea/dhcpv4/searchReservation":
			_ = json.NewEncoder(w).Encode(map[string]any{"rows": rows})
		case r.URL.Path == "/api/kea/dhcpv4/searchSubnet":
			_ = json.NewEncoder(w).Encode(map[string]any{"rows": []map[string]any{{"uuid": "sub1", "subnet": "192.168.20.0/24"}}})
		case r.URL.Path == "/api/kea/dhcpv4/addReservation":
			var b struct{ Reservation map[string]any `json:"reservation"` }
			_ = json.NewDecoder(r.Body).Decode(&b)
			b.Reservation["uuid"] = "r2"
			rows = append(rows, b.Reservation)
			_ = json.NewEncoder(w).Encode(map[string]any{"result": "saved", "uuid": "r2"})
		case strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/"):
			rows = rows[:1]
			_ = json.NewEncoder(w).Encode(map[string]any{"result": "deleted"})
		case r.URL.Path == "/api/core/system/reboot":
			rebooted = true
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "opn", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "k", []byte("s"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 93600 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.Reboot(ctx); err != nil || !rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, rebooted)
	}
}
