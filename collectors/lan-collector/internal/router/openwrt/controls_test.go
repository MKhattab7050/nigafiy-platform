package openwrt

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
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	owPassword = "owrt-root-pass-4821"
	owSession  = "0123456789abcdef0123456789abcdef"
)

// owState is the ubus JSON-RPC test double's state, served over TLS with its own self-signed
// certificate (the driver reaches it through the pinned-certificate transport).
type owState struct {
	wifiDisabled string
	dhcpHosts    map[string]map[string]any
	fwRedirects  map[string]map[string]any
	rebooted     bool
	commits      int
	failWrites   bool
	srv          *httptest.Server
}

func newOwControls(t *testing.T) *owState {
	st := &owState{}
	wifiDisabled := "0"
	dhcpHosts := map[string]map[string]any{
		"cfg01": {".type": "host", "mac": "AA:BB:CC:00:00:10", "ip": "192.168.1.10", "name": "nas"},
	}
	fwRedirects := map[string]map[string]any{}
	st.wifiDisabled, st.dhcpHosts, st.fwRedirects = wifiDisabled, dhcpHosts, fwRedirects
	st.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			if strVal(args["username"]) != "root" || strVal(args["password"]) != owPassword {
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
		write := meth == "set" || meth == "add" || meth == "delete" || meth == "commit" || obj+"."+meth == "system.reboot"
		if st.failWrites && write {
			reply(6, map[string]any{}) // UBUS_STATUS_PERMISSION_DENIED: the ACL does not allow writes
			return
		}
		wifiDisabled := st.wifiDisabled
		defer func() { st.wifiDisabled = wifiDisabled }()
		switch obj + "." + meth {
		case "session.destroy":
			reply(0, map[string]any{})
		case "system.info":
			reply(0, map[string]any{"uptime": 4200})
		case "system.reboot":
			st.rebooted = true
			reply(0, map[string]any{})
		case "network.interface.lan.status":
			reply(0, map[string]any{"ipv4-address": []map[string]any{{"address": "192.168.1.1", "mask": 24}}})
		case "network.interface.wan.status":
			reply(0, map[string]any{"up": true, "proto": "dhcp", "uptime": 3600, "ipv4-address": []map[string]any{{"address": "41.0.0.5"}}, "dns-server": []string{"1.1.1.1"}})
		case "uci.get":
			switch strVal(args["config"]) {
			case "wireless":
				reply(0, map[string]any{"values": map[string]any{
					"radio0":        map[string]any{".type": "wifi-device", "band": "5g"},
					"default_radio": map[string]any{".type": "wifi-iface", "device": "radio0", "ssid": "OpenWrt5G", "disabled": wifiDisabled, "key": "WIFI-SECRET-99", "encryption": "psk2"},
				}})
			case "dhcp":
				reply(0, map[string]any{"values": dhcpHosts})
			case "firewall":
				reply(0, map[string]any{"values": fwRedirects})
			}
		case "uci.set":
			vals, _ := args["values"].(map[string]any)
			sec := strVal(args["section"])
			switch strVal(args["config"]) {
			case "wireless":
				wifiDisabled = strVal(vals["disabled"])
			case "dhcp":
				if dhcpHosts[sec] == nil {
					dhcpHosts[sec] = map[string]any{".type": "host"}
				}
				for k, v := range vals {
					dhcpHosts[sec][k] = v
				}
			case "firewall":
				if fwRedirects[sec] == nil {
					fwRedirects[sec] = map[string]any{".type": "redirect"}
				}
				for k, v := range vals {
					fwRedirects[sec][k] = v
				}
			}
			reply(0, map[string]any{})
		case "uci.add":
			sec := "cfg99"
			if strVal(args["config"]) == "dhcp" {
				dhcpHosts[sec] = map[string]any{".type": "host"}
			} else if strVal(args["config"]) == "firewall" {
				fwRedirects[sec] = map[string]any{".type": "redirect"}
			}
			reply(0, map[string]any{"section": sec})
		case "uci.delete":
			sec := strVal(args["section"])
			delete(dhcpHosts, sec)
			delete(fwRedirects, sec)
			reply(0, map[string]any{})
		case "uci.commit":
			st.commits++
			reply(0, map[string]any{})
		case "luci.setInitAction", "rc.init":
			reply(0, map[string]any{})
		default:
			reply(4, map[string]any{})
		}
	}))
	t.Cleanup(st.srv.Close)
	return st
}

func (st *owState) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(st.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(st.srv.Certificate().Raw)
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

func noSecret(t *testing.T, what string, values ...any) {
	t.Helper()
	for _, v := range values {
		var s string
		if err, ok := v.(error); ok && err != nil {
			s = err.Error()
		} else {
			b, _ := json.Marshal(v)
			s = string(b)
		}
		for _, secret := range []string{owPassword, owSession, "WIFI-SECRET-99"} {
			if strings.Contains(s, secret) {
				t.Fatalf("%s leaked a secret: %s", what, s)
			}
		}
	}
}

func TestExtendedControls(t *testing.T) {
	st := newOwControls(t)
	d := st.driver(t, "", owPassword)
	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview == nil || *s.Overview.UptimeSeconds != 4200 || len(s.WiFi) != 1 || s.WiFi[0].Band != "5GHz" {
		t.Fatalf("unexpected settings: %+v", s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.SetWiFiEnabled(ctx, "default_radio", false)
	noSecret(t, "SetWiFiEnabled", ch)
	if err != nil || st.wifiDisabled != "1" {
		t.Fatalf("SetWiFiEnabled failed: %v", err)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:20", "192.168.1.20"); err != nil {
		t.Fatalf("AddReservation failed: %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "HomeNAS"); err != nil {
		t.Fatalf("RenameClient failed: %v", err)
	}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:20"); err != nil {
		t.Fatalf("RemoveReservation failed: %v", err)
	}
	if _, err := d.AddPortForward(ctx, router.PortForward{Description: "SSH-Alt", Protocol: "tcp", ExternalStart: 2222, InternalIP: "192.168.1.10"}); err != nil {
		t.Fatalf("AddPortForward failed: %v", err)
	}
	s2, _ := d.Settings(ctx)
	if len(s2.PortForwards) != 1 {
		t.Fatalf("expected 1 redirect, got %d", len(s2.PortForwards))
	}
	if _, err := d.RemovePortForward(ctx, s2.PortForwards[0]); err != nil {
		t.Fatalf("RemovePortForward failed: %v", err)
	}
	if len(st.dhcpHosts) != 1 || len(st.fwRedirects) != 0 || st.commits == 0 {
		t.Fatalf("unexpected state after add/remove: hosts=%v redirects=%v commits=%d", st.dhcpHosts, st.fwRedirects, st.commits)
	}
	if _, err := d.Reboot(ctx); err != nil || !st.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, st.rebooted)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("ubus ACL refuses writes", func(t *testing.T) {
		st := newOwControls(t)
		d := st.driver(t, "", owPassword)
		st.failWrites = true
		_, err := d.SetWiFiEnabled(ctx, "default_radio", false)
		if err == nil {
			t.Fatal("SetWiFiEnabled must fail when the router refuses it")
		}
		noSecret(t, "SetWiFiEnabled error", err)
		if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:20", "192.168.1.20"); err == nil {
			t.Fatal("AddReservation must fail when the router refuses it")
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "SSH-Alt", Protocol: "tcp", ExternalStart: 2222, InternalIP: "192.168.1.10"}); err == nil {
			t.Fatal("AddPortForward must fail when the router refuses it")
		}
		if _, err := d.Reboot(ctx); err == nil || st.rebooted {
			t.Fatalf("Reboot must fail and not reboot, got %v", err)
		}
		if st.wifiDisabled != "0" || len(st.dhcpHosts) != 1 || len(st.fwRedirects) != 0 || st.commits != 0 {
			t.Fatal("a refused write must not change the router")
		}
	})

	t.Run("invalid input never reaches the router", func(t *testing.T) {
		st := newOwControls(t)
		d := st.driver(t, "", owPassword)
		if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:20", "10.1.1.20"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("reservation outside the LAN: want ErrInvalidArgument, got %v", err)
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Description: "LuCI", Protocol: "tcp", ExternalStart: 80, InternalIP: "192.168.1.10"}); err == nil {
			t.Fatal("a management port must never be forwarded")
		}
		if len(st.dhcpHosts) != 1 || len(st.fwRedirects) != 0 || st.commits != 0 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		st := newOwControls(t)
		d := st.driver(t, "", "wrong-"+owPassword)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		st := newOwControls(t)
		d := st.driver(t, strings.Repeat("78", 32), owPassword)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || st.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}
