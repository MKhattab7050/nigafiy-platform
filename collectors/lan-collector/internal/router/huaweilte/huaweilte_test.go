package huaweilte

import (
	"context"
	"crypto/sha256"
	"encoding/xml"
	"errors"
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

type fakeHiLink struct {
	mu      sync.Mutex
	token   string
	ssids   []ssidFilter
	logouts int
	srv     *httptest.Server
}

func newFakeHiLink(t *testing.T) *fakeHiLink {
	t.Helper()
	f := &fakeHiLink{
		token: "hilink-tok-1",
		ssids: []ssidFilter{
			{Index: "0", Status: "2", MACs: [10]string{"AA:BB:CC:00:00:02"}},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHiLink) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeHiLink) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "text/xml")

	switch r.URL.Path {
	case "/api/webserver/SesTokInfo":
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><response><SesInfo>SessionID=sid-1</SesInfo><TokInfo>` + f.token + `</TokInfo></response>`))
	case "/api/user/login":
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Username string `xml:"Username"`
			Password string `xml:"Password"`
		}
		_ = xml.Unmarshal(raw, &req)
		want := hiLinkPasswordType4("admin", []byte("b535-pass"), f.token)
		if req.Username != "admin" || req.Password != want {
			_, _ = w.Write([]byte(`<?xml version="1.0"?><error><code>108006</code></error>`))
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "SessionID", Value: "sid-authed"})
		w.Header().Set("__RequestVerificationToken", "hilink-tok-2")
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/user/logout":
		f.logouts++
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	case "/api/device/information":
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response><DeviceName>B535-232</DeviceName><SoftwareVersion>10.0.1.1(H191SP21C983)</SoftwareVersion><HardwareVersion>WL1B535M</HardwareVersion></response>`))
	case "/api/wlan/host-list":
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response><Hosts>
			<Host><ID>1</ID><MacAddress>AA:BB:CC:00:00:01</MacAddress><IpAddress>192.168.8.100</IpAddress><HostName>iphone-15</HostName><Active>1</Active></Host>
			<Host><ID>2</ID><MacAddress>AA:BB:CC:00:00:02</MacAddress><IpAddress>192.168.8.101</IpAddress><HostName>guest</HostName><Active>0</Active></Host>
		</Hosts></response>`))
	case "/api/wlan/multi-macfilter-settings":
		if r.Method == http.MethodGet {
			xmlBody := strings.Replace(string(renderMultiMacFilter(f.ssids)), "<request>", "<response>", 1)
			xmlBody = strings.Replace(xmlBody, "</request>", "</response>", 1)
			_, _ = w.Write([]byte(xmlBody))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		ssids, _ := parseMultiMacFilter(raw)
		f.ssids = ssids
		_, _ = w.Write([]byte(`<?xml version="1.0"?><response>OK</response>`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestHiLink(t *testing.T, f *fakeHiLink, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "hl1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestHuaweiLTEEndToEnd(t *testing.T) {
	f := newFakeHiLink(t)
	d := openTestHiLink(t, f, "b535-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Model != "B535-232" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 || clients[1].Blocked == nil || !*clients[1].Blocked {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:02")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
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

func TestHuaweiLTEWhitelistRefusedAndBadAuth(t *testing.T) {
	f := newFakeHiLink(t)
	f.ssids[0].Status = "1" // whitelist mode
	d := openTestHiLink(t, f, "b535-pass")
	if _, err := d.Block(context.Background(), "aa:bb:cc:00:00:01"); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("want ErrRejected in whitelist mode, got %v", err)
	}
	_ = d.Close(context.Background())

	bad := openTestHiLink(t, f, "wrong")
	defer bad.Close(context.Background())
	if _, err := bad.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
