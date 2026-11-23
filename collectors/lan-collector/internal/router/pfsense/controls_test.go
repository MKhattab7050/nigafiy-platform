package pfsense

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

const pfKey = "pf-rest-api-key-secret-5512"

// pfControls is a protocol test double of the pfSense REST API v2, served over TLS with its own
// self-signed certificate (the driver reaches it through the pinned-certificate transport).
type pfControls struct {
	mu         sync.Mutex
	mappings   []map[string]any
	pfs        []map[string]any
	rebooted   bool
	applied    int
	failWrites bool
	srv        *httptest.Server
}

func newPfControls(t *testing.T) *pfControls {
	f := &pfControls{mappings: []map[string]any{{"id": 0, "parent_id": "lan", "mac": "aa:bb:cc:00:00:10", "ipaddr": "192.168.10.10"}}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *pfControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ok := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "code": 200, "data": data}) }
	if r.Header.Get("X-API-Key") != pfKey {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "unauthorized", "code": 401, "message": "Authentication failed"})
		return
	}
	if f.failWrites && r.Method != http.MethodGet {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "bad request", "code": 400, "message": "Field `ipaddr` is outside of the interface subnet"})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/status/system":
		ok(map[string]any{"uptime": 9900})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/status/interfaces":
		ok([]map[string]any{
			{"name": "lan", "status": "up", "ipaddr": "192.168.10.1", "subnet": 24},
			{"name": "wan", "status": "up", "ipaddr": "41.9.8.7", "subnet": 24},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/services/dhcp_server/static_mappings":
		ok(f.mappings)
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/services/dhcp_server/static_mapping":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		b["id"] = 1
		f.mappings = append(f.mappings, b)
		ok(b)
	case r.Method == http.MethodDelete && r.URL.Path == "/api/v2/services/dhcp_server/static_mapping":
		f.mappings = f.mappings[:1]
		ok(map[string]any{})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/firewall/nat/port_forwards":
		ok(f.pfs)
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/firewall/nat/port_forward":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		b["id"] = 7
		f.pfs = append(f.pfs, b)
		ok(b)
	case r.Method == http.MethodDelete && r.URL.Path == "/api/v2/firewall/nat/port_forward":
		f.pfs = nil
		ok(map[string]any{})
	case r.Method == http.MethodPost && (r.URL.Path == "/api/v2/firewall/apply" || r.URL.Path == "/api/v2/services/dhcp_server/apply"):
		f.applied++
		ok(map[string]any{})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/diagnostics/reboot":
		f.rebooted = true
		ok(map[string]any{})
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "not found", "code": 404, "message": "Endpoint not found"})
	}
}

func (f *pfControls) driver(t *testing.T, pin, key string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "pf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "api-key", []byte(key), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

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
		if strings.Contains(s, pfKey) {
			t.Fatalf("%s leaked the API key: %s", what, s)
		}
	}
}

func TestExtendedControls(t *testing.T) {
	f := newPfControls(t)
	d := f.driver(t, "", pfKey)
	ctx := context.Background()

	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 9900 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.10.22")
	if err != nil || !ch.Applied || len(f.mappings) != 2 {
		t.Fatalf("AddReservation failed: %+v %v", ch, err)
	}
	noSecret(t, "AddReservation", ch)
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || len(f.mappings) != 1 {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "VPN", Protocol: "udp", ExternalStart: 1194, InternalIP: "192.168.10.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 || s2.PortForwards[0].ExternalStart != 1194 {
		t.Fatalf("expected the new port forward, got %+v", s2.PortForwards)
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if f.applied != 4 {
		t.Fatalf("every change must be applied (DHCP twice, firewall twice), got %d applies", f.applied)
	}
	if ch, err := d.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, f.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("router refuses writes", func(t *testing.T) {
		f := newPfControls(t)
		d := f.driver(t, "", pfKey)
		f.failWrites = true
		_, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.10.22")
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "outside of the interface subnet") {
			t.Fatalf("want ErrRejected with the router's reason, got %v", err)
		}
		noSecret(t, "AddReservation error", err)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "VPN", Protocol: "udp", ExternalStart: 1194, InternalIP: "192.168.10.10"}); !errors.Is(err, router.ErrRejected) {
			t.Fatalf("want ErrRejected, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || f.rebooted {
			t.Fatalf("want ErrRejected and no reboot, got %v", err)
		}
		if len(f.mappings) != 1 || len(f.pfs) != 0 {
			t.Fatal("a refused write must not change the router")
		}
	})

	t.Run("a rule changed since it was read is not removed", func(t *testing.T) {
		f := newPfControls(t)
		d := f.driver(t, "", pfKey)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "VPN", Protocol: "udp", ExternalStart: 1194, InternalIP: "192.168.10.10"}); err != nil {
			t.Fatal(err)
		}
		s, _ := d.Settings(ctx)
		seen := s.PortForwards[0]
		f.mu.Lock()
		f.pfs[0]["target"] = "192.168.10.99"
		f.mu.Unlock()
		if _, err := d.RemovePortForward(ctx, seen); !errors.Is(err, router.ErrRejected) || len(f.pfs) != 1 {
			t.Fatalf("want ErrRejected and the rule kept, got %v (rules %d)", err, len(f.pfs))
		}
	})

	t.Run("invalid input never reaches the router", func(t *testing.T) {
		f := newPfControls(t)
		d := f.driver(t, "", pfKey)
		if _, err := d.AddReservation(ctx, "00:00:00:00:00:00", "192.168.10.22"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("zero MAC: want ErrInvalidArgument, got %v", err)
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Web", Protocol: "tcp", ExternalStart: 443, InternalIP: "192.168.10.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if len(f.pfs) != 0 || len(f.mappings) != 1 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong API key", func(t *testing.T) {
		f := newPfControls(t)
		d := f.driver(t, "", "wrong-"+pfKey)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		f := newPfControls(t)
		d := f.driver(t, strings.Repeat("cd", 32), pfKey)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || f.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}
