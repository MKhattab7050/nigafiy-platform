package fortigate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/nigafiy/sensor/internal/router"
)

const fgToken = "fg-api-token-secret-7731"

// fgControls is a protocol test double of the FortiOS REST API, served over TLS with its own
// self-signed certificate (the driver reaches it through the pinned-certificate transport).
type fgControls struct {
	mu         sync.Mutex
	reserved   []map[string]any
	vips       []map[string]any
	rebooted   bool
	failWrites bool
	vaps       []map[string]any  // wireless-controller VAPs (nil: no wireless controller → 404)
	ifStatus   map[string]string // system interface status by name
	wifiCli    []map[string]any  // /api/v2/monitor/wifi/client
	srv        *httptest.Server
}

func newFgControls(t *testing.T) *fgControls {
	f := &fgControls{reserved: []map[string]any{{"id": 1, "mac": "aa:bb:cc:00:00:10", "ip": "192.168.30.10", "action": "reserved"}}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fgControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+fgToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if f.failWrites && r.Method != http.MethodGet {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "http_status": 500})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/cmdb/wireless-controller/vap":
		if f.vaps == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": f.vaps})
	case strings.HasPrefix(r.URL.Path, "/api/v2/cmdb/system/interface/"):
		name := strings.TrimPrefix(r.URL.Path, "/api/v2/cmdb/system/interface/")
		st, ok := f.ifStatus[name]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method == http.MethodPut {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if len(b) != 1 || (b["status"] != "up" && b["status"] != "down") {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			f.ifStatus[name] = b["status"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"name": name, "status": st}}})
	case r.URL.Path == "/api/v2/monitor/wifi/client":
		_ = json.NewEncoder(w).Encode(map[string]any{"results": f.wifiCli})
	case r.URL.Path == "/api/v2/monitor/system/status":
		_ = json.NewEncoder(w).Encode(map[string]any{"version": "v7.4", "results": map[string]any{"uptime": 5400}})
	case r.URL.Path == "/api/v2/monitor/system/interface":
		_ = json.NewEncoder(w).Encode(map[string]any{"results": map[string]any{
			"lan":  map[string]any{"ip": "192.168.30.1", "link": true},
			"wan1": map[string]any{"ip": "41.8.8.8", "link": true, "type": "physical"},
		}})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/cmdb/system.dhcp/server":
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"id": 1, "interface": "lan", "reserved-address": f.reserved}}})
	case r.Method == http.MethodPut && r.URL.Path == "/api/v2/cmdb/system.dhcp/server/1":
		var b struct {
			Reserved []map[string]any `json:"reserved-address"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.reserved = b.Reserved
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/cmdb/firewall/vip":
		_ = json.NewEncoder(w).Encode(map[string]any{"results": f.vips})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/cmdb/firewall/vip":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.vips = append(f.vips, b)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v2/cmdb/firewall/vip/"):
		f.vips = nil
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/monitor/system/os/reboot":
		f.rebooted = true
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fgControls) driver(t *testing.T, pin, token string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "fg", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "token", []byte(token), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

// noSecret fails when the token appears in any value (marshalled) or error text.
func noSecret(t *testing.T, what string, values ...any) {
	t.Helper()
	for _, v := range values {
		var s string
		if err, ok := v.(error); ok && err != nil {
			s = err.Error()
		} else {
			b, _ := json.Marshal(v)
			s = string(b)
		}
		if strings.Contains(s, fgToken) {
			t.Fatalf("%s leaked the API token: %s", what, s)
		}
	}
}

func TestExtendedControls(t *testing.T) {
	f := newFgControls(t)
	d := f.driver(t, "", fgToken)
	ctx := context.Background()

	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 5400 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.30.22")
	if err != nil || !ch.Applied || len(f.reserved) != 2 {
		t.Fatalf("AddReservation failed: err=%v len=%d", err, len(f.reserved))
	}
	noSecret(t, "AddReservation", ch)
	if ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.30.22"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation must be idempotent: %+v %v", ch, err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || len(f.reserved) != 1 {
		t.Fatalf("RemoveReservation failed: err=%v len=%d", err, len(f.reserved))
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Web", Protocol: "tcp", ExternalStart: 8443, InternalIP: "192.168.30.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 || s2.PortForwards[0].ExternalStart != 8443 || s2.PortForwards[0].InternalIP != "192.168.30.10" {
		t.Fatalf("expected the new VIP, got %+v", s2.PortForwards)
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if ch, err := d.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, f.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("router refuses writes", func(t *testing.T) {
		f := newFgControls(t)
		d := f.driver(t, "", fgToken)
		f.failWrites = true
		_, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.30.22")
		if !errors.Is(err, router.ErrRejected) {
			t.Fatalf("want ErrRejected, got %v", err)
		}
		noSecret(t, "AddReservation error", err)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Web", Protocol: "tcp", ExternalStart: 8443, InternalIP: "192.168.30.10"}); !errors.Is(err, router.ErrRejected) {
			t.Fatalf("want ErrRejected, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || f.rebooted {
			t.Fatalf("want ErrRejected and no reboot, got %v", err)
		}
		if len(f.reserved) != 1 {
			t.Fatal("a refused write must not change the router")
		}
	})

	t.Run("invalid input never reaches the router", func(t *testing.T) {
		f := newFgControls(t)
		d := f.driver(t, "", fgToken)
		if _, err := d.AddReservation(ctx, "ff:ff:ff:ff:ff:ff", "192.168.30.22"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("broadcast MAC: want ErrInvalidArgument, got %v", err)
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "SSH", Protocol: "tcp", ExternalStart: 22, InternalIP: "192.168.30.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if len(f.vips) != 0 || len(f.reserved) != 1 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong token", func(t *testing.T) {
		f := newFgControls(t)
		d := f.driver(t, "", "wrong-"+fgToken)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		f := newFgControls(t)
		d := f.driver(t, strings.Repeat("ab", 32), fgToken)
		if _, err := d.Settings(ctx); !errors.Is(err, router.ErrCertificate) {
			t.Fatalf("want ErrCertificate, got %v", err)
		}
		if f.rebooted || len(f.reserved) != 1 {
			t.Fatal("nothing may be sent to a router whose certificate does not match")
		}
	})
}

const fgWiFiKey = "wifi-passphrase-never-read-4471"

// withWiFi gives the double a FortiWiFi's SSIDs: "home" (up, one client), "guest" (down, hidden) and
// "remote" (a tunnel SSID without a local interface).
func (f *fgControls) withWiFi() {
	f.vaps = []map[string]any{
		{"name": "home", "ssid": "Office", "broadcast-ssid": "enable", "security": "wpa2-only-personal", "passphrase": "ENC " + fgWiFiKey},
		{"name": "guest", "ssid": "Visitors", "broadcast-ssid": "disable", "security": "wpa3-sae", "passphrase": fgWiFiKey},
		{"name": "remote", "ssid": "Branch", "security": "open"},
	}
	f.ifStatus = map[string]string{"home": "up", "guest": "down"}
	f.wifiCli = []map[string]any{{"mac": "AA:BB:CC:00:00:31", "vap_name": "home", "ssid": "Office"}}
}

func TestWiFi(t *testing.T) {
	ctx := context.Background()
	f := newFgControls(t)
	f.withWiFi()
	d := f.driver(t, "", fgToken)

	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapWiFi) {
		t.Fatalf("Wi-Fi must be offered with SSIDs: %v %+v", err, caps.Get(router.CapWiFi))
	}
	s, err := d.Settings(ctx)
	if err != nil || len(s.WiFi) != 2 {
		t.Fatalf("want the two SSIDs with an interface, got %v %+v", err, s.WiFi)
	}
	home, guest := s.WiFi[0], s.WiFi[1]
	if home.ID != "home" || home.SSID != "Office" || !home.Enabled || !home.Main || len(home.ClientMACs) != 1 || home.ClientMACs[0] != "aa:bb:cc:00:00:31" {
		t.Fatalf("unexpected home SSID: %+v", home)
	}
	if guest.Enabled || !guest.Hidden || guest.Security != "wpa3-sae" {
		t.Fatalf("unexpected guest SSID: %+v", guest)
	}
	noSecretOf(t, fgWiFiKey, "Settings", s)

	ch, err := d.SetWiFiEnabled(ctx, "guest", true)
	if err != nil || !ch.Applied || f.ifStatus["guest"] != "up" || !strings.Contains(ch.Undo, "off") {
		t.Fatalf("turning guest on failed: %+v %v", ch, err)
	}
	if ch, err := d.SetWiFiEnabled(ctx, "guest", true); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("no-op expected: %+v %v", ch, err)
	}
	if ch, err := d.SetWiFiEnabled(ctx, "home", false); err != nil || !ch.Applied || f.ifStatus["home"] != "down" {
		t.Fatalf("turning home off failed: %+v %v", ch, err)
	}
	noSecretOf(t, fgWiFiKey, "Change", ch)

	// Refused before sending: unknown SSID, an SSID without a local interface, a malformed id.
	for _, id := range []string{"nope", "remote", "../system", "", "a b"} {
		if _, err := d.SetWiFiEnabled(ctx, id, true); err == nil {
			t.Fatalf("%q must be refused", id)
		}
	}
	if f.ifStatus["home"] != "down" || f.ifStatus["guest"] != "up" {
		t.Fatal("refused input changed the router")
	}

	// The router refuses: error, state unchanged.
	f.failWrites = true
	if _, err := d.SetWiFiEnabled(ctx, "home", true); !errors.Is(err, router.ErrRejected) || f.ifStatus["home"] != "down" {
		t.Fatalf("want ErrRejected and no change, got %v", err)
	}
}

func TestWiFiAbsentAndAuth(t *testing.T) {
	ctx := context.Background()
	f := newFgControls(t) // no wireless controller
	d := f.driver(t, "", fgToken)
	caps, err := d.Capabilities(ctx)
	if err != nil || caps.Supports(router.CapWiFi) || !strings.Contains(caps.Get(router.CapWiFi).Note, "no wireless controller") {
		t.Fatalf("Wi-Fi must not be offered without a controller: %v %+v", err, caps.Get(router.CapWiFi))
	}
	if s, _ := d.Settings(ctx); s.WiFi != nil {
		t.Fatalf("no SSIDs may be invented: %+v", s.WiFi)
	}
	if _, err := d.SetWiFiEnabled(ctx, "home", false); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}

	f2 := newFgControls(t)
	f2.withWiFi()
	if _, err := f2.driver(t, "", "wrong-"+fgToken).SetWiFiEnabled(ctx, "home", false); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	} else {
		noSecret(t, "error", err)
	}
	if _, err := f2.driver(t, strings.Repeat("ab", 32), fgToken).SetWiFiEnabled(ctx, "home", false); !errors.Is(err, router.ErrCertificate) {
		t.Fatalf("want ErrCertificate, got %v", err)
	}
	if f2.ifStatus["home"] != "up" {
		t.Fatal("nothing may change with a wrong token or certificate")
	}
}

func TestRenameThroughReservationDescription(t *testing.T) {
	ctx := context.Background()
	f := newFgControls(t)
	d := f.driver(t, "", fgToken)
	caps, _ := d.Capabilities(ctx)
	if c := caps.Get(router.CapRename); !c.Supported || c.Requires != router.RequiresReservation {
		t.Fatalf("rename must be offered through the reservation: %+v", c)
	}
	ch, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Reception PC")
	if err != nil || !ch.Applied || f.reserved[0]["description"] != "Reception PC" || f.reserved[0]["ip"] != "192.168.30.10" {
		t.Fatalf("rename failed: %+v %v %v", ch, err, f.reserved)
	}
	noSecret(t, "RenameClient", ch)
	if ch, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", " Reception PC "); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("same name must be a no-op: %+v %v", ch, err)
	}
	if ch, _ := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Desk"); !strings.Contains(ch.Undo, `"Reception PC"`) {
		t.Fatalf("undo must name the previous name: %q", ch.Undo)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:55", "Phone"); !errors.Is(err, router.ErrNotFound) {
		t.Fatalf("want ErrNotFound without a reservation, got %v", err)
	}
	for _, bad := range []string{"", "a\nb", strings.Repeat("x", 64)} {
		if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", bad); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("%q: want ErrInvalidArgument, got %v", bad, err)
		}
	}
	f.failWrites = true
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Other"); !errors.Is(err, router.ErrRejected) || f.reserved[0]["description"] != "Desk" {
		t.Fatalf("want ErrRejected and no change, got %v", err)
	}
	f.failWrites = false
	if _, err := f.driver(t, "", "bad").RenameClient(ctx, "aa:bb:cc:00:00:10", "X"); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
	if _, err := f.driver(t, strings.Repeat("ab", 32), fgToken).RenameClient(ctx, "aa:bb:cc:00:00:10", "X"); !errors.Is(err, router.ErrCertificate) || f.reserved[0]["description"] != "Desk" {
		t.Fatalf("want ErrCertificate and no change, got %v", err)
	}
}

func noSecretOf(t *testing.T, secret, what string, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), secret) {
		t.Fatalf("%s leaked a secret: %s", what, b)
	}
}
