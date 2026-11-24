package huaweilte

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
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

type fakeHiLinkControls struct {
	mu       sync.Mutex
	token    string
	wifiEn   map[string]string
	servers  []hiLinkVS
	rebooted bool
	srv      *httptest.Server
}

func newFakeHiLinkControls(t *testing.T) *fakeHiLinkControls {
	t.Helper()
	f := &fakeHiLinkControls{
		token:  "hl-ctrl-tok-1",
		wifiEn: map[string]string{"0": "1", "1": "1"},
		servers: []hiLinkVS{
			{Status: "1", Name: "AdminSSH", Proto: "6", WanPort: "2222", IP: "192.168.8.50", LanPort: "22"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHiLinkControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeHiLinkControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "text/xml")

	switch r.URL.Path {
	case "/api/webserver/SesTokInfo":
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><response><SesInfo>SessionID=sid-c1</SesInfo><TokInfo>` + f.token + `</TokInfo></response>`))
	case "/api/user/login":
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Username string `xml:"Username"`
			Password string `xml:"Password"`
		}
		_ = xml.Unmarshal(raw, &req)
		if req.Username != "admin" || req.Password != hiLinkPasswordType4("admin", []byte("hl-ctrl-pass"), f.token) {
			_, _ = w.Write([]byte(`<?xml version="1.0"?><error><code>108006</code></error>`))
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "SessionID", Value: "sid-ctrl-ok"})
		w.Header().Set("__RequestVerificationToken", "hl-ctrl-tok-2")
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/user/logout":
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/dhcp/settings":
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response><DhcpIPAddress>192.168.8.1</DhcpIPAddress></response>`))
	case "/api/monitoring/status":
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response><ConnectionStatus>901</ConnectionStatus><WanIPAddress>100.64.5.12</WanIPAddress><PrimaryDns>1.1.1.1</PrimaryDns><SecondaryDns>8.8.8.8</SecondaryDns></response>`))
	case "/api/wlan/multi-basic-settings":
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(fmt.Sprintf(`<?xml version="1.0"?><response><Ssids>
				<Ssid><Index>0</Index><ID>wlan2g</ID><WifiEnable>%s</WifiEnable><WifiSsid>B535_Home</WifiSsid><WifiHide>0</WifiHide><WifiAuthmode>WPA2-PSK</WifiAuthmode><WifiWpaPreSharedKey>hilink-secret-psk</WifiWpaPreSharedKey></Ssid>
				<Ssid><Index>1</Index><ID>wlan5g</ID><WifiEnable>%s</WifiEnable><WifiSsid>B535_5G</WifiSsid><WifiHide>1</WifiHide><WifiAuthmode>WPA2-PSK</WifiAuthmode></Ssid>
			</Ssids></response>`, f.wifiEn["0"], f.wifiEn["1"])))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Ssids []struct {
				Index      string `xml:"Index"`
				WifiEnable string `xml:"WifiEnable"`
			} `xml:"Ssids>Ssid"`
		}
		_ = xml.Unmarshal(raw, &req)
		for _, s := range req.Ssids {
			f.wifiEn[s.Index] = s.WifiEnable
		}
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/security/virtual-servers":
		if r.Method == http.MethodGet {
			body := strings.Replace(string(renderVirtualServers(f.servers)), "<request>", "<response>", 1)
			body = strings.Replace(body, "</request>", "</response>", 1)
			_, _ = w.Write([]byte(body))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Servers []hiLinkVS `xml:"Servers>Server"`
		}
		_ = xml.Unmarshal(raw, &req)
		f.servers = req.Servers
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/device/control":
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), "<Control>1</Control>") {
			f.rebooted = true
		}
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestHiLinkControls(t *testing.T, f *fakeHiLinkControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("hl-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "hl-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestHuaweiLTEControls(t *testing.T) {
	f := newFakeHiLinkControls(t)
	d := openTestHiLinkControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.8.1" || len(settings.Overview.WAN) != 1 || settings.Overview.WAN[0].Status != "up" {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.WiFi) != 2 || settings.WiFi[0].SSID != "B535_Home" || !settings.WiFi[1].Hidden {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	if len(settings.PortForwards) != 1 || settings.PortForwards[0].ExternalStart != 2222 {
		t.Fatalf("port forwards: %+v", settings.PortForwards)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "hilink-secret-psk") {
		t.Fatalf("Wi-Fi PSK leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "1", false); err != nil || !ch.Applied || f.wifiEn["1"] != "0" {
		t.Fatalf("SetWiFiEnabled: %+v %v wifiEn=%v", ch, err, f.wifiEn)
	}

	pf := d.(router.PortForwarder)
	// HiLink rejects port ranges.
	if _, err := pf.AddPortForward(ctx, router.PortForward{
		Description: "Range", Protocol: router.ProtoTCP,
		ExternalStart: 8000, ExternalEnd: 8005, InternalStart: 8000, InternalEnd: 8005, InternalIP: "192.168.8.100",
	}); !errors.Is(err, router.ErrInvalidArgument) {
		t.Fatalf("expected ErrInvalidArgument for range, got %v", err)
	}
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description: router.ProductRulePrefix + "HTTPS", Protocol: router.ProtoTCP,
		ExternalStart: 8443, ExternalEnd: 8443, InternalStart: 443, InternalEnd: 443, InternalIP: "192.168.8.100",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied || len(f.servers) != 1 {
		t.Fatalf("RemovePortForward: %+v %v servers=%+v", ch, err, f.servers)
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
	if _, ok := any((*Driver)(nil)).(router.ReservationManager); ok {
		t.Fatal("HiLink has no documented static-DHCP write; reservations must not be offered")
	}
}
