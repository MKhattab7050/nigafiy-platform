package omada

import (
	"context"
	"crypto/sha256"
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

type fakeOmada struct {
	mu      sync.Mutex
	cid     string
	csrf    string
	blocked map[string]bool
	limit   map[string]any
	logouts int
	srv     *httptest.Server
}

func newFakeOmada(t *testing.T) *fakeOmada {
	t.Helper()
	f := &fakeOmada{
		cid:     "omada-cid-01",
		csrf:    "omada-csrf-777",
		blocked: map[string]bool{"AA-BB-CC-00-00-02": true},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOmada) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeOmada) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	ok := func(res any) { _ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "msg": "Success.", "result": res}) }

	if r.URL.Path == "/api/info" {
		ok(map[string]any{"omadacId": f.cid, "controllerVer": "5.14.26", "name": "OC200"})
		return
	}
	if r.URL.Path == "/"+f.cid+"/api/v2/login" {
		var b struct{ Username, Password string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Username != "admin" || b.Password != "omada-pass" {
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": -44106, "msg": "Invalid username or password"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "TPLINK_SESSIONID", Value: "sess-1"})
		ok(map[string]any{"token": f.csrf})
		return
	}
	if r.URL.Path == "/"+f.cid+"/api/v2/logout" {
		f.logouts++
		ok(map[string]any{})
		return
	}
	if r.Header.Get("Csrf-Token") != f.csrf {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch {
	case r.URL.Path == "/"+f.cid+"/api/v2/sites":
		ok(map[string]any{"data": []map[string]any{{"id": "site-def", "name": "Default"}}})
	case r.URL.Path == "/"+f.cid+"/api/v2/sites/site-def/clients":
		ok(map[string]any{"data": []map[string]any{
			{"mac": "AA-BB-CC-00-00-01", "ip": "192.168.0.50", "name": "ipad", "wireless": true, "radioId": 1, "ssid": "Office", "rssi": -61, "active": true},
		}})
	case r.URL.Path == "/"+f.cid+"/api/v2/sites/site-def/insight/known-clients":
		var rows []map[string]any
		for m, b := range f.blocked {
			if b {
				rows = append(rows, map[string]any{"mac": m, "name": "blocked-client", "blocked": true})
			}
		}
		ok(map[string]any{"data": rows})
	case strings.HasSuffix(r.URL.Path, "/block"):
		mac := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"+f.cid+"/api/v2/sites/site-def/cmd/clients/"), "/block")
		f.blocked[mac] = true
		ok(map[string]any{})
	case strings.HasSuffix(r.URL.Path, "/unblock"):
		mac := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"+f.cid+"/api/v2/sites/site-def/cmd/clients/"), "/unblock")
		delete(f.blocked, mac)
		ok(map[string]any{})
	case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/"+f.cid+"/api/v2/sites/site-def/clients/"):
		_ = json.NewDecoder(r.Body).Decode(&f.limit)
		ok(map[string]any{})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestOmada(t *testing.T, f *fakeOmada, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "om1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestOmadaEndToEnd(t *testing.T) {
	f := newFakeOmada(t)
	d := openTestOmada(t, f, "omada-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "TP-Link Omada" || info.Model != "OC200" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 1 || clients[0].Connection != router.ConnWiFi5 || *clients[0].SignalDBm != -61 {
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
	rch, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{DownKbps: 15000, UpKbps: 3000})
	if err != nil || !rch.Applied || f.limit == nil {
		t.Fatalf("rate limit: %+v %v", rch, err)
	}
	cch, err := rl.ClearRateLimit(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !cch.Applied {
		t.Fatalf("clear rate limit: %+v %v", cch, err)
	}
	if err := d.Close(ctx); err != nil || f.logouts != 1 {
		t.Fatalf("close: %v logouts=%d", err, f.logouts)
	}
}

func TestOmadaBadAuth(t *testing.T) {
	f := newFakeOmada(t)
	d := openTestOmada(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Clients(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
