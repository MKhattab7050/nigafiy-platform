package tplink

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

type fakeTPLinkControls struct {
	mu       sync.Mutex
	key      *rsa.PrivateKey
	stok     string
	wifi     map[string]map[string]any
	res      []tpResRow
	vs       []tpVSRow
	nextID   int
	rebooted bool
	srv      *httptest.Server
}

func newFakeTPLinkControls(t *testing.T) *fakeTPLinkControls {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeTPLinkControls{
		key:    k,
		stok:   "stok-ctrl-5678",
		nextID: 10,
		wifi: map[string]map[string]any{
			"wireless_2g": {"ssid": "Archer_2G", "enable": "on", "hidden": "off", "encryption": "psk", "psk_key": "tplink-secret-psk"},
			"wireless_5g": {"ssid": "Archer_5G", "enable": "on", "hidden": "on", "encryption": "psk", "psk_key": "tplink-5g-psk"},
			"guest_2g":    {"ssid": "Archer_Guest", "enable": "on", "hidden": "off", "encryption": "psk"},
			"guest_5g":    {"ssid": "", "enable": "off"},
		},
		res: []tpResRow{
			{Key: "r-1", MAC: "AA-BB-CC-00-00-10", IP: "192.168.0.20", Enable: "on"},
		},
		vs: []tpVSRow{
			{Key: "vs-1", Name: "AdminHTTP", Enable: "on", Protocol: "TCP", ExternalPort: "8080", InternalIP: "192.168.0.20", InternalPort: "80"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTPLinkControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeTPLinkControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	w.Header().Set("Content-Type", "application/json")
	op := r.FormValue("operation")
	form := r.URL.Query().Get("form")

	if strings.HasPrefix(r.URL.Path, "/cgi-bin/luci/;stok=/login") {
		if op == "read" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data":    map[string]any{"password": []string{fmt.Sprintf("%x", f.key.N), fmt.Sprintf("%x", f.key.E)}},
			})
			return
		}
		ct, err := hex.DecodeString(r.FormValue("password"))
		plain, derr := rsa.DecryptPKCS1v15(rand.Reader, f.key, ct)
		if err != nil || derr != nil || string(plain) != "tp-ctrl-pass" {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errorcode": "login failed"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "sysauth", Value: "tp-ctrl-cookie"})
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{"stok": f.stok}})
		return
	}

	prefix := "/cgi-bin/luci/;stok=" + f.stok
	if !strings.HasPrefix(r.URL.Path, prefix) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, prefix)

	switch {
	case rel == "/admin/system" && form == "logout":
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	case rel == "/admin/system" && form == "reboot":
		f.rebooted = true
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	case rel == "/admin/status" && form == "all":
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{
			"lan_ipv4_ipaddr":   "192.168.0.1",
			"uptime":            "36000",
			"wan_ipv4_ipaddr":   "198.51.100.5",
			"wan_ipv4_conntype": "dhcp",
			"wan_ipv4_pridns":   "1.1.1.1",
			"wan_ipv4_snddns":   "9.9.9.9",
		}})
	case rel == "/admin/wireless":
		entry, ok := f.wifi[form]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if op == "write" {
			entry["enable"] = r.FormValue("enable")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": entry})
	case rel == "/admin/dhcps" && form == "reservation":
		switch op {
		case "load":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": f.res})
		case "insert":
			var row tpResRow
			_ = json.Unmarshal([]byte(r.FormValue("new")), &row)
			f.nextID++
			row.Key = fmt.Sprintf("r-%d", f.nextID)
			f.res = append(f.res, row)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": row})
		case "remove":
			key := r.FormValue("key")
			var kept []tpResRow
			for _, x := range f.res {
				if x.Key != key {
					kept = append(kept, x)
				}
			}
			f.res = kept
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	case rel == "/admin/nat" && form == "vs":
		switch op {
		case "load":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": f.vs})
		case "insert":
			var row tpVSRow
			_ = json.Unmarshal([]byte(r.FormValue("new")), &row)
			f.nextID++
			row.Key = fmt.Sprintf("vs-%d", f.nextID)
			f.vs = append(f.vs, row)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": row})
		case "remove":
			key := r.FormValue("key")
			var kept []tpVSRow
			for _, x := range f.vs {
				if x.Key != key {
					kept = append(kept, x)
				}
			}
			f.vs = kept
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestTPLinkControls(t *testing.T, f *fakeTPLinkControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("tp-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "tp-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestTPLinkControls(t *testing.T) {
	f := newFakeTPLinkControls(t)
	d := openTestTPLinkControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.0.1" || settings.Overview.UptimeSeconds == nil || *settings.Overview.UptimeSeconds != 36000 {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.WiFi) != 3 || settings.WiFi[0].SSID != "Archer_2G" || !settings.WiFi[1].Hidden || !settings.WiFi[2].Guest {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") || strings.Contains(string(rawJSON), "tplink-5g-psk") {
		t.Fatalf("Wi-Fi PSK leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "guest_2g", false); err != nil || !ch.Applied || f.wifi["guest_2g"]["enable"] != "off" {
		t.Fatalf("SetWiFiEnabled: %+v %v", ch, err)
	}

	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:66", "192.168.0.66"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:66", "192.168.0.66"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:66"); err != nil || !ch.Applied || len(f.res) != 1 {
		t.Fatalf("RemoveReservation: %+v %v res=%+v", ch, err, f.res)
	}

	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description: router.ProductRulePrefix + "App", Protocol: router.ProtoBoth,
		ExternalStart: 9000, ExternalEnd: 9005, InternalStart: 9000, InternalEnd: 9005, InternalIP: "192.168.0.66",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied || len(f.vs) != 1 {
		t.Fatalf("RemovePortForward: %+v %v vs=%+v", ch, err, f.vs)
	}

	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}

// No documented vendor interface: the control stays unsupported (the capability note says why) and
// the driver does not implement it, so nothing can be sent.
func TestUndocumentedControlsNotOffered(t *testing.T) {
	if _, ok := any((*Driver)(nil)).(router.Renamer); ok {
		t.Fatal("rename has no documented interface on this firmware and must not be offered")
	}
}
