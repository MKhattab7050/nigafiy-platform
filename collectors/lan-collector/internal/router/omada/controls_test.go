package omada

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

const (
	omPassword = "omada-ctl-pass-9054"
	omToken    = "omada-csrf-token-secret-1177"
)

// omState is the Omada controller API test double's state, served over TLS with its own
// self-signed certificate (the driver reaches it through the pinned-certificate transport).
type omState struct {
	ssidOn     bool
	pfs        []map[string]any
	rebooted   bool
	renamed    string
	loggedIn   bool
	failWrites bool
	srv        *httptest.Server
}

func newOmControls(t *testing.T) *omState {
	st := &omState{ssidOn: true, pfs: []map[string]any{}}
	st.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(res any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "msg": "Success.", "result": res})
		}
		if r.URL.Path == "/om1/api/v2/login" {
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["username"] != "admin" || b["password"] != omPassword {
				_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": -44106, "msg": "Invalid username or password."})
				return
			}
			st.loggedIn = true
			ok(map[string]any{"token": omToken})
			return
		}
		if r.URL.Path != "/api/info" && (!st.loggedIn || r.Header.Get("Csrf-Token") != omToken) {
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": -1200, "msg": "Login required"})
			return
		}
		if st.failWrites && r.Method != http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": -33004, "msg": "The device is busy, try again later."})
			return
		}
		ssidOn, pfs, rebooted, renamed := st.ssidOn, st.pfs, st.rebooted, st.renamed
		defer func() { st.ssidOn, st.pfs, st.rebooted, st.renamed = ssidOn, pfs, rebooted, renamed }()
		switch {
		case r.URL.Path == "/api/info":
			ok(map[string]any{"omadacId": "om1", "controllerVer": "5.14", "name": "OC200"})
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
	t.Cleanup(st.srv.Close)
	return st
}

func (st *omState) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(st.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(st.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "om", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
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
		for _, secret := range []string{omPassword, omToken, "OMADA-SECRET"} {
			if strings.Contains(s, secret) {
				t.Fatalf("%s leaked a secret: %s", what, s)
			}
		}
	}
}

func TestExtendedControls(t *testing.T) {
	st := newOmControls(t)
	d := st.driver(t, "", omPassword)
	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.WiFi) != 1 || s.WiFi[0].ID != "wl1/ss1" || len(s.Reservations) != 1 {
		t.Fatalf("unexpected settings: %+v", s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.SetWiFiEnabled(ctx, "wl1/ss1", false)
	noSecret(t, "SetWiFiEnabled", ch)
	if err != nil || st.ssidOn {
		t.Fatalf("SetWiFiEnabled failed: %v", err)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.0.22"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "Printer"); err != nil || st.renamed != "Printer" {
		t.Fatalf("RenameClient failed: err=%v renamed=%q", err, st.renamed)
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
	if _, err := d.Reboot(ctx); err != nil || !st.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, st.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("controller refuses writes", func(t *testing.T) {
		st := newOmControls(t)
		d := st.driver(t, "", omPassword)
		st.failWrites = true
		_, err := d.SetWiFiEnabled(ctx, "wl1/ss1", false)
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "busy") {
			t.Fatalf("SetWiFiEnabled: want ErrRejected with the controller's reason, got %v", err)
		}
		noSecret(t, "SetWiFiEnabled error", err)
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "NVR", Protocol: "tcp", ExternalStart: 8554, InternalIP: "192.168.0.10"}); !errors.Is(err, router.ErrRejected) {
			t.Fatalf("AddPortForward: want ErrRejected, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || st.rebooted {
			t.Fatalf("Reboot: want ErrRejected and no reboot, got %v", err)
		}
		if !st.ssidOn || len(st.pfs) != 0 {
			t.Fatal("a refused write must not change the controller")
		}
	})

	t.Run("malformed Wi-Fi id and management port refused before any write", func(t *testing.T) {
		st := newOmControls(t)
		d := st.driver(t, "", omPassword)
		if _, err := d.SetWiFiEnabled(ctx, "ss1", false); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("a malformed SSID id: want ErrInvalidArgument, got %v", err)
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "web", Protocol: "tcp", ExternalStart: 443, InternalIP: "192.168.0.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if !st.ssidOn || len(st.pfs) != 0 {
			t.Fatal("refused input changed the controller")
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		st := newOmControls(t)
		d := st.driver(t, "", "wrong-"+omPassword)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		st := newOmControls(t)
		d := st.driver(t, strings.Repeat("56", 32), omPassword)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || st.rebooted || st.loggedIn {
			t.Fatalf("want ErrCertificate, no login and no reboot, got %v", err)
		}
	})
}
