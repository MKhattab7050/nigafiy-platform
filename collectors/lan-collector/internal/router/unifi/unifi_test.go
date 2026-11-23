package unifi

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

type fakeUniFi struct {
	mu      sync.Mutex
	unifiOS bool
	csrf    string
	blocked map[string]bool
	logouts int
	srv     *httptest.Server
}

func newFakeUniFi(t *testing.T, unifiOS bool) *fakeUniFi {
	t.Helper()
	f := &fakeUniFi{
		unifiOS: unifiOS,
		csrf:    "csrf-tok-999",
		blocked: map[string]bool{"aa:bb:cc:00:00:03": true},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeUniFi) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeUniFi) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")

	// Auth endpoints
	if r.URL.Path == "/api/auth/login" {
		if !f.unifiOS {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var b struct{ Username, Password string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Username != "admin" || b.Password != "unifi-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "Invalid credentials"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: "jwt-cookie"})
		w.Header().Set("X-Csrf-Token", f.csrf)
		_ = json.NewEncoder(w).Encode(map[string]any{"unique_id": "u1"})
		return
	}
	if r.URL.Path == "/api/login" && !f.unifiOS {
		var b struct{ Username, Password string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Username != "admin" || b.Password != "unifi-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "unifises", Value: "legacy-ses"})
		w.Header().Set("X-Csrf-Token", f.csrf)
		_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}})
		return
	}
	if r.URL.Path == "/api/auth/logout" || r.URL.Path == "/api/logout" {
		f.logouts++
		w.WriteHeader(http.StatusOK)
		return
	}

	// Verify cookie
	if r.Header.Get("Cookie") == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	prefix := "/api/s/default"
	sitesPath := "/api/self/sites"
	if f.unifiOS {
		prefix = "/proxy/network/api/s/default"
		sitesPath = "/proxy/network/api/self/sites"
	}

	switch r.URL.Path {
	case sitesPath:
		_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": []map[string]any{{"name": "default"}}})
	case prefix + "/stat/sysinfo":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"rc": "ok"},
			"data": []map[string]any{{"version": "8.4.59", "ubnt_device_type": "UDM-Pro"}},
		})
	case prefix + "/stat/sta":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"rc": "ok"},
			"data": []map[string]any{
				{"mac": "aa:bb:cc:00:00:01", "ip": "192.168.1.20", "hostname": "macbook", "is_wired": false, "radio": "na", "essid": "CorpWiFi", "signal": -54},
				{"mac": "aa:bb:cc:00:00:02", "ip": "192.168.1.21", "name": "NAS", "is_wired": true, "network": "LAN"},
			},
		})
	case prefix + "/rest/user":
		users := []map[string]any{
			{"mac": "aa:bb:cc:00:00:01", "hostname": "macbook", "blocked": f.blocked["aa:bb:cc:00:00:01"]},
			{"mac": "aa:bb:cc:00:00:03", "name": "old-phone", "last_ip": "192.168.1.22", "blocked": f.blocked["aa:bb:cc:00:00:03"]},
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": users})
	case prefix + "/cmd/stamgr":
		if r.Header.Get("X-CSRF-Token") != f.csrf {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var b struct{ Cmd, Mac string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		switch b.Cmd {
		case "block-sta":
			f.blocked[strings.ToLower(b.Mac)] = true
		case "unblock-sta":
			f.blocked[strings.ToLower(b.Mac)] = false
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": []any{}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openUniFi(t *testing.T, f *fakeUniFi, pass string) (router.Driver, *[][]byte) {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	var given [][]byte
	creds := func(context.Context) (string, []byte, error) {
		b := []byte(pass)
		given = append(given, b)
		return "admin", b, nil
	}
	d, err := router.Open(
		router.Target{ID: "u1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d, &given
}

func TestUniFiOSAndLegacy(t *testing.T) {
	for _, unifiOS := range []bool{true, false} {
		name := "UniFiOS"
		if !unifiOS {
			name = "Legacy"
		}
		t.Run(name, func(t *testing.T) {
			f := newFakeUniFi(t, unifiOS)
			d, given := openUniFi(t, f, "unifi-secret")
			ctx := context.Background()

			info, err := d.Identify(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if info.Vendor != "Ubiquiti" || info.Model != "UDM-Pro" || info.Firmware != "8.4.59" {
				t.Fatalf("info: %+v", info)
			}
			for _, g := range *given {
				for _, b := range g {
					if b != 0 {
						t.Fatal("password was not zeroed")
					}
				}
			}

			clients, err := d.Clients(ctx)
			if err != nil || len(clients) != 3 {
				t.Fatalf("clients: %+v %v", clients, err)
			}
			if clients[0].Connection != router.ConnWiFi5 || clients[0].SignalDBm == nil || *clients[0].SignalDBm != -54 {
				t.Errorf("wifi client: %+v", clients[0])
			}
			if clients[1].Connection != router.ConnWired {
				t.Errorf("wired client: %+v", clients[1])
			}

			// Pre-blocked client reports AlreadyInEffect.
			pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
			if err != nil || pre.Applied || !pre.AlreadyInEffect {
				t.Fatalf("pre-blocked: %+v %v", pre, err)
			}

			// Block & unblock active client.
			ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
			if err != nil || !ch.Applied || !f.blocked["aa:bb:cc:00:00:01"] {
				t.Fatalf("block: %+v %v", ch, err)
			}
			un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
			if err != nil || !un.Applied || f.blocked["aa:bb:cc:00:00:01"] {
				t.Fatalf("unblock: %+v %v", un, err)
			}

			if err := d.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if f.logouts != 1 {
				t.Errorf("want 1 logout, got %d", f.logouts)
			}
		})
	}
}

func TestUniFiBadCredentials(t *testing.T) {
	f := newFakeUniFi(t, true)
	d, _ := openUniFi(t, f, "bad")
	defer d.Close(context.Background())
	_, err := d.Identify(context.Background())
	if !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
