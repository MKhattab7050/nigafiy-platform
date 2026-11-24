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
	"testing"

	"github.com/nigafiy/sensor/internal/router"
)

// owQoS is a ubus test double holding an uncommitted and a committed copy of the nft-qos UCI
// config (nil: the package is not installed → uci.get answers NOT_FOUND).
type owQoS struct {
	staged, committed map[string]map[string]any
	restarts          int
	denyWrites        bool
	noInit            bool
	writes            int
	next              int
	srv               *httptest.Server
}

func copyCfg(c map[string]map[string]any) map[string]map[string]any {
	if c == nil {
		return nil
	}
	out := map[string]map[string]any{}
	for k, v := range c {
		m := map[string]any{}
		for a, b := range v {
			m[a] = b
		}
		out[k] = m
	}
	return out
}

func newOwQoS(t *testing.T, installed bool, macEnabled string) *owQoS {
	f := &owQoS{}
	if installed {
		f.committed = map[string]map[string]any{
			"default": {".type": "default", "limit_enable": "1", "limit_type": "static", "limit_mac_enable": macEnabled},
			"cfgadm":  {".type": "client", "macaddr": "aa:bb:cc:00:00:20", "hostname": "kids-tablet", "drate": "100", "drunit": "kbytes"},
		}
		f.staged = copyCfg(f.committed)
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		sess, _ := req.Params[0].(string)
		obj, _ := req.Params[1].(string)
		meth, _ := req.Params[2].(string)
		args, _ := req.Params[3].(map[string]any)
		reply := func(code int, body any) {
			b, _ := json.Marshal(body)
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": []any{code, json.RawMessage(b)}})
		}
		if obj+"."+meth == "session.login" {
			if strVal(args["password"]) != owPassword {
				reply(6, map[string]any{})
				return
			}
			reply(0, map[string]any{"ubus_rpc_session": owSession})
			return
		}
		if sess != owSession {
			reply(6, map[string]any{})
			return
		}
		if obj == "uci" && meth != "get" {
			f.writes++
			if f.denyWrites {
				reply(6, map[string]any{})
				return
			}
		}
		switch obj + "." + meth {
		case "system.board":
			reply(0, map[string]any{"model": "Test", "release": map[string]any{"version": "23.05.5"}})
		case "session.destroy":
			reply(0, map[string]any{})
		case "uci.get":
			if strVal(args["config"]) != "nft-qos" || f.committed == nil {
				reply(ubusNotFound, map[string]any{})
				return
			}
			reply(0, map[string]any{"values": f.committed})
		case "uci.add":
			f.next++
			id := fmt.Sprintf("cfg%02d", f.next)
			vals, _ := args["values"].(map[string]any)
			vals[".type"] = strVal(args["type"])
			f.staged[id] = vals
			reply(0, map[string]any{"section": id})
		case "uci.set":
			for k, v := range args["values"].(map[string]any) {
				f.staged[strVal(args["section"])][k] = v
			}
			reply(0, map[string]any{})
		case "uci.delete":
			sec := strVal(args["section"])
			opts, _ := args["options"].([]any)
			if o := strVal(args["option"]); o != "" {
				opts = append(opts, o)
			}
			if len(opts) == 0 {
				delete(f.staged, sec)
			}
			for _, o := range opts {
				delete(f.staged[sec], strVal(o))
			}
			reply(0, map[string]any{})
		case "uci.commit":
			f.committed = copyCfg(f.staged)
			reply(0, map[string]any{})
		case "luci.setInitAction", "rc.init":
			if f.noInit || strVal(args["name"]) != "nft-qos" {
				reply(6, map[string]any{})
				return
			}
			f.restarts++
			reply(0, map[string]any{})
		default:
			reply(0, map[string]any{})
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *owQoS) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "ow", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "root", []byte(password), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func (f *owQoS) own(mac string) map[string]any {
	for _, v := range f.committed {
		if v["hostname"] == limitHostLabel+mac {
			return v
		}
	}
	return nil
}

func TestOpenWrtRateLimit(t *testing.T) {
	ctx := context.Background()
	mac := "aa:bb:cc:00:00:10"
	f := newOwQoS(t, true, "0")
	d := f.driver(t, "", owPassword)
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapRateLimit) {
		t.Fatalf("capabilities: %v %+v", err, caps.Get(router.CapRateLimit))
	}
	ch, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 1000, UpKbps: 250})
	if err != nil || !ch.Applied || !strings.Contains(ch.Detail, "now on") {
		t.Fatalf("SetRateLimit: %v %+v", err, ch)
	}
	noSecret(t, "SetRateLimit", ch)
	c := f.own(mac)
	if c == nil || c["drate"] != "125" || c["urate"] != "32" || c["drunit"] != "kbytes" || f.committed["default"]["limit_mac_enable"] != "1" || f.restarts != 1 {
		t.Fatalf("state: %v", f.committed)
	}
	// Download only: the upload rate is removed from the section.
	if _, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 2000}); err != nil {
		t.Fatal(err)
	}
	if c := f.own(mac); c["drate"] != "250" || c["urate"] != nil {
		t.Fatalf("update: %v", c)
	}
	// The administrator's limit for another device stays; MAC limits go off again with ours.
	ch, err = d.ClearRateLimit(ctx, mac)
	if err != nil || !ch.Applied || f.own(mac) != nil || f.committed["default"]["limit_mac_enable"] != "0" || f.committed["cfgadm"] == nil {
		t.Fatalf("clear: %v %+v %v", err, ch, f.committed)
	}
	if ch, err := d.ClearRateLimit(ctx, mac); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestOpenWrtRateLimitRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("nft-qos not installed", func(t *testing.T) {
		f := newOwQoS(t, false, "")
		d := f.driver(t, "", owPassword)
		caps, _ := d.Capabilities(ctx)
		if c := caps.Get(router.CapRateLimit); c.Supported || !strings.Contains(c.Note, "nft-qos") {
			t.Fatalf("%+v", c)
		}
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 8}); !errors.Is(err, router.ErrUnsupported) || f.writes != 0 {
			t.Fatal(err)
		}
	})
	t.Run("administrator's own limit", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, "", owPassword)
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:20", router.RateLimit{DownKbps: 8}); !errors.Is(err, router.ErrRejected) || f.writes != 0 || f.committed["cfgadm"]["drate"] != "100" {
			t.Fatal(err)
		}
	})
	t.Run("ACL denies writes", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, "", owPassword)
		f.denyWrites = true
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 8}); !errors.Is(err, router.ErrRejected) || f.own("aa:bb:cc:00:00:10") != nil {
			t.Fatal(err)
		}
	})
	t.Run("service restart refused", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, "", owPassword)
		f.noInit = true
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 8}); !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "restart") {
			t.Fatal(err)
		}
	})
	t.Run("bad input", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, "", owPassword)
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetRateLimit(ctx, "00:00:00:00:00:00", router.RateLimit{UpKbps: 1}); !errors.Is(err, router.ErrInvalidArgument) || f.writes != 0 {
			t.Fatal(err)
		}
	})
	t.Run("wrong password", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, "", "nope")
		_, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{UpKbps: 1})
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatal(err)
		}
		noSecret(t, "error", err)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		f := newOwQoS(t, true, "1")
		d := f.driver(t, strings.Repeat("56", 32), owPassword)
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{UpKbps: 1}); !errors.Is(err, router.ErrCertificate) || f.writes != 0 {
			t.Fatal(err)
		}
	})
}
