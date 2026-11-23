package openwrt

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

type fakeOpenWrt struct {
	mu       sync.Mutex
	token    string
	nextSec  int
	rules    map[string]map[string]any
	commits  int
	reloads  int
	destroys int
	srv      *httptest.Server
}

func newFakeOpenWrt(t *testing.T) *fakeOpenWrt {
	t.Helper()
	f := &fakeOpenWrt{
		token:   "ubus-tok-1234567890",
		nextSec: 10,
		rules: map[string]map[string]any{
			"cfg01": {".type": "rule", "name": "Admin Block", "src": "lan", "dest": "wan", "src_mac": "AA:BB:CC:00:00:03", "target": "REJECT", "enabled": "1"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOpenWrt) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeOpenWrt) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ubus" || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var req struct {
		ID     int   `json:"id"`
		Params []any `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	sess, _ := req.Params[0].(string)
	obj, _ := req.Params[1].(string)
	meth, _ := req.Params[2].(string)
	args, _ := req.Params[3].(map[string]any)

	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")

	reply := func(code int, body any) {
		res := []any{code}
		if body != nil {
			res = append(res, body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": res})
	}

	if obj == "session" && meth == "login" {
		if args["username"] == "root" && args["password"] == "owrt-secret" {
			reply(0, map[string]any{"ubus_rpc_session": f.token})
		} else {
			reply(ubusStatusPermDenied, nil)
		}
		return
	}
	if sess != f.token {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32002, "message": "Access denied"}})
		return
	}

	switch obj + "." + meth {
	case "session.destroy":
		f.destroys++
		reply(0, nil)
	case "system.board":
		reply(0, map[string]any{
			"model": "GL.iNet GL-MT6000", "kernel": "6.6.47", "hostname": "OpenWrt",
			"release": map[string]any{"distribution": "OpenWrt", "version": "24.10.0", "description": "OpenWrt 24.10.0"},
		})
	case "luci-rpc.getDHCPLeases":
		reply(0, map[string]any{"dhcp_leases": []map[string]any{
			{"ipaddr": "192.168.1.50", "macaddr": "aa:bb:cc:00:00:01", "hostname": "pixel", "expires": 3600},
			{"ipaddr": "192.168.1.52", "macaddr": "aa:bb:cc:00:00:03", "hostname": "blocked-box", "expires": 1200},
		}})
	case "luci-rpc.getHostHints":
		reply(0, map[string]any{
			"aa:bb:cc:00:00:02": map[string]any{"name": "desktop", "ipaddrs": []string{"192.168.1.51"}},
		})
	case "iwinfo.devices":
		reply(0, map[string]any{"devices": []string{"phy1-ap0"}})
	case "iwinfo.assoclist":
		reply(0, map[string]any{"results": []map[string]any{{"mac": "AA:BB:CC:00:00:01", "signal": -62}}})
	case "uci.get":
		reply(0, map[string]any{"values": f.rules})
	case "uci.add":
		f.nextSec++
		id := fmt.Sprintf("cfg%02d", f.nextSec)
		sec := map[string]any{".type": "rule"}
		if vals, ok := args["values"].(map[string]any); ok {
			for k, v := range vals {
				sec[k] = v
			}
		}
		f.rules[id] = sec
		reply(0, map[string]any{"section": id})
	case "uci.set":
		id, _ := args["section"].(string)
		if sec, ok := f.rules[id]; ok {
			if vals, ok := args["values"].(map[string]any); ok {
				for k, v := range vals {
					sec[k] = v
				}
			}
		}
		reply(0, nil)
	case "uci.delete":
		id, _ := args["section"].(string)
		delete(f.rules, id)
		reply(0, nil)
	case "uci.commit":
		f.commits++
		reply(0, nil)
	case "luci.setInitAction":
		f.reloads++
		reply(0, nil)
	default:
		reply(ubusStatusNotFound, nil)
	}
}

func openTestOWrt(t *testing.T, f *fakeOpenWrt, pass string) (router.Driver, *[][]byte) {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	var given [][]byte
	creds := func(context.Context) (string, []byte, error) {
		b := []byte(pass)
		given = append(given, b)
		return "root", b, nil
	}
	d, err := router.Open(
		router.Target{ID: "ow1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d, &given
}

func TestOpenWrtEndToEnd(t *testing.T) {
	f := newFakeOpenWrt(t)
	d, given := openTestOWrt(t, f, "owrt-secret")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.Vendor != "OpenWrt" || info.Model != "GL.iNet GL-MT6000" || info.Firmware != "OpenWrt 24.10.0" {
		t.Fatalf("info: %+v", info)
	}
	for _, g := range *given {
		for _, b := range g {
			if b != 0 {
				t.Fatal("password not zeroed")
			}
		}
	}

	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 3 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Connection != router.ConnWiFi || clients[0].SignalDBm == nil || *clients[0].SignalDBm != -62 {
		t.Errorf("wifi client: %+v", clients[0])
	}
	if clients[2].Blocked == nil || !*clients[2].Blocked {
		t.Errorf("admin blocked client: %+v", clients[2])
	}

	// Admin block must remain untouched.
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not touch admin rule: %+v %v", unPre, err)
	}

	// Managed block + unblock.
	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || f.commits == 0 || f.reloads == 0 {
		t.Fatalf("block: %+v %v commits=%d reloads=%d", ch, err, f.commits, f.reloads)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}

	// Schedule.
	sc := d.(router.Scheduler)
	sch, err := sc.SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: []time.Weekday{time.Sunday, time.Monday}, Start: "21:00", End: "23:30"}})
	if err != nil || !sch.Applied {
		t.Fatalf("schedule: %+v %v", sch, err)
	}
	csch, err := sc.ClearSchedule(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !csch.Applied {
		t.Fatalf("clear schedule: %+v %v", csch, err)
	}

	if err := d.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if f.destroys != 1 {
		t.Errorf("want 1 session destroy, got %d", f.destroys)
	}
}

func TestOpenWrtBadCredentials(t *testing.T) {
	f := newFakeOpenWrt(t)
	d, _ := openTestOWrt(t, f, "wrong")
	defer d.Close(context.Background())
	_, err := d.Identify(context.Background())
	if !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
