package ciscoxe

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

func TestSettingsReadOnly(t *testing.T) {
	boot := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware/device-system-data":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-device-hardware-oper:device-system-data": map[string]any{"boot-time": boot},
			})
		case "/restconf/data/Cisco-IOS-XE-interfaces-oper:interfaces/interface":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Cisco-IOS-XE-interfaces-oper:interface": []map[string]any{
					{"name": "GigabitEthernet0/0/0", "oper-status": "if-oper-state-ready", "ipv4": "41.20.30.40", "type": "iana-iftype-ethernet-csmacd"},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	host, pStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	d, err := New(router.Target{ID: "cx", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTP},
		func(context.Context) (string, []byte, error) { return "admin", []byte("pw"), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close(context.Background())

	s, err := d.Settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview == nil || s.Overview.UptimeSeconds == nil || *s.Overview.UptimeSeconds < 7000 || len(s.Overview.WAN) != 1 || s.Overview.WAN[0].IPv4 != "41.20.30.40" {
		t.Fatalf("unexpected overview: %+v", s.Overview)
	}
}
