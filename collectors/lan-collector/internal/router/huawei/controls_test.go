package huawei

import (
	"context"
	"crypto/sha256"
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

	"github.com/nigafiy/sensor/internal/router"
)

type fakeHuaweiControls struct {
	mu          sync.Mutex
	saltHex     string
	iterations  int
	firstNonce  string
	serverNonce string
	wlans       []map[string]any
	staticDHCP  []hwStaticDHCP
	portMaps    []hwPortMap
	renamed     map[string]string
	rebooted    bool
	srv         *httptest.Server
}

func newFakeHuaweiControls(t *testing.T) *fakeHuaweiControls {
	t.Helper()
	f := &fakeHuaweiControls{
		saltHex:     "0102030405060708090a0b0c0d0e0f10",
		iterations:  100,
		serverNonce: "servernonce1234567890abcdef",
		wlans: []map[string]any{
			{"ID": "1", "SSID": "WE_Home", "Enable": true, "FrequencyBand": "2.4GHz", "SSIDAdvertisementEnabled": true, "BeaconType": "WPA2PSK", "PreSharedKey": "huawei-secret-psk"},
			{"ID": "2", "SSID": "WE_Guest_5G", "Enable": true, "FrequencyBand": "5GHz", "IsGuest": true, "SSIDAdvertisementEnabled": false, "BeaconType": "WPA2PSK", "PreSharedKey": "huawei-guest-psk"},
		},
		staticDHCP: []hwStaticDHCP{
			{ID: "1", MACAddress: "AA:BB:CC:00:00:10", IPAddress: "192.168.1.20", Enable: true},
		},
		portMaps: []hwPortMap{
			{ID: "1", Enable: true, Description: "SSH", Protocol: "TCP", ExternalPort: 2222, ExternalPortEndRange: 2222, InternalPort: 22, InternalClient: "192.168.1.20"},
		},
		renamed: map[string]string{},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHuaweiControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeHuaweiControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch r.URL.Path {
	case "/":
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><meta name="csrf_param" content="p1"/><meta name="csrf_token" content="t1"/></head></html>`))
	case "/api/system/user_login_nonce":
		var req struct {
			Data struct {
				FirstNonce string `json:"firstnonce"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.firstNonce = req.Data.FirstNonce
		_ = json.NewEncoder(w).Encode(map[string]any{
			"err": 0, "salt": f.saltHex, "iterations": f.iterations,
			"servernonce": f.serverNonce, "csrf_param": "p2", "csrf_token": "t2",
		})
	case "/api/system/user_login_proof":
		var req struct {
			Data struct {
				ClientProof string `json:"clientproof"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		want, _ := huaweiClientProof([]byte("hw-ctrl-pass"), f.saltHex, f.iterations, f.firstNonce, f.serverNonce)
		if req.Data.ClientProof != want {
			_ = json.NewEncoder(w).Encode(map[string]any{"err": 1})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "SessionID_R3", Value: "hw-ctrl-sess"})
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p3", "csrf_token": "t3"})
	case "/api/system/user_logout":
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0})
	case "/api/system/deviceinfo":
		if !strings.Contains(r.Header.Get("Cookie"), "SessionID_R3=hw-ctrl-sess") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`while(1); /*{"DeviceName":"DG8045","UpTime":86400}*/`))
	case "/api/ntwk/lan_host":
		_ = json.NewEncoder(w).Encode(map[string]any{"IPAddress": "192.168.1.1"})
	case "/api/ntwk/wan":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"Name": "INTERNET", "ConnectionStatus": "Connected", "AccessType": "VDSL", "ExternalIPAddress": "197.55.1.10", "DNSServers": "1.1.1.1, 8.8.8.8"},
		})
	case "/api/ntwk/WlanBasic":
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(f.wlans)
			return
		}
		var req struct {
			Data struct {
				ID     string `json:"ID"`
				Enable bool   `json:"Enable"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		for _, wl := range f.wlans {
			if wl["ID"] == req.Data.ID {
				wl["Enable"] = req.Data.Enable
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p4", "csrf_token": "t4"})
	case "/api/ntwk/lan_dhcp_static":
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(f.staticDHCP)
			return
		}
		var req struct {
			Data []hwStaticDHCP `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.staticDHCP = req.Data
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p5", "csrf_token": "t5"})
	case "/api/ntwk/portmapping":
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(f.portMaps)
			return
		}
		var req struct {
			Data []hwPortMap `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.portMaps = req.Data
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p6", "csrf_token": "t6"})
	case "/api/system/HostInfo":
		var req struct {
			Data struct {
				MACAddress string `json:"MACAddress"`
				HostName   string `json:"HostName"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.renamed[req.Data.MACAddress] = req.Data.HostName
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p7", "csrf_token": "t7"})
	case "/api/service/reboot.cgi":
		f.rebooted = true
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestHuaweiControls(t *testing.T, f *fakeHuaweiControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("hw-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "hw-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestHuaweiControls(t *testing.T) {
	f := newFakeHuaweiControls(t)
	d := openTestHuaweiControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.1.1" || settings.Overview.UptimeSeconds == nil || *settings.Overview.UptimeSeconds != 86400 {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.Overview.WAN) != 1 || settings.Overview.WAN[0].Status != "up" || len(settings.Overview.WAN[0].DNS) != 2 {
		t.Fatalf("wan: %+v", settings.Overview.WAN)
	}
	if len(settings.WiFi) != 2 || settings.WiFi[0].SSID != "WE_Home" || !settings.WiFi[1].Guest || !settings.WiFi[1].Hidden {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") || strings.Contains(string(rawJSON), "guest-psk") {
		t.Fatalf("Wi-Fi PSK leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "2", false); err != nil || !ch.Applied {
		t.Fatalf("SetWiFiEnabled: %+v %v", ch, err)
	}
	if f.wlans[1]["Enable"] != false {
		t.Fatalf("expected wlan 2 disabled, got %+v", f.wlans[1])
	}

	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:55", "192.168.1.55"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:55", "192.168.1.55"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:55"); err != nil || !ch.Applied {
		t.Fatalf("RemoveReservation: %+v %v", ch, err)
	}
	if len(f.staticDHCP) != 1 {
		t.Fatalf("expected 1 static DHCP row remaining, got %+v", f.staticDHCP)
	}

	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description:   router.ProductRulePrefix + "Web",
		Protocol:      router.ProtoTCP,
		ExternalStart: 8080,
		ExternalEnd:   8081,
		InternalStart: 8080,
		InternalEnd:   8081,
		InternalIP:    "192.168.1.55",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied {
		t.Fatalf("RemovePortForward: %+v %v", ch, err)
	}
	if len(f.portMaps) != 1 {
		t.Fatalf("expected 1 port map remaining, got %+v", f.portMaps)
	}

	rn := d.(router.Renamer)
	if ch, err := rn.RenameClient(ctx, "aa:bb:cc:00:00:10", "MediaServer"); err != nil || !ch.Applied {
		t.Fatalf("RenameClient: %+v %v", ch, err)
	}
	if f.renamed["AA:BB:CC:00:00:10"] != "MediaServer" {
		t.Fatalf("expected renamed host, got %+v", f.renamed)
	}

	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}
