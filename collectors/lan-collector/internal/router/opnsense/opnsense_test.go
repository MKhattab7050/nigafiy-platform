package opnsense

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

type fakeOPNsense struct {
	mu          sync.Mutex
	aliasExists bool
	aliasIPs    map[string]bool
	srv         *httptest.Server
}

func newFakeOPNsense(t *testing.T) *fakeOPNsense {
	t.Helper()
	f := &fakeOPNsense{aliasIPs: map[string]bool{}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOPNsense) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeOPNsense) handle(w http.ResponseWriter, r *http.Request) {
	k, s, ok := r.BasicAuth()
	if !ok || k != "opn-key" || s != "opn-secret" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")

	switch r.URL.Path {
	case "/api/core/firmware/info":
		_ = json.NewEncoder(w).Encode(map[string]any{"product_name": "OPNsense", "product_version": "24.7.10", "product_abi": "24.7"})
	case "/api/diagnostics/interface/getArp":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"mac": "aa:bb:cc:00:00:01", "ip": "10.0.0.10", "intf": "igb1", "intf_description": "LAN", "hostname": "workstation", "expired": false},
		})
	case "/api/dhcpv4/leases/searchLease":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"rows": []map[string]any{
				{"address": "10.0.0.10", "mac": "aa:bb:cc:00:00:01", "hostname": "workstation", "type": "dynamic", "status": "online"},
				{"address": "10.0.0.11", "mac": "aa:bb:cc:00:00:02", "hostname": "printer", "type": "static", "status": "offline"},
			},
		})
	case "/api/firewall/alias_util/aliases":
		names := []string{"bogons"}
		if f.aliasExists {
			names = append(names, blockAlias)
		}
		_ = json.NewEncoder(w).Encode(names)
	case "/api/firewall/alias/addItem":
		f.aliasExists = true
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "saved"})
	case "/api/firewall/alias/reconfigure":
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	case "/api/firewall/alias_util/list/" + blockAlias:
		if !f.aliasExists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		rows := []map[string]string{}
		for ip := range f.aliasIPs {
			rows = append(rows, map[string]string{"ip": ip})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": rows, "total": len(rows)})
	case "/api/firewall/alias_util/add/" + blockAlias:
		var b struct{ Address string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.aliasIPs[b.Address] = true
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "done"})
	case "/api/firewall/alias_util/delete/" + blockAlias:
		var b struct{ Address string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		delete(f.aliasIPs, b.Address)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "done"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestOPNsense(t *testing.T, f *fakeOPNsense, secret string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "opn-key", []byte(secret), nil }
	d, err := router.Open(
		router.Target{ID: "opn1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestOPNsenseEndToEnd(t *testing.T) {
	f := newFakeOPNsense(t)
	d := openTestOPNsense(t, f, "opn-secret")
	ctx := context.Background()
	defer d.Close(ctx)

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "OPNsense" || info.Firmware != "24.7.10" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Hostname != "workstation" || clients[1].Lease == nil || clients[1].Lease.Source != "reserved" {
		t.Errorf("unexpected clients: %+v", clients)
	}

	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || !f.aliasExists {
		t.Fatalf("block: %+v %v", ch, err)
	}
	again, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || again.Applied || !again.AlreadyInEffect {
		t.Fatalf("second block: %+v %v", again, err)
	}
	blocked, err := d.Blocked(ctx)
	if err != nil || len(blocked) != 1 || blocked[0].MAC != "aa:bb:cc:00:00:01" {
		t.Fatalf("blocked: %+v %v", blocked, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
}

func TestOPNsenseBadAuth(t *testing.T) {
	f := newFakeOPNsense(t)
	d := openTestOPNsense(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
