package fortigate

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

type fakeFortiGate struct {
	mu     sync.Mutex
	banned map[string]bannedRow
	srv    *httptest.Server
}

func newFakeFortiGate(t *testing.T) *fakeFortiGate {
	t.Helper()
	f := &fakeFortiGate{
		banned: map[string]bannedRow{
			"10.10.0.55": {IPAddress: "10.10.0.55", Cause: "IPS", Source: "ips"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeFortiGate) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeFortiGate) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer fg-api-token-xyz" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")

	switch r.URL.Path {
	case "/api/v2/monitor/system/status":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": "v7.4.4", "build": 2662, "serial": "FG60FTEST123", "status": "success",
			"results": map[string]any{"model": "FG60F", "model_name": "FortiGate-60F", "hostname": "hq-fw"},
		})
	case "/api/v2/monitor/user/device/query":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"mac": "aa:bb:cc:00:00:01", "ipv4_address": "10.10.0.50", "hostname": "finance-pc", "detected_interface": "internal", "is_online": true},
				{"mac": "aa:bb:cc:00:00:02", "ipv4_address": "10.10.0.55", "hostname": "suspect", "detected_interface": "internal", "is_online": true},
			},
		})
	case "/api/v2/monitor/system/dhcp":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"ip": "10.10.0.50", "mac": "aa:bb:cc:00:00:01", "hostname": "finance-pc", "interface": "internal", "expire_time": time.Now().Add(2 * time.Hour).Unix(), "reserved": false},
			},
		})
	case "/api/v2/monitor/user/banned/select":
		rows := []bannedRow{}
		for _, b := range f.banned {
			rows = append(rows, b)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
	case "/api/v2/monitor/user/banned/add_users":
		var p struct {
			IPs []string `json:"ip_addresses"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		for _, ip := range p.IPs {
			f.banned[ip] = bannedRow{IPAddress: ip, Cause: "Administrative", Source: "admin"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	case "/api/v2/monitor/user/banned/clear_users":
		var p struct {
			IPs []string `json:"ip_addresses"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		for _, ip := range p.IPs {
			delete(f.banned, ip)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestFG(t *testing.T, f *fakeFortiGate, token string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "api", []byte(token), nil }
	d, err := router.Open(
		router.Target{ID: "fg1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestFortiGateEndToEnd(t *testing.T) {
	f := newFakeFortiGate(t)
	d := openTestFG(t, f, "fg-api-token-xyz")
	ctx := context.Background()
	defer d.Close(ctx)

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "Fortinet" || info.Model != "FortiGate-60F" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Lease == nil || clients[0].Lease.Remaining == nil {
		t.Errorf("expected DHCP lease on client 0: %+v", clients[0])
	}
	if clients[1].Blocked == nil || !*clients[1].Blocked {
		t.Errorf("IPS banned client should be marked blocked: %+v", clients[1])
	}

	// Pre-banned IPS entry returns AlreadyInEffect.
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:02")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-banned: %+v %v", pre, err)
	}

	// Ban & unban client 0.
	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied {
		t.Fatalf("block: %+v %v", ch, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
}

func TestFortiGateBadToken(t *testing.T) {
	f := newFakeFortiGate(t)
	d := openTestFG(t, f, "bad-token")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
