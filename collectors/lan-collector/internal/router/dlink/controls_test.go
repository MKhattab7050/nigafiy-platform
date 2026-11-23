package dlink

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
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

type fakeDLinkRadio struct {
	ssid      string
	enabled   string
	broadcast string
	key       string
}

type fakeDLinkControls struct {
	mu        sync.Mutex
	challenge string
	pubKey    string
	privKey   string
	radios    map[string]*fakeDLinkRadio
	statics   []dlinkStaticRow
	pfs       []dlinkPFRow
	rebooted  bool
	srv       *httptest.Server
}

func newFakeDLinkControls(t *testing.T) *fakeDLinkControls {
	t.Helper()
	ch := "CHALLENGE-CTRL"
	pk := "PUBKEY-CTRL"
	f := &fakeDLinkControls{
		challenge: ch,
		pubKey:    pk,
		privKey:   hmacMD5Upper([]byte(ch), []byte(pk+"dl-ctrl-pass")),
		radios: map[string]*fakeDLinkRadio{
			"RADIO_2.4GHz":       {ssid: "DLink_2G", enabled: "true", broadcast: "true", key: "dlink-secret-psk"},
			"RADIO_5GHz":         {ssid: "DLink_5G", enabled: "true", broadcast: "false", key: "dlink-5g-psk"},
			"RADIO_2.4GHz_Guest": {ssid: "DLink_Guest", enabled: "true", broadcast: "true", key: "dlink-guest-psk"},
		},
		statics: []dlinkStaticRow{
			{Enabled: "true", DeviceName: "NAS", IPAddress: "192.168.0.20", MacAddress: "AA:BB:CC:00:00:10"},
		},
		pfs: []dlinkPFRow{
			{Enabled: "true", Description: "AdminSSH", InternalIP: "192.168.0.20", ProtocolType: "TCP", ExternalPort: "2222", InternalPort: "22"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDLinkControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeDLinkControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "text/xml")
	action := strings.Trim(r.Header.Get("SOAPAction"), `"`)
	action = strings.TrimPrefix(action, hnapNS)
	raw, _ := io.ReadAll(r.Body)

	if action == "Login" {
		var env struct {
			Req struct {
				Action        string `xml:"Action"`
				LoginPassword string `xml:"LoginPassword"`
			} `xml:"Body>Login"`
		}
		_ = xml.Unmarshal(raw, &env)
		if env.Req.Action == "request" {
			_, _ = w.Write(soapEnvelope(fmt.Sprintf(`<LoginResponse xmlns="%s"><LoginResult>OK</LoginResult><Challenge>%s</Challenge><Cookie>uid-ctrl</Cookie><PublicKey>%s</PublicKey></LoginResponse>`, hnapNS, f.challenge, f.pubKey)))
			return
		}
		if env.Req.LoginPassword != hmacMD5Upper([]byte(f.privKey), []byte(f.challenge)) {
			_, _ = w.Write(soapEnvelope(`<LoginResponse><LoginResult>failed</LoginResult></LoginResponse>`))
			return
		}
		_, _ = w.Write(soapEnvelope(`<LoginResponse><LoginResult>OK</LoginResult></LoginResponse>`))
		return
	}

	auth := r.Header.Get("HNAP_AUTH")
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || hmacMD5Upper([]byte(f.privKey), []byte(parts[1]+r.Header.Get("SOAPAction"))) != parts[0] {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch action {
	case "Logout":
		_, _ = w.Write(soapEnvelope(`<LogoutResponse><LogoutResult>OK</LogoutResult></LogoutResponse>`))
	case "GetRouterLanSettings":
		_, _ = w.Write(soapEnvelope(`<GetRouterLanSettingsResponse><RouterIPAddress>192.168.0.1</RouterIPAddress></GetRouterLanSettingsResponse>`))
	case "GetWanStatus":
		_, _ = w.Write(soapEnvelope(`<GetWanStatusResponse><Status>CONNECTED</Status></GetWanStatusResponse>`))
	case "GetWanSettings":
		_, _ = w.Write(soapEnvelope(`<GetWanSettingsResponse><Type>DHCP</Type><IPAddress>198.51.100.77</IPAddress><RuntimeDNS><Primary>1.1.1.1</Primary><Secondary>8.8.8.8</Secondary></RuntimeDNS></GetWanSettingsResponse>`))
	case "GetWLanRadioSettings":
		var env struct {
			Req struct {
				RadioID string `xml:"RadioID"`
			} `xml:"Body>GetWLanRadioSettings"`
		}
		_ = xml.Unmarshal(raw, &env)
		rad, ok := f.radios[env.Req.RadioID]
		if !ok {
			_, _ = w.Write(soapEnvelope(`<GetWLanRadioSettingsResponse><GetWLanRadioSettingsResult>ERROR</GetWLanRadioSettingsResult></GetWLanRadioSettingsResponse>`))
			return
		}
		_, _ = w.Write(soapEnvelope(fmt.Sprintf(`<GetWLanRadioSettingsResponse><GetWLanRadioSettingsResult>OK</GetWLanRadioSettingsResult><Enabled>%s</Enabled><SSID>%s</SSID><SSIDBroadcast>%s</SSIDBroadcast><Key>%s</Key></GetWLanRadioSettingsResponse>`,
			rad.enabled, rad.ssid, rad.broadcast, rad.key)))
	case "SetWLanRadioSettings":
		var env struct {
			Req struct {
				RadioID string `xml:"RadioID"`
				Enabled string `xml:"Enabled"`
				SSID    string `xml:"SSID"`
			} `xml:"Body>SetWLanRadioSettings"`
		}
		_ = xml.Unmarshal(raw, &env)
		if rad, ok := f.radios[env.Req.RadioID]; ok {
			rad.enabled = env.Req.Enabled
			if env.Req.SSID != "" {
				rad.ssid = env.Req.SSID
			}
		}
		_, _ = w.Write(soapEnvelope(`<SetWLanRadioSettingsResponse><SetWLanRadioSettingsResult>OK</SetWLanRadioSettingsResult></SetWLanRadioSettingsResponse>`))
	case "GetStaticDHCPList":
		var b strings.Builder
		b.WriteString(`<GetStaticDHCPListResponse><StaticDHCPList>`)
		for _, r := range f.statics {
			fmt.Fprintf(&b, `<StaticDHCPInfo><Enabled>%s</Enabled><DeviceName>%s</DeviceName><IPAddress>%s</IPAddress><MacAddress>%s</MacAddress></StaticDHCPInfo>`, r.Enabled, r.DeviceName, r.IPAddress, r.MacAddress)
		}
		b.WriteString(`</StaticDHCPList></GetStaticDHCPListResponse>`)
		_, _ = w.Write(soapEnvelope(b.String()))
	case "SetStaticDHCPList":
		var env struct {
			Rows []dlinkStaticRow `xml:"Body>SetStaticDHCPList>StaticDHCPList>StaticDHCPInfo"`
		}
		_ = xml.Unmarshal(raw, &env)
		f.statics = env.Rows
		_, _ = w.Write(soapEnvelope(`<SetStaticDHCPListResponse><SetStaticDHCPListResult>OK</SetStaticDHCPListResult></SetStaticDHCPListResponse>`))
	case "GetPortForwardingSettings":
		var b strings.Builder
		b.WriteString(`<GetPortForwardingSettingsResponse><PortForwardingList>`)
		for _, r := range f.pfs {
			fmt.Fprintf(&b, `<PortForwardingInfo><Enabled>%s</Enabled><PortForwardingDescription>%s</PortForwardingDescription><InternalIPAddress>%s</InternalIPAddress><ProtocolType>%s</ProtocolType><ExternalPort>%s</ExternalPort><InternalPort>%s</InternalPort></PortForwardingInfo>`,
				r.Enabled, r.Description, r.InternalIP, r.ProtocolType, r.ExternalPort, r.InternalPort)
		}
		b.WriteString(`</PortForwardingList></GetPortForwardingSettingsResponse>`)
		_, _ = w.Write(soapEnvelope(b.String()))
	case "SetPortForwardingSettings":
		var env struct {
			Rows []dlinkPFRow `xml:"Body>SetPortForwardingSettings>PortForwardingList>PortForwardingInfo"`
		}
		_ = xml.Unmarshal(raw, &env)
		f.pfs = env.Rows
		_, _ = w.Write(soapEnvelope(`<SetPortForwardingSettingsResponse><SetPortForwardingSettingsResult>OK</SetPortForwardingSettingsResult></SetPortForwardingSettingsResponse>`))
	case "Reboot":
		f.rebooted = true
		_, _ = w.Write(soapEnvelope(`<RebootResponse><RebootResult>OK</RebootResult></RebootResponse>`))
	}
}

func openTestDLinkControls(t *testing.T, f *fakeDLinkControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("dl-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "dl-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestDLinkControls(t *testing.T) {
	f := newFakeDLinkControls(t)
	d := openTestDLinkControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.0.1" || len(settings.Overview.WAN) != 1 || settings.Overview.WAN[0].Status != "up" {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.WiFi) != 3 || settings.WiFi[0].SSID != "DLink_2G" || !settings.WiFi[1].Hidden || !settings.WiFi[2].Guest {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") || strings.Contains(string(rawJSON), "dlink-5g-psk") {
		t.Fatalf("Wi-Fi key leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "RADIO_2.4GHz_Guest", false); err != nil || !ch.Applied {
		t.Fatalf("SetWiFiEnabled: %+v %v", ch, err)
	}
	if f.radios["RADIO_2.4GHz_Guest"].enabled != "false" || f.radios["RADIO_2.4GHz_Guest"].ssid != "DLink_Guest" {
		t.Fatalf("unexpected guest radio state: %+v", f.radios["RADIO_2.4GHz_Guest"])
	}

	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:77", "192.168.0.77"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:77", "192.168.0.77"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:77"); err != nil || !ch.Applied || len(f.statics) != 1 {
		t.Fatalf("RemoveReservation: %+v %v statics=%+v", ch, err, f.statics)
	}

	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description: router.ProductRulePrefix + "Media", Protocol: router.ProtoBoth,
		ExternalStart: 32400, ExternalEnd: 32400, InternalStart: 32400, InternalEnd: 32400, InternalIP: "192.168.0.77",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied || len(f.pfs) != 1 {
		t.Fatalf("RemovePortForward: %+v %v pfs=%+v", ch, err, f.pfs)
	}

	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}
