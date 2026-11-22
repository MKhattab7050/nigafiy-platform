package ciscoxe

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
	"sync/atomic"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

const cxPassword = "cx-restconf-pass-6620"

// cxControls is a protocol test double of IOS XE RESTCONF, served over TLS with its own
// self-signed certificate. It counts anything that is not a GET: the driver is read-only.
type cxControls struct {
	writes atomic.Int32
	srv    *httptest.Server
}

func newCxControls(t *testing.T) *cxControls {
	f := &cxControls{}
	boot := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "admin" || p != cxPassword {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet {
			f.writes.Add(1)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		switch r.URL.Path {
		case "/restconf/data/Cisco-IOS-XE-native:native/version":
			_ = json.NewEncoder(w).Encode(map[string]any{"Cisco-IOS-XE-native:version": "17.9"})
		case "/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware/device-system-data":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-device-hardware-oper:device-system-data": map[string]any{"boot-time": boot},
			})
		case "/restconf/data/Cisco-IOS-XE-interfaces-oper:interfaces/interface":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-interfaces-oper:interface": []map[string]any{
					{"name": "GigabitEthernet0/0/0", "oper-status": "if-oper-state-ready", "ipv4": "41.20.30.40", "type": "iana-iftype-ethernet-csmacd"},
					{"name": "GigabitEthernet0/0/1", "oper-status": "if-oper-state-ready", "ipv4": "192.168.88.1", "type": "iana-iftype-ethernet-csmacd"},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *cxControls) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "cx", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "admin", []byte(password), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestSettingsReadOnly(t *testing.T) {
	f := newCxControls(t)
	d := f.driver(t, "", cxPassword)
	s, err := d.Settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview == nil || s.Overview.UptimeSeconds == nil || *s.Overview.UptimeSeconds < 7000 || len(s.Overview.WAN) != 1 || s.Overview.WAN[0].IPv4 != "41.20.30.40" {
		t.Fatalf("unexpected overview: %+v", s.Overview)
	}
	if s.Reservations != nil || s.PortForwards != nil || s.WiFi != nil {
		t.Fatalf("the read-only driver must not report write-side data: %+v", s)
	}
	raw, _ := json.Marshal(s)
	if strings.Contains(string(raw), cxPassword) {
		t.Fatal("Settings leaked the password")
	}

	// Read-only by design: no write interface, every write capability refused with a reason, and
	// nothing but GET requests reach the router.
	for name, ok := range map[string]bool{
		"ReservationManager": func() bool { _, ok := any(d).(router.ReservationManager); return ok }(),
		"PortForwarder":      func() bool { _, ok := any(d).(router.PortForwarder); return ok }(),
		"WiFiController":     func() bool { _, ok := any(d).(router.WiFiController); return ok }(),
		"Rebooter":           func() bool { _, ok := any(d).(router.Rebooter); return ok }(),
		"Renamer":            func() bool { _, ok := any(d).(router.Renamer); return ok }(),
	} {
		if ok {
			t.Errorf("the IOS XE driver must not implement %s", name)
		}
	}
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range caps {
		switch c.Capability {
		case router.CapReservations, router.CapPortForward, router.CapWiFi, router.CapReboot, router.CapRename, router.CapBlock:
			if c.Supported || c.Note == "" {
				t.Errorf("%s must be unsupported with a reason, got %+v", c.Capability, c)
			}
		}
	}
	if _, err := d.Block(context.Background(), "aa:bb:cc:00:00:01"); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("Block: want ErrUnsupported, got %v", err)
	}
	if f.writes.Load() != 0 {
		t.Fatalf("the read-only driver sent %d write requests", f.writes.Load())
	}
}

func TestSettingsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("rejected password is an error, not an empty overview", func(t *testing.T) {
		f := newCxControls(t)
		d := f.driver(t, "", "wrong-"+cxPassword)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		if strings.Contains(err.Error(), cxPassword) {
			t.Fatal("the error leaked the password")
		}
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		f := newCxControls(t)
		d := f.driver(t, strings.Repeat("12", 32), cxPassword)
		if _, err := d.Settings(ctx); !errors.Is(err, router.ErrCertificate) {
			t.Fatalf("want ErrCertificate, got %v", err)
		}
	})
}
