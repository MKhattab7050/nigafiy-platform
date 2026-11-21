package ciscoxe

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
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

func newFakeCiscoXE(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "netops" || p != "cisco-pass" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Accept") != yangJSON {
			w.WriteHeader(http.StatusNotAcceptable)
			return
		}
		w.Header().Set("Content-Type", yangJSON)
		switch r.URL.Path {
		case "/restconf/data/Cisco-IOS-XE-native:native/version":
			_ = json.NewEncoder(w).Encode(map[string]string{"Cisco-IOS-XE-native:version": "17.9.4a"})
		case "/restconf/data/Cisco-IOS-XE-native:native/hostname":
			_ = json.NewEncoder(w).Encode(map[string]string{"Cisco-IOS-XE-native:hostname": "core-isr4331"})
		case "/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware/device-inventory":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-device-hardware-oper:device-inventory": []map[string]string{
					{"hw-type": "hw-type-chassis", "part-number": "ISR4331/K9", "serial-number": "FDO2200TEST"},
				},
			})
		case "/restconf/data/Cisco-IOS-XE-arp-oper:arp-data":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-arp-oper:arp-data": map[string]any{
					"arp-entry": []map[string]any{
						{"ip-address": "10.20.0.15", "hw-address": "aabb.cc00.0300", "interface": "GigabitEthernet0/0/1", "age": "5"},
					},
				},
			})
		case "/restconf/data/Cisco-IOS-XE-dhcp-oper:dhcp-oper-data":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-dhcp-oper:dhcp-oper-data": map[string]any{
					"dhcpv4-server-oper": []map[string]any{
						{"client-ip": "10.20.0.15", "client-mac": "aabb.cc00.0300", "lease-remaining": 7200, "type": "automatic"},
					},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	return srv, router.FormatPin(sum[:])
}

func TestCiscoXEEndToEnd(t *testing.T) {
	srv, pin := newFakeCiscoXE(t)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	d, err := router.Open(
		router.Target{ID: "cx1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin, Timeout: 5 * time.Second},
		func(context.Context) (string, []byte, error) { return "netops", []byte("cisco-pass"), nil },
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	defer d.Close(ctx)

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "Cisco" || info.Model != "ISR4331/K9" || info.Firmware != "17.9.4a" {
		t.Fatalf("info: %+v %v", info, err)
	}
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapClients) || caps.Supports(router.CapBlock) {
		t.Fatalf("caps: %+v %v", caps, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 1 || clients[0].MAC != "aa:bb:cc:00:03:00" || clients[0].Lease == nil || *clients[0].Lease.Remaining != 2*time.Hour {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if _, err := d.Block(ctx, "aa:bb:cc:00:03:00"); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("want ErrUnsupported for Block, got %v", err)
	}
}
