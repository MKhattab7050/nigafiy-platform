package tenda

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

type fakeTenda struct {
	mu      sync.Mutex
	blocked map[string]bool
	lastQos string
	logouts int
	srv     *httptest.Server
}

func newFakeTenda(t *testing.T) *fakeTenda {
	t.Helper()
	f := &fakeTenda{
		blocked: map[string]bool{"aa:bb:cc:00:00:02": true},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTenda) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeTenda) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	w.Header().Set("Content-Type", "application/json")

	if r.URL.Path == "/login/Auth" {
		if r.FormValue("password") != base64.StdEncoding.EncodeToString([]byte("tenda-pass")) {
			_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 1})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "password", Value: "tenda-sess-1"})
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
		return
	}
	if r.URL.Path == "/goform/loginOut" {
		f.logouts++
		w.WriteHeader(http.StatusOK)
		return
	}
	if !strings.Contains(r.Header.Get("Cookie"), "tenda-sess-1") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch r.URL.Path {
	case "/goform/getSysTools":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sysVersion": map[string]string{"product": "AC10", "softVersion": "V15.03.06.47"},
		})
	case "/goform/getQos":
		var bl []map[string]any
		for m, b := range f.blocked {
			if b {
				bl = append(bl, map[string]any{"qosListMac": m, "qosListDevName": "blocked-dev"})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"onlineList": []map[string]any{
				{"qosListMac": "aa:bb:cc:00:00:01", "qosListIP": "192.168.0.10", "qosListDevName": "phone", "qosListConnectType": "2", "qosListAccess": "true"},
			},
			"blackList": bl,
		})
	case "/goform/setQos":
		f.lastQos = r.FormValue("qosList")
		parts := strings.Split(f.lastQos, "\t")
		if len(parts) >= 5 && parts[4] == "false" {
			f.blocked[strings.ToLower(parts[0])] = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	case "/goform/delBlackRule":
		delete(f.blocked, strings.ToLower(r.FormValue("mac")))
		_ = json.NewEncoder(w).Encode(map[string]any{"errCode": 0})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestTenda(t *testing.T, f *fakeTenda, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "td1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestTendaEndToEnd(t *testing.T) {
	f := newFakeTenda(t)
	d := openTestTenda(t, f, "tenda-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "Tenda" || info.Model != "AC10" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 || clients[0].Connection != router.ConnWiFi5 {
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
	rl := d.(router.RateLimiter)
	rch, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{DownKbps: 8000, UpKbps: 2000})
	if err != nil || !rch.Applied || !strings.Contains(f.lastQos, "250\t1000\ttrue") {
		t.Fatalf("rate limit: %+v %v lastQos=%q", rch, err, f.lastQos)
	}
	cch, err := rl.ClearRateLimit(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !cch.Applied {
		t.Fatalf("clear rate limit: %+v %v", cch, err)
	}
	if err := d.Close(ctx); err != nil || f.logouts != 1 {
		t.Fatalf("close: %v logouts=%d", err, f.logouts)
	}
}

func TestTendaBadAuth(t *testing.T) {
	f := newFakeTenda(t)
	d := openTestTenda(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
