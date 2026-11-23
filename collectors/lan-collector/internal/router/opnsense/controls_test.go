package opnsense

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

const (
	opnCtlKey    = "opn-ctl-key"
	opnCtlSecret = "opn-ctl-secret-8841"
)

// opnControls is a protocol test double of the OPNsense REST API (Kea reservations, reboot),
// served over TLS with its own self-signed certificate.
type opnControls struct {
	mu           sync.Mutex
	rows         []map[string]any
	rebooted     bool
	reconfigures int
	failWrites   bool
	dnatCalls    int
	srv          *httptest.Server
}

func newOpnControls(t *testing.T) *opnControls {
	f := &opnControls{rows: []map[string]any{{"uuid": "r1", "hw_address": "aa:bb:cc:00:00:10", "ip_address": "192.168.20.10"}}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *opnControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if k, s, ok := r.BasicAuth(); !ok || k != opnCtlKey || s != opnCtlSecret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/firewall/d_nat") {
		f.dnatCalls++
	}
	isWrite := r.URL.Path == "/api/kea/dhcpv4/addReservation" || strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/") || r.URL.Path == "/api/core/system/reboot"
	if f.failWrites && isWrite {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "failed"})
		return
	}
	switch {
	case r.URL.Path == "/api/core/firmware/info":
		_ = json.NewEncoder(w).Encode(map[string]any{"product_name": "OPNsense", "product_version": "25.1.4"})
	case r.URL.Path == "/api/diagnostics/system/systemTime":
		_ = json.NewEncoder(w).Encode(map[string]any{"uptime": "1 day, 02:00:00"})
	case r.URL.Path == "/api/diagnostics/interface/getInterfaceConfig":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"lan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "192.168.20.1"}}},
			"wan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "41.3.4.5"}}},
		})
	case r.URL.Path == "/api/kea/dhcpv4/searchReservation":
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": f.rows})
	case r.URL.Path == "/api/kea/dhcpv4/searchSubnet":
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": []map[string]any{{"uuid": "sub1", "subnet": "192.168.20.0/24"}}})
	case r.URL.Path == "/api/kea/dhcpv4/addReservation":
		var b struct {
			Reservation map[string]any `json:"reservation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		b.Reservation["uuid"] = "r2"
		f.rows = append(f.rows, b.Reservation)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "saved", "uuid": "r2"})
	case strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/")
		kept := f.rows[:0]
		for _, row := range f.rows {
			if row["uuid"] != id {
				kept = append(kept, row)
			}
		}
		f.rows = kept
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "deleted"})
	case r.URL.Path == "/api/kea/service/reconfigure":
		f.reconfigures++
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	case r.URL.Path == "/api/core/system/reboot":
		f.rebooted = true
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *opnControls) driver(t *testing.T, pin, secret string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "opn", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return opnCtlKey, []byte(secret), nil })
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
		if strings.Contains(s, opnCtlSecret) {
			t.Fatalf("%s leaked the API secret: %s", what, s)
		}
	}
}

func TestExtendedControls(t *testing.T) {
	f := newOpnControls(t)
	d := f.driver(t, "", opnCtlSecret)
	ctx := context.Background()

	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 93600 || len(s.Reservations) != 1 || s.Overview.LANIP != "192.168.20.1" {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22")
	if err != nil || !ch.Applied || len(f.rows) != 2 || f.rows[1]["subnet"] != "sub1" {
		t.Fatalf("AddReservation failed: %+v %v rows=%v", ch, err, f.rows)
	}
	noSecret(t, "AddReservation", ch)
	if ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation must be idempotent: %+v %v", ch, err)
	}
	if ch, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || !ch.Applied || len(f.rows) != 1 {
		t.Fatalf("RemoveReservation failed: %+v %v", ch, err)
	}
	if f.reconfigures != 2 {
		t.Fatalf("Kea must be reconfigured after each change, got %d", f.reconfigures)
	}
	if ch, err := d.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, f.rebooted)
	}
}

// Port forwards are refused on OPNsense, honestly: the capability says why (with the firmware that
// was detected), the driver does not implement router.PortForwarder, and nothing is sent to the
// destination-NAT API.
func TestPortForwardRefusedWithDetectedFirmware(t *testing.T) {
	f := newOpnControls(t)
	d := f.driver(t, "", opnCtlSecret)
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var pf *router.CapabilityStatus
	for i := range caps {
		if caps[i].Capability == router.CapPortForward {
			pf = &caps[i]
		}
	}
	if pf == nil || pf.Supported || !strings.Contains(pf.Note, "firmware 25.1.4") || !strings.Contains(pf.Note, "Firewall → NAT → Port Forward") {
		t.Fatalf("want an unsupported port-forward capability naming the firmware, got %+v", pf)
	}
	if _, ok := any(d).(router.PortForwarder); ok {
		t.Fatal("the OPNsense driver must not offer port-forward changes")
	}
	s, _ := d.Settings(context.Background())
	if s.PortForwards != nil || f.dnatCalls != 0 {
		t.Fatalf("no port-forward data may be invented or requested: %v, %d d_nat calls", s.PortForwards, f.dnatCalls)
	}
	if got := portForwardNote(""); !strings.Contains(got, "unknown version") {
		t.Fatalf("unexpected note without a version: %q", got)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("router refuses writes", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", opnCtlSecret)
		f.failWrites = true
		_, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22")
		if !errors.Is(err, router.ErrRejected) {
			t.Fatalf("want ErrRejected, got %v", err)
		}
		noSecret(t, "AddReservation error", err)
		if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:10"); !errors.Is(err, router.ErrRejected) || len(f.rows) != 1 {
			t.Fatalf("want ErrRejected and the reservation kept, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || f.rebooted {
			t.Fatalf("want ErrRejected and no reboot, got %v", err)
		}
		if f.reconfigures != 0 {
			t.Fatal("a refused change must not be applied")
		}
	})

	t.Run("reservation outside the DHCP subnet never reaches the router", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", opnCtlSecret)
		if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "10.99.0.5"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("want ErrInvalidArgument, got %v", err)
		}
		if len(f.rows) != 1 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong API secret", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", "wrong-"+opnCtlSecret)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, strings.Repeat("ef", 32), opnCtlSecret)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || f.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}
