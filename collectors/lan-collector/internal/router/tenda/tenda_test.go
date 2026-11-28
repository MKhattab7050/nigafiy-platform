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
	// redirectLogin: answer like real Tenda firmware — POST /login/Auth is a 302 (to /main.html with
	// the session cookie on success, to /login.html on failure); a request without a session is a
	// 302 to /login.html.
	redirectLogin bool
	session       string // the accepted session cookie value
	followed      int    // requests for a redirect target (must stay 0: redirects are never followed)
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

	sess := f.session
	if sess == "" {
		sess = "tenda-sess-1"
	}
	if r.URL.Path == "/main.html" || r.URL.Path == "/login.html" {
		f.followed++
		w.WriteHeader(http.StatusOK)
		return
	}
	if f.redirectLogin && r.URL.Path == "/login/Auth" {
		if r.FormValue("password") != base64.StdEncoding.EncodeToString([]byte("tenda-pass")) {
			http.Redirect(w, r, "/login.html?0", http.StatusFound)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "password", Value: sess, Path: "/"})
		http.Redirect(w, r, "/main.html", http.StatusFound)
		return
	}
	if f.redirectLogin && !strings.Contains(r.Header.Get("Cookie"), sess) {
		http.Redirect(w, r, "/login.html", http.StatusFound)
		return
	}
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
	if !strings.Contains(r.Header.Get("Cookie"), sess) {
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

// Real Tenda firmware answers the login with a 302 that carries the session cookie.
func TestTendaRedirectLogin(t *testing.T) {
	ctx := context.Background()
	f := newFakeTenda(t)
	f.redirectLogin = true
	d := openTestTenda(t, f, "tenda-pass")
	info, err := d.Identify(ctx)
	if err != nil || info.Model != "AC10" {
		t.Fatalf("302 login: %+v %v", info, err)
	}
	// The session expires; the router sends data calls to the login page → one new login.
	f.mu.Lock()
	f.session = "tenda-sess-2"
	f.mu.Unlock()
	if ch, err := d.Block(ctx, "aa:bb:cc:00:00:01"); err != nil || !ch.Applied {
		t.Fatalf("block after the session expired: %+v %v", ch, err)
	}
	if err := d.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if f.followed != 0 {
		t.Fatalf("a redirect was followed %d times", f.followed)
	}

	bad := newFakeTenda(t)
	bad.redirectLogin = true
	d2 := openTestTenda(t, bad, "wrong")
	defer d2.Close(ctx)
	if _, err := d2.Identify(ctx); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("302 back to the login page: want ErrBadCredentials, got %v", err)
	}
	if bad.followed != 0 {
		t.Fatalf("a redirect was followed %d times", bad.followed)
	}
}
