package unifi

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

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	ufPassword = "unifi-ctl-pass-2290"
	ufToken    = "unifi-session-cookie-secret-6604"
	ufCSRF     = "unifi-csrf-secret-3315"
)

// ufState is the UniFi Network API test double's state, served over TLS with its own self-signed
// certificate (the driver reaches it through the pinned-certificate transport).
type ufState struct {
	wlanEnabled bool
	users       []map[string]any
	pfs         []map[string]any
	rebooted    bool
	failWrites  bool
	srv         *httptest.Server
}

func newUfControls(t *testing.T) *ufState {
	st := &ufState{}
	wlanEnabled := true
	users := []map[string]any{
		{"_id": "u1", "mac": "aa:bb:cc:00:00:10", "name": "Server", "use_fixedip": true, "fixed_ip": "192.168.1.10"},
	}
	pfs := []map[string]any{}
	st.wlanEnabled, st.users, st.pfs = wlanEnabled, users, pfs
	st.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(data any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": data})
		}
		if r.URL.Path == "/api/auth/login" {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if str(b["username"]) != "admin" || str(b["password"]) != ufPassword {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{"errors": []string{"Invalid username or password"}})
				return
			}
			w.Header().Set("X-Csrf-Token", ufCSRF)
			http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: ufToken})
			_ = json.NewEncoder(w).Encode(map[string]any{"unique_id": "1"})
			return
		}
		if c, err := r.Cookie("TOKEN"); err != nil || c.Value != ufToken || (r.Method != http.MethodGet && r.Header.Get("X-CSRF-Token") != ufCSRF) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if st.failWrites && r.Method != http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "error", "msg": "api.err.InvalidPayload"}, "data": []any{}})
			return
		}
		wlanEnabled, users, pfs, rebooted := st.wlanEnabled, st.users, st.pfs, st.rebooted
		defer func() { st.wlanEnabled, st.users, st.pfs, st.rebooted = wlanEnabled, users, pfs, rebooted }()
		switch {
		case r.URL.Path == "/proxy/network/api/self/sites":
			ok([]map[string]any{{"name": "default"}})
		case r.URL.Path == "/proxy/network/api/s/default/stat/device":
			ok([]map[string]any{{"type": "udm", "mac": "00:11:22:33:44:55", "ip": "192.168.1.1", "uptime": 7200, "wan1": map[string]any{"up": true, "ip": "41.1.2.3", "dns": []string{"1.1.1.1"}}}})
		case r.URL.Path == "/proxy/network/api/s/default/stat/sta":
			ok([]map[string]any{{"mac": "aa:bb:cc:00:00:10", "essid": "CorpWiFi"}})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/wlanconf":
			ok([]map[string]any{{"_id": "w1", "name": "CorpWiFi", "enabled": wlanEnabled, "wlan_band": "5g", "x_passphrase": "UNIFI-SECRET-KEY"}})
		case r.Method == http.MethodPut && r.URL.Path == "/proxy/network/api/s/default/rest/wlanconf/w1":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			wlanEnabled = boolOf(b["enabled"])
			ok([]map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/user":
			ok(users)
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/rest/user":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["_id"] = "u2"
			users = append(users, b)
			ok([]map[string]any{b})
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/user/"):
			id := strings.TrimPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/user/")
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			for _, u := range users {
				if str(u["_id"]) == id {
					for k, v := range b {
						u[k] = v
					}
				}
			}
			ok([]map[string]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/proxy/network/api/s/default/rest/portforward":
			ok(pfs)
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/rest/portforward":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			b["_id"] = "pf1"
			pfs = append(pfs, b)
			ok([]map[string]any{b})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/proxy/network/api/s/default/rest/portforward/"):
			pfs = nil
			ok([]map[string]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/proxy/network/api/s/default/cmd/devmgr":
			rebooted = true
			ok([]map[string]any{})
		default:
			ok([]map[string]any{})
		}
	}))
	t.Cleanup(st.srv.Close)
	return st
}

func (st *ufState) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(st.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(st.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "uf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
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
		for _, secret := range []string{ufPassword, ufToken, ufCSRF, "UNIFI-SECRET-KEY"} {
			if strings.Contains(s, secret) {
				t.Fatalf("%s leaked a secret: %s", what, s)
			}
		}
	}
}

func TestExtendedControls(t *testing.T) {
	st := newUfControls(t)
	d := st.driver(t, "", ufPassword)
	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.WiFi) != 1 || len(s.WiFi[0].ClientMACs) != 1 || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: %+v", s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.SetWiFiEnabled(ctx, "w1", false)
	noSecret(t, "SetWiFiEnabled", ch)
	if err != nil || st.wlanEnabled {
		t.Fatalf("SetWiFiEnabled failed: %v", err)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.1.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "CoreDB"); err != nil {
		t.Fatalf("RenameClient failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "WireGuard", Protocol: "udp", ExternalStart: 51820, InternalIP: "192.168.1.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 {
		t.Fatalf("expected 1 pf, got %d", len(s2.PortForwards))
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if _, err := d.Reboot(ctx); err != nil || !st.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, st.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("controller refuses writes", func(t *testing.T) {
		st := newUfControls(t)
		d := st.driver(t, "", ufPassword)
		st.failWrites = true
		_, err := d.SetWiFiEnabled(ctx, "w1", false)
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "InvalidPayload") {
			t.Fatalf("SetWiFiEnabled: want ErrRejected with the controller's reason, got %v", err)
		}
		noSecret(t, "SetWiFiEnabled error", err)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "WireGuard", Protocol: "udp", ExternalStart: 51820, InternalIP: "192.168.1.10"}); !errors.Is(err, router.ErrRejected) {
			t.Fatalf("AddPortForward: want ErrRejected, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || st.rebooted {
			t.Fatalf("Reboot: want ErrRejected and no reboot, got %v", err)
		}
		if !st.wlanEnabled || len(st.pfs) != 0 || len(st.users) != 1 {
			t.Fatal("a refused write must not change the controller")
		}
	})

	t.Run("invalid input never reaches the controller", func(t *testing.T) {
		st := newUfControls(t)
		d := st.driver(t, "", ufPassword)
		if _, err := d.AddReservation(ctx, "01:00:5e:00:00:01", "192.168.1.22"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("multicast MAC: want ErrInvalidArgument, got %v", err)
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "ssh", Protocol: "tcp", ExternalStart: 22, InternalIP: "192.168.1.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if len(st.pfs) != 0 || len(st.users) != 1 {
			t.Fatal("refused input changed the controller")
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		st := newUfControls(t)
		d := st.driver(t, "", "wrong-"+ufPassword)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		st := newUfControls(t)
		d := st.driver(t, strings.Repeat("9a", 32), ufPassword)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || st.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}
