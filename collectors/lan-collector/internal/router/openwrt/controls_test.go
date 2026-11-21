package openwrt

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
)

func TestExtendedControls(t *testing.T) {
	wifiDisabled := "0"
	dhcpHosts := map[string]map[string]any{
		"cfg01": {".type": "host", "mac": "AA:BB:CC:00:00:10", "ip": "192.168.1.10", "name": "nas"},
	}
	fwRedirects := map[string]map[string]any{}
	rebooted := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		obj, _ := req.Params[1].(string)
		meth, _ := req.Params[2].(string)
		args, _ := req.Params[3].(map[string]any)
		reply := func(code int, body any) {
			b, _ := json.Marshal(body)
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": []any{code, json.RawMessage(b)}})
		}
		switch obj + "." + meth {
		case "session.login":
			reply(0, map[string]any{"ubus_rpc_session": "sess123"})
		case "session.destroy":
			reply(0, map[string]any{})
		case "system.info":
			reply(0, map[string]any{"uptime": 4200})
		case "system.reboot":
			rebooted = true
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
		case "uci.commit", "luci.setInitAction", "rc.init":
			reply(0, map[string]any{})
		default:
			reply(4, map[string]any{})
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "ow", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "root", []byte("pw"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	ctx := context.Background()
	s, err := d.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview == nil || *s.Overview.UptimeSeconds != 4200 || len(s.WiFi) != 1 || s.WiFi[0].Band != "5GHz" {
		t.Fatalf("unexpected settings: %+v", s)
	}
	if raw, _ := json.Marshal(s); strings.Contains(string(raw), "WIFI-SECRET-99") {
		t.Fatal("Wi-Fi key leaked into Settings")
	}
	if _, err := d.SetWiFiEnabled(ctx, "default_radio", false); err != nil || wifiDisabled != "1" {
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
	if _, err := d.Reboot(ctx); err != nil || !rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, rebooted)
	}
}
