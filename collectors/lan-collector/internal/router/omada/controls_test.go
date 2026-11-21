package omada

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
	ssidOn := true
	pfs := []map[string]any{}
	rebooted := false
	renamed := ""

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(res any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "msg": "Success.", "result": res})
		}
		switch {
		case r.URL.Path == "/api/info":
			ok(map[string]any{"omadacId": "om1", "controllerVer": "5.14", "name": "OC200"})
		case r.URL.Path == "/om1/api/v2/login":
			ok(map[string]any{"token": "csrf-tok"})
		case r.URL.Path == "/om1/api/v2/sites":
			ok(map[string]any{"data": []map[string]any{{"id": "s1", "name": "Default"}}})
		case r.URL.Path == "/om1/api/v2/sites/s1/devices":
			ok([]map[string]any{{"type": "gateway", "mac": "00-11-22-33-44-55", "ip": "192.168.0.1", "uptimeLong": 10800, "publicIp": "41.5.6.7"}})
		case r.URL.Path == "/om1/api/v2/sites/s1/setting/wlans":
			ok([]map[string]any{{"id": "wl1"}})
		case r.URL.Path == "/om1/api/v2/sites/s1/setting/wlans/wl1/ssids":
			ok([]map[string]any{{"id": "ss1", "name": "OmadaCorp", "enable": ssidOn, "band": 3, "security": 3, "pskSetting": map[string]string{"securityKey": "OMADA-SECRET"}}})
		case r.Method == http.MethodPatch && r.URL.Path == "/om1/api/v2/sites/s1/setting/wlans/wl1/ssids/ss1":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			ssidOn = boolOf(b["enable"])
			ok(map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/om1/api/v2/sites/s1/clients":
			ok(map[string]any{"data": []map[string]any{{"mac": "AA-BB-CC-00-00-10", "ipSetting": map[string]any{"useFixedAddr": true, "ip": "192.168.0.10"}}}})
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/om1/api/v2/sites/s1/clients/"):
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if n := str(b["name"]); n != "" {
				renamed = n
			}
			ok(map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/om1/api/v2/sites/s1/setting/transmission/portForwarding":
			ok(map[string]any{"data": pfs})
		case r.Method == http.MethodPost && r.URL.Path == "/om1/api/v2/sites/s1/setting/transmission/portForwarding":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["id"] = "pf1"
			pfs = append(pfs, b)
			ok(b)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/om1/api/v2/sites/s1/setting/transmission/portForwarding/"):
			pfs = nil
			ok(map[string]any{})
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/cmd/devices/") && strings.HasSuffix(r.URL.Path, "/reboot"):
			rebooted = true
			ok(map[string]any{})
		default:
			ok(map[string]any{})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "om", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
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
	if len(s.WiFi) != 1 || s.WiFi[0].ID != "wl1/ss1" || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: %+v", s)
	}
	if raw, _ := json.Marshal(s); strings.Contains(string(raw), "OMADA-SECRET") {
		t.Fatal("Wi-Fi key leaked into Settings")
	}
	if _, err := d.SetWiFiEnabled(ctx, "wl1/ss1", false); err != nil || ssidOn {
		t.Fatalf("SetWiFiEnabled failed: %v", err)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.0.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Printer"); err != nil || renamed != "Printer" {
		t.Fatalf("RenameClient failed: err=%v renamed=%q", err, renamed)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "NVR", Protocol: "tcp", ExternalStart: 8554, InternalIP: "192.168.0.10"}); err != nil {
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
