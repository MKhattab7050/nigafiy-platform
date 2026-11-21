package dlink

import (
	"context"
	"crypto/sha256"
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

	"github.com/lan-detective/lan-collector/internal/router"
)

type fakeDLink struct {
	mu        sync.Mutex
	challenge string
	pubKey    string
	privKey   string
	filters   macFilterInfo
	logouts   int
	srv       *httptest.Server
}

func newFakeDLink(t *testing.T) *fakeDLink {
	t.Helper()
	ch := "CHALLENGE999"
	pk := "PUBKEY123"
	f := &fakeDLink{
		challenge: ch,
		pubKey:    pk,
		privKey:   hmacMD5Upper([]byte(ch), []byte(pk+"dlink-pass")),
		filters: macFilterInfo{
			Enabled:     true,
			IsAllowList: false,
			Entries:     []macFilterEntry{{MacAddress: "AA:BB:CC:00:00:03", DeviceName: "AdminBlock"}},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDLink) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeDLink) handle(w http.ResponseWriter, r *http.Request) {
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
				Username      string `xml:"Username"`
				LoginPassword string `xml:"LoginPassword"`
			} `xml:"Body>Login"`
		}
		_ = xml.Unmarshal(raw, &env)
		if env.Req.Action == "request" {
			_, _ = w.Write(soapEnvelope(fmt.Sprintf(`<LoginResponse xmlns="%s"><LoginResult>OK</LoginResult><Challenge>%s</Challenge><Cookie>uid-1</Cookie><PublicKey>%s</PublicKey></LoginResponse>`, hnapNS, f.challenge, f.pubKey)))
			return
		}
		want := hmacMD5Upper([]byte(f.privKey), []byte(f.challenge))
		if env.Req.LoginPassword != want {
			_, _ = w.Write(soapEnvelope(fmt.Sprintf(`<LoginResponse xmlns="%s"><LoginResult>failed</LoginResult></LoginResponse>`, hnapNS)))
			return
		}
		_, _ = w.Write(soapEnvelope(fmt.Sprintf(`<LoginResponse xmlns="%s"><LoginResult>OK</LoginResult></LoginResponse>`, hnapNS)))
		return
	}

	// Verify HNAP_AUTH
	auth := r.Header.Get("HNAP_AUTH")
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || hmacMD5Upper([]byte(f.privKey), []byte(parts[1]+r.Header.Get("SOAPAction"))) != parts[0] {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch action {
	case "Logout":
		f.logouts++
		_, _ = w.Write(soapEnvelope(`<LogoutResponse><LogoutResult>OK</LogoutResult></LogoutResponse>`))
	case "GetDeviceSettings":
		_, _ = w.Write(soapEnvelope(`<GetDeviceSettingsResponse><VendorName>D-Link</VendorName><ModelName>DIR-878</ModelName><FirmwareVersion>1.30B08</FirmwareVersion></GetDeviceSettingsResponse>`))
	case "GetClientInfo":
		_, _ = w.Write(soapEnvelope(`<GetClientInfoResponse><ClientInfoLists>
			<ClientInfo><MacAddress>AA:BB:CC:00:00:01</MacAddress><IPv4Address>192.168.0.50</IPv4Address><DeviceName>laptop</DeviceName><Type>WiFi_5G</Type></ClientInfo>
			<ClientInfo><MacAddress>AA:BB:CC:00:00:03</MacAddress><IPv4Address>192.168.0.51</IPv4Address><DeviceName>blocked</DeviceName><Type>LAN</Type></ClientInfo>
		</ClientInfoLists></GetClientInfoResponse>`))
	case "GetMACFilters2":
		var b strings.Builder
		fmt.Fprintf(&b, `<GetMACFilters2Response><Enabled>%v</Enabled><IsAllowList>%v</IsAllowList><MACList>`, f.filters.Enabled, f.filters.IsAllowList)
		for _, e := range f.filters.Entries {
			fmt.Fprintf(&b, `<MACInfo><MacAddress>%s</MacAddress><DeviceName>%s</DeviceName></MACInfo>`, e.MacAddress, e.DeviceName)
		}
		b.WriteString(`</MACList></GetMACFilters2Response>`)
		_, _ = w.Write(soapEnvelope(b.String()))
	case "SetMACFilters2":
		var env struct {
			Req struct {
				Enabled     string           `xml:"Enabled"`
				IsAllowList string           `xml:"IsAllowList"`
				Entries     []macFilterEntry `xml:"MACList>MACInfo"`
			} `xml:"Body>SetMACFilters2"`
		}
		_ = xml.Unmarshal(raw, &env)
		f.filters = macFilterInfo{
			Enabled:     strings.EqualFold(env.Req.Enabled, "true"),
			IsAllowList: strings.EqualFold(env.Req.IsAllowList, "true"),
			Entries:     env.Req.Entries,
		}
		_, _ = w.Write(soapEnvelope(`<SetMACFilters2Response><SetMACFilters2Result>OK</SetMACFilters2Result></SetMACFilters2Response>`))
	}
}

func openTestDLink(t *testing.T, f *fakeDLink, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "dl1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestDLinkEndToEnd(t *testing.T) {
	f := newFakeDLink(t)
	d := openTestDLink(t, f, "dlink-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "D-Link" || info.Model != "DIR-878" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 || clients[0].Connection != router.ConnWiFi5 || !*clients[1].Blocked {
		t.Fatalf("clients: %+v %v", clients, err)
	}

	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not touch admin rule: %+v %v", unPre, err)
	}

	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied {
		t.Fatalf("block: %+v %v", ch, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
	if err := d.Close(ctx); err != nil || f.logouts != 1 {
		t.Fatalf("close: %v logouts=%d", err, f.logouts)
	}
}

func TestDLinkBadAuth(t *testing.T) {
	f := newFakeDLink(t)
	d := openTestDLink(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
