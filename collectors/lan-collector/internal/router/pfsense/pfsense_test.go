package pfsense

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

	"github.com/lan-detective/lan-collector/internal/router"
)

type fakePfSense struct {
	mu      sync.Mutex
	aliases []pfAlias
	applies int
	srv     *httptest.Server
}

func newFakePfSense(t *testing.T) *fakePfSense {
	t.Helper()
	f := &fakePfSense{}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePfSense) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakePfSense) handle(w http.ResponseWriter, r *http.Request) {
	apiKey := r.Header.Get("X-API-Key")
	u, p, basicOK := r.BasicAuth()
	if apiKey != "pf-api-key-99" && !(basicOK && u == "admin" && p == "pf-pass") {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "message": "Unauthorized"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	ok := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": data}) }

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/system/version":
		ok(map[string]any{"version": "2.7.2-RELEASE", "base": "2.7.2"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/diagnostics/arp_table":
		ok([]map[string]any{
			{"ip_address": "192.168.10.20", "mac_address": "aa:bb:cc:00:00:01", "interface": "lan", "hostname": "dev-pc", "status": "complete"},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/services/dhcp_server/leases":
		ok([]map[string]any{
			{"ip": "192.168.10.20", "mac": "aa:bb:cc:00:00:01", "hostname": "dev-pc", "type": "dynamic", "online_status": "active/online"},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v2/firewall/aliases":
		ok(f.aliases)
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/firewall/alias":
		var a pfAlias
		_ = json.NewDecoder(r.Body).Decode(&a)
		id := len(f.aliases)
		a.ID = &id
		f.aliases = append(f.aliases, a)
		ok(a)
	case r.Method == http.MethodPatch && r.URL.Path == "/api/v2/firewall/alias":
		var a pfAlias
		_ = json.NewDecoder(r.Body).Decode(&a)
		for i := range f.aliases {
			if f.aliases[i].Name == a.Name {
				f.aliases[i].Address = a.Address
				f.aliases[i].Detail = a.Detail
			}
		}
		ok(a)
	case r.Method == http.MethodPost && r.URL.Path == "/api/v2/firewall/apply":
		f.applies++
		ok(map[string]any{"applied": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestPf(t *testing.T, f *fakePfSense, user, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return user, []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "pf1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPfSenseAPIKeyAndBlock(t *testing.T) {
	f := newFakePfSense(t)
	d := openTestPf(t, f, "api-key", "pf-api-key-99")
	ctx := context.Background()
	defer d.Close(ctx)

	info, err := d.Identify(ctx)
	if err != nil || info.Firmware != "2.7.2-RELEASE" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 1 || clients[0].Hostname != "dev-pc" {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || f.applies != 1 {
		t.Fatalf("block: %+v %v applies=%d", ch, err, f.applies)
	}
	blocked, err := d.Blocked(ctx)
	if err != nil || len(blocked) != 1 || blocked[0].MAC != "aa:bb:cc:00:00:01" {
		t.Fatalf("blocked: %+v %v", blocked, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied || f.applies != 2 {
		t.Fatalf("unblock: %+v %v", un, err)
	}
}

func TestPfSenseBasicAndBadAuth(t *testing.T) {
	f := newFakePfSense(t)
	d := openTestPf(t, f, "admin", "pf-pass")
	if _, err := d.Identify(context.Background()); err != nil {
		t.Fatalf("basic auth failed: %v", err)
	}
	_ = d.Close(context.Background())

	bad := openTestPf(t, f, "admin", "nope")
	defer bad.Close(context.Background())
	if _, err := bad.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
