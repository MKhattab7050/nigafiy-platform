package mikrotik

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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

type fakeROS struct {
	mu      sync.Mutex
	user    string
	pass    string
	nextID  int
	filters []map[string]any
	queues  []map[string]any
	srv     *httptest.Server
}

func newFakeROS(t *testing.T) *fakeROS {
	t.Helper()
	f := &fakeROS{
		user:   "admin",
		pass:   "mikrotik-secret",
		nextID: 10,
		filters: []map[string]any{
			{".id": "*1", "chain": "forward", "src-mac-address": "AA:BB:CC:00:00:03", "action": "drop", "comment": "Admin manual block", "disabled": "false"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeROS) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeROS) handle(w http.ResponseWriter, r *http.Request) {
	u, p, ok := r.BasicAuth()
	if !ok || u != f.user || p != f.pass {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": 401, "message": "Unauthorized"})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/rest/system/resource":
		_ = json.NewEncoder(w).Encode(map[string]any{"board-name": "hAP ax2", "version": "7.15.3 (stable)", "architecture-name": "arm64", "uptime": "3d2h10m"})
	case r.Method == http.MethodGet && r.URL.Path == "/rest/system/routerboard":
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "C52iG-5HaxD2HaxD", "serial-number": "HE808TEST"})
	case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/dhcp-server/lease":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{".id": "*1", "address": "192.168.88.20", "mac-address": "AA:BB:CC:00:00:01", "host-name": "laptop-1", "status": "bound", "dynamic": "true", "expires-after": "8m30s", "server": "dhcp1"},
			{".id": "*2", "address": "192.168.88.22", "mac-address": "AA:BB:CC:00:00:03", "host-name": "rogue-phone", "status": "bound", "dynamic": "false", "expires-after": "1h"},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/rest/ip/arp":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{".id": "*1", "address": "192.168.88.21", "mac-address": "AA:BB:CC:00:00:02", "interface": "bridge", "complete": "true", "dhcp": "false"},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/rest/interface/wifi/registration-table":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{".id": "*0", "mac-address": "AA:BB:CC:00:00:01", "interface": "wifi1", "ssid": "Office-5G", "band": "5ghz-ax", "signal": "-58"},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/rest/interface/wireless/registration-table":
		w.WriteHeader(http.StatusNotFound)
	case r.URL.Path == "/rest/ip/firewall/filter" && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(f.filters)
	case r.URL.Path == "/rest/ip/firewall/filter" && r.Method == http.MethodPut:
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		f.nextID++
		m[".id"] = fmt.Sprintf("*%X", f.nextID)
		m["disabled"] = "false"
		f.filters = append(f.filters, m)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(m)
	case strings.HasPrefix(r.URL.Path, "/rest/ip/firewall/filter/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(r.URL.Path, "/rest/ip/firewall/filter/")
		f.filters = deleteByID(f.filters, id)
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/rest/queue/simple" && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(f.queues)
	case r.URL.Path == "/rest/queue/simple" && r.Method == http.MethodPut:
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		f.nextID++
		m[".id"] = fmt.Sprintf("*%X", f.nextID)
		f.queues = append(f.queues, m)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(m)
	case strings.HasPrefix(r.URL.Path, "/rest/queue/simple/") && r.Method == http.MethodPatch:
		id := strings.TrimPrefix(r.URL.Path, "/rest/queue/simple/")
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		for _, q := range f.queues {
			if q[".id"] == id {
				for k, v := range m {
					q[k] = v
				}
			}
		}
		_ = json.NewEncoder(w).Encode(m)
	case strings.HasPrefix(r.URL.Path, "/rest/queue/simple/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(r.URL.Path, "/rest/queue/simple/")
		f.queues = deleteByID(f.queues, id)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func deleteByID(in []map[string]any, id string) []map[string]any {
	out := in[:0]
	for _, m := range in {
		if m[".id"] != id {
			out = append(out, m)
		}
	}
	return out
}

func openTestDriver(t *testing.T, f *fakeROS, user, pass string) (router.Driver, *[][]byte) {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	var given [][]byte
	creds := func(context.Context) (string, []byte, error) {
		b := []byte(pass)
		given = append(given, b)
		return user, b, nil
	}
	d, err := router.Open(
		router.Target{ID: "mk1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d, &given
}

func TestMikroTikEndToEnd(t *testing.T) {
	f := newFakeROS(t)
	d, given := openTestDriver(t, f, "admin", "mikrotik-secret")
	ctx := context.Background()
	defer d.Close(ctx)

	info, err := d.Identify(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.Vendor != "MikroTik" || info.Model != "C52iG-5HaxD2HaxD" || info.Firmware != "7.15.3 (stable)" {
		t.Fatalf("unexpected info: %+v", info)
	}
	// Password slice must be zeroed immediately after auth header creation.
	for _, b := range *given {
		for _, x := range b {
			if x != 0 {
				t.Fatal("password slice was not zeroed")
			}
		}
	}

	clients, err := d.Clients(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(clients) != 3 {
		t.Fatalf("want 3 clients, got %d: %+v", len(clients), clients)
	}
	if clients[0].MAC != "aa:bb:cc:00:00:01" || clients[0].Connection != router.ConnWiFi5 || clients[0].SignalDBm == nil || *clients[0].SignalDBm != -58 {
		t.Errorf("laptop client: %+v", clients[0])
	}
	if clients[0].Lease == nil || clients[0].Lease.Source != "dhcp" || clients[0].Lease.Remaining == nil || *clients[0].Lease.Remaining != 8*time.Minute+30*time.Second {
		t.Errorf("laptop lease: %+v", clients[0].Lease)
	}
	if clients[1].Connection != router.ConnWired || clients[1].Lease == nil || clients[1].Lease.Source != "static" {
		t.Errorf("arp-only client: %+v", clients[1])
	}
	if clients[2].Blocked == nil || !*clients[2].Blocked {
		t.Errorf("pre-blocked client should be marked blocked: %+v", clients[2])
	}

	// Pre-existing admin block must not be claimed or lifted.
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-existing block: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not remove admin rule: %+v %v", unPre, err)
	}

	// Block & unblock managed device.
	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || ch.AlreadyInEffect {
		t.Fatalf("block failed: %+v %v", ch, err)
	}
	blocked, err := d.Blocked(ctx)
	if err != nil || len(blocked) != 2 {
		t.Fatalf("blocked list: %+v %v", blocked, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock failed: %+v %v", un, err)
	}

	// Rate limit (upload/download order).
	rl := d.(router.RateLimiter)
	rch, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{DownKbps: 20000, UpKbps: 5000})
	if err != nil || !rch.Applied {
		t.Fatalf("rate limit failed: %+v %v", rch, err)
	}
	if len(f.queues) != 1 || f.queues[0]["max-limit"] != "5000k/20000k" || f.queues[0]["target"] != "192.168.88.20/32" {
		t.Fatalf("unexpected queue: %+v", f.queues)
	}
	cch, err := rl.ClearRateLimit(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !cch.Applied || len(f.queues) != 0 {
		t.Fatalf("clear rate limit: %+v %v queues=%v", cch, err, f.queues)
	}

	// Schedule (including midnight crossover split).
	sc := d.(router.Scheduler)
	sch, err := sc.SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: []time.Weekday{time.Monday, time.Tuesday}, Start: "22:00", End: "07:00"}})
	if err != nil || !sch.Applied {
		t.Fatalf("schedule failed: %+v %v", sch, err)
	}
	csch, err := sc.ClearSchedule(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !csch.Applied {
		t.Fatalf("clear schedule: %+v %v", csch, err)
	}
}

func TestMikroTikBadCredentials(t *testing.T) {
	f := newFakeROS(t)
	d, _ := openTestDriver(t, f, "admin", "wrong-pass")
	defer d.Close(context.Background())
	_, err := d.Identify(context.Background())
	if !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
