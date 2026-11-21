package tenda

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

type fakeTendaControls struct {
	mu       sync.Mutex
	wifi2gEn string
	wifi5gEn string
	statics  []map[string]any
	vss      []map[string]any
	rebooted bool
	srv      *httptest.Server
}

func newFakeTendaControls(t *testing.T) *fakeTendaControls {
	t.Helper()
	f := &fakeTendaControls{
		wifi2gEn: "true",
		wifi5gEn: "true",
		statics: []map[string]any{
			{"mac": "aa:bb:cc:00:00:10", "ip": "192.168.0.20"},
		},
		vss: []map[string]any{
			{"ip": "192.168.0.20", "lanPort": "80", "wanPort": "8080", "protocol": "TCP", "remark": "AdminHTTP"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTendaControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeTendaControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	w.Header().Set("Content-Type", "application/json")

	if r.URL.Path == "/login/Auth" {
		if r.FormValue("password") != base64.StdEncoding.EncodeToString([]byte("td-ctrl-pass")) {
			_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 1})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "password", Value: "td-ctrl-sess"})
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
		return
	}
	if r.URL.Path == "/goform/loginOut" {
		w.WriteHeader(http.StatusOK)
		return
	}
	if !strings.Contains(r.Header.Get("Cookie"), "td-ctrl-sess") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch r.URL.Path {
	case "/goform/getStatus":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"lanStatus": map[string]any{"lanIP": "192.168.0.1"},
			"internetStatus": map[string]any{
				"uptime":         "21600",
				"wanIP":          "198.51.100.88",
				"wanStatus":      "connected",
				"wanConnectType": "dhcp",
				"wanDns1":        "1.1.1.1",
				"wanDns2":        "8.8.8.8",
			},
		})
	case "/goform/getWifi":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"wifiBasicCfg": map[string]any{
				"wifiSSID":           "Tenda_2G",
				"wifiEn":             f.wifi2gEn,
				"wifiHideSSID":       "false",
				"wifiSecurityMode":   "wpawpa2/aes",
				"wifiPwd":            "tenda-secret-psk",
				"wifi5gSSID":         "Tenda_5G",
				"wifi5gEn":           f.wifi5gEn,
				"wifi5gHideSSID":     "true",
				"wifi5gSecurityMode": "wpawpa2/aes",
				"wifi5gPwd":          "tenda-5g-psk",
			},
		})
	case "/goform/setWifiBasicCfg":
		if v := r.FormValue("wifiEn"); v != "" {
			f.wifi2gEn = v
		}
		if v := r.FormValue("wifi5gEn"); v != "" {
			f.wifi5gEn = v
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	case "/goform/getStaticIP":
		_ = json.NewEncoder(w).Encode(map[string]any{"staticList": f.statics})
	case "/goform/setStaticIP":
		var next []map[string]any
		for _, line := range strings.Split(r.FormValue("list"), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			parts := strings.Split(line, "\t")
			if len(parts) >= 2 {
				next = append(next, map[string]any{"ip": parts[0], "mac": parts[1]})
			}
		}
		f.statics = next
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	case "/goform/getVirtualServer":
		_ = json.NewEncoder(w).Encode(map[string]any{"virtualList": f.vss})
	case "/goform/setVirtualServer":
		var next []map[string]any
		for _, line := range strings.Split(r.FormValue("list"), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			parts := strings.Split(line, "\t")
			if len(parts) >= 5 {
				next = append(next, map[string]any{
					"ip": parts[0], "lanPort": parts[1], "wanPort": parts[2], "protocol": parts[3], "remark": parts[4],
				})
			}
		}
		f.vss = next
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	case "/goform/sysReboot":
		if r.FormValue("action") == "reboot" {
			f.rebooted = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestTendaControls(t *testing.T, f *fakeTendaControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("td-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "td-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestTendaControls(t *testing.T) {
	f := newFakeTendaControls(t)
	d := openTestTendaControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.0.1" || settings.Overview.UptimeSeconds == nil || *settings.Overview.UptimeSeconds != 21600 {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.WiFi) != 2 || settings.WiFi[0].SSID != "Tenda_2G" || !settings.WiFi[1].Hidden {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") || strings.Contains(string(rawJSON), "tenda-5g-psk") {
		t.Fatalf("Wi-Fi PSK leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "5g", false); err != nil || !ch.Applied || f.wifi5gEn != "false" {
		t.Fatalf("SetWiFiEnabled: %+v %v wifi5gEn=%q", ch, err, f.wifi5gEn)
	}

	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:88", "192.168.0.88"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:88", "192.168.0.88"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:88"); err != nil || !ch.Applied || len(f.statics) != 1 {
		t.Fatalf("RemoveReservation: %+v %v statics=%+v", ch, err, f.statics)
	}

	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description: router.ProductRulePrefix + "Stream", Protocol: router.ProtoBoth,
		ExternalStart: 7000, ExternalEnd: 7010, InternalStart: 7000, InternalEnd: 7010, InternalIP: "192.168.0.88",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied || len(f.vss) != 1 {
		t.Fatalf("RemovePortForward: %+v %v vss=%+v", ch, err, f.vss)
	}

	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}
