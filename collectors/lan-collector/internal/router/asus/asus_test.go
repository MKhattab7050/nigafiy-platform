package asus

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
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

type fakeAsus struct {
	mu      sync.Mutex
	nvram   map[string]string
	logouts int
	applies int
	srv     *httptest.Server
}

func newFakeAsus(t *testing.T) *fakeAsus {
	t.Helper()
	f := &fakeAsus{
		nvram: map[string]string{
			"productid":                        "RT-AX88U",
			"firmver":                          "3.0.0.4",
			"buildno":                          "388",
			"extendno":                         "24198",
			"MULTIFILTER_ENABLE":               "2",
			"MULTIFILTER_MAC":                  "AA:BB:CC:00:00:03",
			"MULTIFILTER_DEVICENAME":           "Kid-Tablet",
			"MULTIFILTER_MACFILTER_DAYTIME":    "<",
			"MULTIFILTER_MACFILTER_DAYTIME_V2": "W03E21000700<W04122000800",
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAsus) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeAsus) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = r.ParseForm()

	switch r.URL.Path {
	case "/login.cgi":
		want := base64.StdEncoding.EncodeToString([]byte("admin:asus-pass"))
		if r.FormValue("login_authorization") != want {
			_ = json.NewEncoder(w).Encode(map[string]string{"error_status": "3"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"asus_token": "tok-asus-1"})
	case "/Logout.asp":
		f.logouts++
		w.WriteHeader(http.StatusOK)
	case "/appGet.cgi":
		if r.Header.Get("Cookie") != "asus_token=tok-asus-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		hook := r.FormValue("hook")
		out := map[string]any{}
		for _, k := range []string{"productid", "firmver", "buildno", "extendno", "MULTIFILTER_ENABLE", "MULTIFILTER_MAC", "MULTIFILTER_DEVICENAME", "MULTIFILTER_MACFILTER_DAYTIME", "MULTIFILTER_MACFILTER_DAYTIME_V2"} {
			if strings.Contains(hook, "nvram_get("+k+")") {
				out[k] = f.nvram[k]
			}
		}
		if strings.Contains(hook, "get_clientlist()") {
			out["get_clientlist"] = map[string]any{
				"AA:BB:CC:00:00:01": map[string]any{"ip": "192.168.50.10", "name": "gaming-pc", "isWL": "0", "isOnline": "1"},
				"AA:BB:CC:00:00:02": map[string]any{"ip": "192.168.50.11", "name": "iphone", "isWL": "2", "rssi": "-57", "isOnline": "1"},
				"AA:BB:CC:00:00:03": map[string]any{"ip": "192.168.50.12", "name": "tablet", "isWL": "1", "rssi": "-63", "isOnline": "0"},
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	case "/applyapp.cgi":
		if r.Header.Get("Cookie") != "asus_token=tok-asus-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.applies++
		for _, k := range []string{"MULTIFILTER_ENABLE", "MULTIFILTER_MAC", "MULTIFILTER_DEVICENAME", "MULTIFILTER_MACFILTER_DAYTIME", "MULTIFILTER_MACFILTER_DAYTIME_V2"} {
			if _, ok := r.Form[k]; ok {
				f.nvram[k] = r.FormValue(k)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"modify": "1"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestAsus(t *testing.T, f *fakeAsus, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "as1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAsusEndToEnd(t *testing.T) {
	f := newFakeAsus(t)
	d := openTestAsus(t, f, "asus-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "ASUS" || info.Model != "RT-AX88U" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 3 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Connection != router.ConnWired || clients[1].Connection != router.ConnWiFi5 || *clients[1].SignalDBm != -57 {
		t.Errorf("unexpected connections: %+v", clients)
	}
	if clients[2].Blocked == nil || !*clients[2].Blocked {
		t.Errorf("admin blocked tablet not marked blocked: %+v", clients[2])
	}

	// Admin entry must not be lifted or overwritten.
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not touch admin entry: %+v %v", unPre, err)
	}

	// Managed block + unblock.
	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied {
		t.Fatalf("block: %+v %v", ch, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
	if !strings.Contains(f.nvram["MULTIFILTER_MAC"], "AA:BB:CC:00:00:03") {
		t.Fatalf("admin entry was lost: %q", f.nvram["MULTIFILTER_MAC"])
	}
	if err := d.Close(ctx); err != nil || f.logouts != 1 {
		t.Fatalf("close: %v logouts=%d", err, f.logouts)
	}
}

func TestAsusBadAuth(t *testing.T) {
	f := newFakeAsus(t)
	d := openTestAsus(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
