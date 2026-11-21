package asus

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

type fakeAsusControls struct {
	mu           sync.Mutex
	nvram        map[string]string
	lastHooks    []string
	lastServices []string
	rebooted     bool
	srv          *httptest.Server
}

func newFakeAsusControls(t *testing.T) *fakeAsusControls {
	t.Helper()
	f := &fakeAsusControls{
		nvram: map[string]string{
			"lan_ipaddr":        "192.168.50.1",
			"lan_netmask":       "255.255.255.0",
			"wan0_ipaddr":       "203.0.113.42",
			"wan0_state_t":      "2",
			"wan0_proto":        "dhcp",
			"wan0_dns":          "1.1.1.1 8.8.8.8",
			"wl0_ssid":          "AsusHome2G",
			"wl0_radio":         "1",
			"wl0_closed":        "0",
			"wl0_auth_mode_x":   "psk2",
			"wl0_wpa_psk":       "asus-top-secret-psk",
			"wl1_ssid":          "AsusHome5G",
			"wl1_radio":         "1",
			"wl1_closed":        "1",
			"wl1_auth_mode_x":   "sae",
			"wl1_wpa_psk":       "asus-5g-secret-psk",
			"wl0.1_ssid":        "AsusGuest",
			"wl0.1_bss_enabled": "1",
			"wl0.1_closed":      "0",
			"wl0.1_auth_mode_x": "psk2",
			"dhcp_staticlist":   "<AA:BB:CC:00:00:10>192.168.50.20>>NAS",
			"vts_rulelist":      "<WebAdmin>8443>192.168.50.20>443>TCP",
			"custom_clientlist": "<OldName>AA:BB:CC:00:00:10>0>0>>",
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAsusControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeAsusControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = r.ParseForm()

	switch r.URL.Path {
	case "/login.cgi":
		want := base64.StdEncoding.EncodeToString([]byte("admin:asus-ctrl-pass"))
		if r.FormValue("login_authorization") != want {
			_ = json.NewEncoder(w).Encode(map[string]string{"error_status": "3"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"asus_token": "tok-ctrl-1"})
	case "/Logout.asp":
		w.WriteHeader(http.StatusOK)
	case "/appGet.cgi":
		if r.Header.Get("Cookie") != "asus_token=tok-ctrl-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		hook := r.FormValue("hook")
		f.lastHooks = append(f.lastHooks, hook)
		out := map[string]any{}
		for k, v := range f.nvram {
			if strings.Contains(hook, "nvram_get("+k+")") {
				out[k] = v
			}
		}
		if strings.Contains(hook, "uptime()") {
			out["uptime"] = map[string]any{"uptime": "7200"}
		}
		_ = json.NewEncoder(w).Encode(out)
	case "/applyapp.cgi":
		if r.Header.Get("Cookie") != "asus_token=tok-ctrl-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		svc := r.FormValue("rc_service")
		f.lastServices = append(f.lastServices, svc)
		if svc == "reboot" {
			f.rebooted = true
		}
		for k, vals := range r.Form {
			if k == "action_mode" || k == "rc_service" || len(vals) == 0 {
				continue
			}
			f.nvram[k] = vals[0]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"modify": "1"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestAsusControls(t *testing.T, f *fakeAsusControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("asus-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "as-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestAsusControls(t *testing.T) {
	f := newFakeAsusControls(t)
	d := openTestAsusControls(t, f)
	ctx := context.Background()

	// Settings read + zero Wi-Fi PSK leakage.
	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.50.1" || settings.Overview.UptimeSeconds == nil || *settings.Overview.UptimeSeconds != 7200 {
		t.Fatalf("unexpected overview: %+v", settings.Overview)
	}
	if len(settings.Overview.WAN) != 1 || settings.Overview.WAN[0].Status != "up" || settings.Overview.WAN[0].IPv4 != "203.0.113.42" || len(settings.Overview.WAN[0].DNS) != 2 {
		t.Fatalf("unexpected WAN: %+v", settings.Overview.WAN)
	}
	if len(settings.WiFi) != 3 || settings.WiFi[0].SSID != "AsusHome2G" || !settings.WiFi[2].Guest {
		t.Fatalf("unexpected WiFi: %+v", settings.WiFi)
	}
	if len(settings.Reservations) != 1 || settings.Reservations[0].MAC != "aa:bb:cc:00:00:10" {
		t.Fatalf("unexpected reservations: %+v", settings.Reservations)
	}
	if len(settings.PortForwards) != 1 || settings.PortForwards[0].ExternalStart != 8443 || settings.PortForwards[0].Owner != router.OwnerAdmin {
		t.Fatalf("unexpected port forwards: %+v", settings.PortForwards)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") {
		t.Fatalf("Wi-Fi secret leaked into Settings JSON: %s", string(rawJSON))
	}
	for _, h := range f.lastHooks {
		if strings.Contains(h, "wpa_psk") {
			t.Fatalf("driver requested Wi-Fi PSK NVRAM key: %q", h)
		}
	}

	// WiFi toggle.
	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "wl0.1", false); err != nil || !ch.Applied {
		t.Fatalf("SetWiFiEnabled: %+v %v", ch, err)
	}
	if f.nvram["wl0.1_bss_enabled"] != "0" {
		t.Fatalf("expected wl0.1_bss_enabled=0, got %q", f.nvram["wl0.1_bss_enabled"])
	}

	// Reservations add + idempotent + remove.
	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.50.55"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.50.55"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || !ch.Applied {
		t.Fatalf("RemoveReservation: %+v %v", ch, err)
	}
	if strings.Contains(f.nvram["dhcp_staticlist"], "192.168.50.55") || !strings.Contains(f.nvram["dhcp_staticlist"], "192.168.50.20") {
		t.Fatalf("unexpected dhcp_staticlist after remove: %q", f.nvram["dhcp_staticlist"])
	}

	// Port forward add + read + remove.
	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description:   router.ProductRulePrefix + "Game",
		Protocol:      router.ProtoBoth,
		ExternalStart: 27015,
		ExternalEnd:   27020,
		InternalStart: 27015,
		InternalEnd:   27020,
		InternalIP:    "192.168.50.55",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, err := sr.Settings(ctx)
	if err != nil || len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards after add, got %+v %v", afterAdd.PortForwards, err)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied {
		t.Fatalf("RemovePortForward: %+v %v", ch, err)
	}
	afterRem, _ := sr.Settings(ctx)
	if len(afterRem.PortForwards) != 1 {
		t.Fatalf("expected 1 port forward after remove, got %+v", afterRem.PortForwards)
	}

	// Rename client.
	rn := d.(router.Renamer)
	if ch, err := rn.RenameClient(ctx, "aa:bb:cc:00:00:10", "Home NAS"); err != nil || !ch.Applied {
		t.Fatalf("RenameClient: %+v %v", ch, err)
	}
	if !strings.Contains(f.nvram["custom_clientlist"], "<Home NAS>AA:BB:CC:00:00:10>") {
		t.Fatalf("unexpected custom_clientlist: %q", f.nvram["custom_clientlist"])
	}

	// Reboot.
	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}
