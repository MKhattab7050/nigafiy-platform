package mikrotik

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
	"testing"

	"github.com/nigafiy/sensor/internal/router"
)

const mkPassword = "mk-rest-pass-3307"

// mkState is the RouterOS REST API test double's state, served over TLS with its own self-signed
// certificate (the driver reaches it through the pinned-certificate transport).
type mkState struct {
	wifiDisabled string
	leases       []map[string]any
	nats         []map[string]any
	rebooted     bool
	failWrites   bool
	srv          *httptest.Server
}

func newMkControls(t *testing.T) *mkState {
	st := &mkState{}
	st.wifiDisabled = "false"
	leases := []map[string]any{
		{".id": "*L1", "mac-address": "AA:BB:CC:00:00:10", "address": "192.168.88.10", "dynamic": "false", "disabled": "false", "comment": "Nas"},
	}
	nats := []map[string]any{
		{".id": "*N1", "chain": "dstnat", "action": "dst-nat", "protocol": "tcp", "dst-port": "8080", "to-addresses": "192.168.88.10", "to-ports": "80", "comment": "admin web", "disabled": "false"},
	}
	st.leases, st.nats = leases, nats
	st.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "admin" || p != mkPassword {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": 401, "message": "Unauthorized"})
			return
		}
		if st.failWrites && r.Method != http.MethodGet {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": 400, "message": "Bad Request", "detail": "failure: already have static lease with this IP address"})
			return
		}
		wifiDisabled, leases, nats := st.wifiDisabled, st.leases, st.nats
		defer func() { st.wifiDisabled, st.leases, st.nats = wifiDisabled, leases, nats }()
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
			st.rebooted = true
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(st.srv.Close)
	return st
}

func (st *mkState) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(st.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(st.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "mk", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "admin", []byte(password), nil })
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
		if strings.Contains(s, mkPassword) || strings.Contains(s, "TOP-SECRET-KEY") {
			t.Fatalf("%s leaked a secret: %s", what, s)
		}
	}
}

func TestExtendedControls(t *testing.T) {
	st := newMkControls(t)
	d := st.driver(t, "", mkPassword)
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
	noSecret(t, "Settings", s)
	ch, err := d.SetWiFiEnabled(ctx, "wifi:*W1", false)
	if err != nil || st.wifiDisabled != "true" {
		t.Fatalf("wifi toggle failed: err=%v disabled=%s", err, st.wifiDisabled)
	}
	noSecret(t, "SetWiFiEnabled", ch)
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.88.22"); err != nil || len(st.leases) != 2 {
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
	if len(st.leases) != 1 || len(st.nats) != 1 {
		t.Fatalf("expected the original lease and NAT rule only, got %d / %d", len(st.leases), len(st.nats))
	}
	if _, err := d.Reboot(ctx); err != nil || !st.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, st.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("router refuses writes", func(t *testing.T) {
		st := newMkControls(t)
		d := st.driver(t, "", mkPassword)
		st.failWrites = true
		_, err := d.SetWiFiEnabled(ctx, "wifi:*W1", false)
		if !errors.Is(err, router.ErrRejected) {
			t.Fatalf("SetWiFiEnabled: want ErrRejected, got %v", err)
		}
		noSecret(t, "SetWiFiEnabled error", err)
		if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.88.22"); err == nil {
			t.Fatal("AddReservation must fail when the router refuses it")
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Plex", Protocol: "tcp", ExternalStart: 32400, InternalIP: "192.168.88.10"}); err == nil {
			t.Fatal("AddPortForward must fail when the router refuses it")
		}
		if _, err := d.Reboot(ctx); err == nil || st.rebooted {
			t.Fatalf("Reboot must fail and not reboot, got %v", err)
		}
		if st.wifiDisabled != "false" || len(st.leases) != 1 || len(st.nats) != 1 {
			t.Fatal("a refused write must not change the router")
		}
	})

	t.Run("invalid input never reaches the router", func(t *testing.T) {
		st := newMkControls(t)
		d := st.driver(t, "", mkPassword)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "Winbox", Protocol: "tcp", ExternalStart: 22, InternalIP: "192.168.88.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "bad\x00name"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("control characters in a name: want ErrInvalidArgument, got %v", err)
		}
		if len(st.nats) != 1 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		st := newMkControls(t)
		d := st.driver(t, "", "wrong-"+mkPassword)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		st := newMkControls(t)
		d := st.driver(t, strings.Repeat("34", 32), mkPassword)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || st.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}
