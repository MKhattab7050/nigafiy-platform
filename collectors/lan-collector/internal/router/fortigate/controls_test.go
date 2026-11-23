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
