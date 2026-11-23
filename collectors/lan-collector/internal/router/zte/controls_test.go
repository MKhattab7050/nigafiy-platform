package zte

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

type fakeZTEControls struct {
	mu       sync.Mutex
	random   string
	nextID   int
	wlans    []map[string]string
	dhcps    []map[string]string
	pfs      []map[string]string
	rebooted bool
	srv      *httptest.Server
}

func newFakeZTEControls(t *testing.T) *fakeZTEControls {
	t.Helper()
	f := &fakeZTEControls{
		random: "99441122",
		nextID: 10,
		wlans: []map[string]string{
			{"_InstID": "IGD.LD1.WLAN1", "ESSID": "WE_ZTE_2G", "RFBand": "2.4GHz", "Enable": "1", "ESSIDHideEnable": "0", "BeaconType": "WPA2PSK", "KeyPassphrase": "zte-secret-psk"},
			{"_InstID": "IGD.LD1.WLAN2", "ESSID": "WE_ZTE_Guest", "RFBand": "5GHz", "Enable": "1", "ESSIDHideEnable": "1", "BeaconType": "WPA2PSK", "KeyPassphrase": "zte-guest-psk"},
		},
		dhcps: []map[string]string{
			{"_InstID": "IGD.LD1.DH1", "Enable": "1", "MACAddr": "AA:BB:CC:00:00:10", "IPAddr": "192.168.1.20"},
		},
		pfs: []map[string]string{
			{"_InstID": "IGD.PF1", "Enable": "1", "Name": "AdminWeb", "Protocol": "TCP", "MinExtPort": "8080", "MaxExtPort": "8080", "MinIntPort": "80", "MaxIntPort": "80", "InternalHost": "192.168.1.20"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeZTEControls) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func writeZTEInstances(w http.ResponseWriter, obj string, insts []map[string]string) {
	var b strings.Builder
	fmt.Fprintf(&b, `<ajax_response_xml_root><%s>`, obj)
	for _, m := range insts {
		b.WriteString(`<Instance>`)
		for k, v := range m {
			fmt.Fprintf(&b, `<ParaName>%s</ParaName><ParaValue>%s</ParaValue>`, k, v)
		}
		b.WriteString(`</Instance>`)
	}
	fmt.Fprintf(&b, `</%s></ajax_response_xml_root>`, obj)
	_, _ = w.Write([]byte(b.String()))
}

func (f *fakeZTEControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	typ := r.URL.Query().Get("_type")
	tag := r.URL.Query().Get("_tag")

	if typ == "loginData" && tag == "login_entry" {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"loginRandom": f.random, "sess_token": "zte-ctrl-tok-1"})
			return
		}
		sum := sha256.Sum256([]byte("zte-ctrl-pass" + f.random))
		if r.FormValue("Username") != "admin" || r.FormValue("Password") != hex.EncodeToString(sum[:]) {
			_ = json.NewEncoder(w).Encode(map[string]any{"loginErrMsg": "bad creds"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "SID", Value: "zte-ctrl-sid"})
		_ = json.NewEncoder(w).Encode(map[string]any{"login_need_refresh": 1, "sess_token": "zte-ctrl-tok-2"})
		return
	}
	if typ == "loginData" && tag == "logout_entry" {
		w.WriteHeader(http.StatusOK)
		return
	}
	if !strings.Contains(r.Header.Get("Cookie"), "SID=zte-ctrl-sid") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch tag {
	case "devmgr_statusmgr_lua.lua":
		writeZTEInstances(w, "OBJ_DEVINFO_ID", []map[string]string{{"ModelName": "ZXHN H188A", "PowerOnTime": "43200"}})
	case "localnet_lan_lua.lua":
		writeZTEInstances(w, "OBJ_LAN_ID", []map[string]string{{"IPAddr": "192.168.1.1"}})
	case "status_wan_if_lua.lua":
		writeZTEInstances(w, "OBJ_WAN_ID", []map[string]string{
			{"WANCName": "omci_ipv4_pppoe", "ConnStatus": "Connected", "TransType": "PPPoE", "IPAddress": "197.55.2.20", "DNS1": "1.1.1.1", "DNS2": "8.8.8.8"},
		})
	case "wlan_basicadconf_lua.lua":
		if r.Method == http.MethodPost {
			id := r.FormValue("_InstID")
			for _, wl := range f.wlans {
				if wl["_InstID"] == id {
					wl["Enable"] = r.FormValue("Enable")
				}
			}
			_, _ = w.Write([]byte(`<ajax_response_xml_root><IF_ERRORSTR>SUCC</IF_ERRORSTR></ajax_response_xml_root>`))
			return
		}
		writeZTEInstances(w, "OBJ_WLAN_ID", f.wlans)
	case "localnet_lan_dhcps_lua.lua":
		if r.Method == http.MethodPost {
			switch r.FormValue("IF_ACTION") {
			case "Apply":
				f.nextID++
				f.dhcps = append(f.dhcps, map[string]string{
					"_InstID": fmt.Sprintf("IGD.LD1.DH%d", f.nextID),
					"Enable":  "1",
					"MACAddr": r.FormValue("MACAddr"),
					"IPAddr":  r.FormValue("IPAddr"),
				})
			case "Delete":
				id := r.FormValue("_InstID")
				var kept []map[string]string
				for _, d := range f.dhcps {
					if d["_InstID"] != id {
						kept = append(kept, d)
					}
				}
				f.dhcps = kept
			}
			_, _ = w.Write([]byte(`<ajax_response_xml_root><IF_ERRORSTR>SUCC</IF_ERRORSTR></ajax_response_xml_root>`))
			return
		}
		writeZTEInstances(w, "OBJ_DHCPS_ID", f.dhcps)
	case "app_portforwarding_lua.lua":
		if r.Method == http.MethodPost {
			switch r.FormValue("IF_ACTION") {
			case "Apply":
				f.nextID++
				f.pfs = append(f.pfs, map[string]string{
					"_InstID":      fmt.Sprintf("IGD.PF%d", f.nextID),
					"Enable":       "1",
					"Name":         r.FormValue("Name"),
					"Protocol":     r.FormValue("Protocol"),
					"MinExtPort":   r.FormValue("MinExtPort"),
					"MaxExtPort":   r.FormValue("MaxExtPort"),
					"MinIntPort":   r.FormValue("MinIntPort"),
					"MaxIntPort":   r.FormValue("MaxIntPort"),
					"InternalHost": r.FormValue("InternalHost"),
				})
			case "Delete":
				id := r.FormValue("_InstID")
				var kept []map[string]string
				for _, p := range f.pfs {
					if p["_InstID"] != id {
						kept = append(kept, p)
					}
				}
				f.pfs = kept
			}
			_, _ = w.Write([]byte(`<ajax_response_xml_root><IF_ERRORSTR>SUCC</IF_ERRORSTR></ajax_response_xml_root>`))
			return
		}
		writeZTEInstances(w, "OBJ_PF_ID", f.pfs)
	case "devmgr_restart_lua.lua":
		if r.FormValue("IF_ACTION") == "devrestart" {
			f.rebooted = true
		}
		_, _ = w.Write([]byte(`<ajax_response_xml_root><IF_ERRORSTR>SUCC</IF_ERRORSTR></ajax_response_xml_root>`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestZTEControls(t *testing.T, f *fakeZTEControls) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte("zte-ctrl-pass"), nil }
	d, err := router.Open(
		router.Target{ID: "zt-ctrl", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func TestZTEControls(t *testing.T) {
	f := newFakeZTEControls(t)
	d := openTestZTEControls(t, f)
	ctx := context.Background()

	sr := d.(router.SettingsReader)
	settings, err := sr.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Overview == nil || settings.Overview.LANIP != "192.168.1.1" || settings.Overview.UptimeSeconds == nil || *settings.Overview.UptimeSeconds != 43200 {
		t.Fatalf("overview: %+v", settings.Overview)
	}
	if len(settings.Overview.WAN) != 1 || settings.Overview.WAN[0].Status != "up" || len(settings.Overview.WAN[0].DNS) != 2 {
		t.Fatalf("wan: %+v", settings.Overview.WAN)
	}
	if len(settings.WiFi) != 2 || settings.WiFi[0].SSID != "WE_ZTE_2G" || !settings.WiFi[1].Guest || !settings.WiFi[1].Hidden {
		t.Fatalf("wifi: %+v", settings.WiFi)
	}
	rawJSON, _ := json.Marshal(settings)
	if strings.Contains(string(rawJSON), "secret-psk") || strings.Contains(string(rawJSON), "guest-psk") {
		t.Fatalf("Wi-Fi PSK leaked in Settings JSON: %s", string(rawJSON))
	}

	wc := d.(router.WiFiController)
	if ch, err := wc.SetWiFiEnabled(ctx, "IGD.LD1.WLAN2", false); err != nil || !ch.Applied || f.wlans[1]["Enable"] != "0" {
		t.Fatalf("SetWiFiEnabled: %+v %v wlans=%+v", ch, err, f.wlans)
	}

	rm := d.(router.ReservationManager)
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:44", "192.168.1.44"); err != nil || !ch.Applied {
		t.Fatalf("AddReservation: %+v %v", ch, err)
	}
	if ch, err := rm.AddReservation(ctx, "aa:bb:cc:00:00:44", "192.168.1.44"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation idempotent: %+v %v", ch, err)
	}
	if ch, err := rm.RemoveReservation(ctx, "aa:bb:cc:00:00:44"); err != nil || !ch.Applied || len(f.dhcps) != 1 {
		t.Fatalf("RemoveReservation: %+v %v dhcps=%+v", ch, err, f.dhcps)
	}

	pf := d.(router.PortForwarder)
	if ch, err := pf.AddPortForward(ctx, router.PortForward{
		Description: router.ProductRulePrefix + "VPN", Protocol: router.ProtoUDP,
		ExternalStart: 51820, ExternalEnd: 51820, InternalStart: 51820, InternalEnd: 51820, InternalIP: "192.168.1.44",
	}); err != nil || !ch.Applied {
		t.Fatalf("AddPortForward: %+v %v", ch, err)
	}
	afterAdd, _ := sr.Settings(ctx)
	if len(afterAdd.PortForwards) != 2 {
		t.Fatalf("expected 2 port forwards, got %+v", afterAdd.PortForwards)
	}
	if ch, err := pf.RemovePortForward(ctx, afterAdd.PortForwards[1]); err != nil || !ch.Applied || len(f.pfs) != 1 {
		t.Fatalf("RemovePortForward: %+v %v pfs=%+v", ch, err, f.pfs)
	}

	rb := d.(router.Rebooter)
	if ch, err := rb.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot: %+v %v rebooted=%v", ch, err, f.rebooted)
	}
}
