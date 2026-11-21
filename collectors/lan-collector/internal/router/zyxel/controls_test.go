package zyxel

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
	"github.com/lan-detective/lan-collector/internal/router/zyxel/zyxeltest"
)

func controlsFixture() zyxeltest.Config {
	cfg := fixture()
	cfg.Hosts[0].Layer1 = "Device.WiFi.SSID.5"
	cfg.Hosts[1].Layer1 = "Device.Ethernet.Interface.2"
	cfg.Hosts[2].Layer1 = "Device.WiFi.SSID.1"
	cfg.LANIP, cfg.LANMask = "192.168.1.1", "255.255.255.0"
	cfg.Status = map[string]any{
		"DeviceInfo": map[string]any{"UpTime": float64(86400), "ModelName": "VMG3625-T50B"},
		"WanLanInfo": []any{
			map[string]any{"Name": "ETHWAN", "X_ZYXEL_SrvName": "ETHWAN", "Enable": true, "Status": "Up", "LinkType": "ETH",
				"IPv4Address": []any{map[string]any{"IPAddress": "41.0.0.10"}}, "pppoeConnectionUpTime": float64(3600)},
			map[string]any{"Name": "LAN", "X_ZYXEL_Type": "LAN", "Enable": true, "Status": "Up"},
			map[string]any{"Name": "DSL", "Enable": false, "Status": "Down"},
		},
		"dnsv4Server": []any{"8.8.8.8", "1.1.1.1"},
	}
	cfg.WLAN = []map[string]any{
		{"SSID": "Home", "band": "2.4GHz", "MainSSID": true, "wlEnable": true, "SecurityMode": "WPA2-Personal", "psk_value": "never-leaks-1"},
		{"SSID": "Home_guest1", "band": "2.4GHz", "MainSSID": false, "wlEnable": false, "SecurityMode": "WPA2-Personal"},
		{"SSID": "", "band": "2.4GHz", "MainSSID": false, "wlEnable": false},
		{"SSID": "", "band": "2.4GHz", "MainSSID": false, "wlEnable": false},
		{"SSID": "Home5", "band": "5GHz", "MainSSID": true, "wlEnable": false, "SecurityMode": "WPA2-Personal"},
		{"SSID": "Home5_guest1", "band": "5GHz", "MainSSID": false, "wlEnable": false},
	}
	cfg.StaticDHCP = []map[string]any{{"Index": float64(1), "BrWan": "Default", "Enable": true, "MACAddr": "AA:BB:CC:00:00:02", "IPAddr": "192.168.1.21"}}
	cfg.NAT = []map[string]any{{"Index": float64(1), "Enable": true, "Protocol": "TCP", "Description": "admin web cam", "ExternalPortStart": float64(8080),
		"ExternalPortEnd": float64(8080), "InternalPortStart": float64(80), "InternalPortEnd": float64(80), "InternalClient": "192.168.1.21"}}
	return cfg
}

func TestSettingsReadsEverythingWithoutSecrets(t *testing.T) {
	srv := start(t, controlsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []router.Capability{router.CapOverview, router.CapWiFi, router.CapReservations, router.CapPortForward, router.CapRename, router.CapReboot} {
		if !caps.Supports(c) {
			t.Errorf("capability %s not supported: %+v", c, caps.Get(c))
		}
	}
	s, err := d.(router.SettingsReader).Settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview == nil || s.Overview.UptimeSeconds == nil || *s.Overview.UptimeSeconds != 86400 || s.Overview.LANIP != "192.168.1.1" {
		t.Fatalf("overview: %+v", s.Overview)
	}
	if len(s.Overview.WAN) != 1 || s.Overview.WAN[0].Status != "up" || s.Overview.WAN[0].IPv4 != "41.0.0.10" || len(s.Overview.WAN[0].DNS) != 2 {
		t.Errorf("wan (LAN and disabled links must be left out): %+v", s.Overview.WAN)
	}
	if len(s.WiFi) != 4 {
		t.Fatalf("wifi: want 4 named networks, got %+v", s.WiFi)
	}
	if w := s.WiFi[0]; w.ID != "1" || !w.Main || w.Guest || !w.Enabled || w.Band != "2.4GHz" || len(w.ClientMACs) != 1 || w.ClientMACs[0] != "aa:bb:cc:00:00:03" {
		t.Errorf("main 2.4: %+v", w)
	}
	if w := s.WiFi[2]; w.ID != "5" || w.Band != "5GHz" || w.ClientMACs[0] != "aa:bb:cc:00:00:01" {
		t.Errorf("main 5: %+v", w)
	}
	if len(s.Reservations) != 1 || s.Reservations[0].MAC != "aa:bb:cc:00:00:02" || s.Reservations[0].IP != "192.168.1.21" {
		t.Errorf("reservations: %+v", s.Reservations)
	}
	if len(s.PortForwards) != 1 || s.PortForwards[0].Owner != router.OwnerAdmin || s.PortForwards[0].Protocol != router.ProtoTCP || s.PortForwards[0].ExternalStart != 8080 {
		t.Errorf("port forwards: %+v", s.PortForwards)
	}
	b, _ := json.Marshal(s)
	if strings.Contains(string(b), "never-leaks-1") || strings.Contains(string(b), testPassword) {
		t.Fatal("a secret reached the settings")
	}
}

func TestSettingsLeavesOutWhatTheFirmwareLacks(t *testing.T) {
	srv := start(t, fixture()) // no lan/status/wlan/static_dhcp/nat
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []router.Capability{router.CapOverview, router.CapWiFi, router.CapReservations, router.CapPortForward} {
		if caps.Supports(c) || caps.Get(c).Note == "" {
			t.Errorf("%s should be unsupported with a note: %+v", c, caps.Get(c))
		}
	}
	s, err := d.(router.SettingsReader).Settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Overview != nil || s.WiFi != nil || s.Reservations != nil || s.PortForwards != nil {
		t.Errorf("settings should be empty: %+v", s)
	}
}

func TestRenameKeepsBlockingAndIcon(t *testing.T) {
	srv := start(t, controlsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	ch, err := d.(router.Renamer).RenameClient(context.Background(), "aa:bb:cc:00:00:03", "  Kids tablet ")
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || !strings.Contains(ch.Detail, "Kids tablet") || !strings.Contains(ch.Undo, "android-x") {
		t.Errorf("change: %+v", ch)
	}
	h := srv.Host("AA:BB:CC:00:00:03")
	if h.CurName != "Kids tablet" || !h.Blocked {
		t.Errorf("router state after rename: %+v (the block must survive)", h)
	}
	put := srv.Puts[len(srv.Puts)-1]
	if put.Body["Internet_Blocking_Enable"] != true || put.Body["MacAddress"] != "AA:BB:CC:00:00:03" {
		t.Errorf("rename request: %+v", put.Body)
	}
	again, err := d.(router.Renamer).RenameClient(context.Background(), "aa:bb:cc:00:00:03", "Kids tablet")
	if err != nil || again.Applied || !again.AlreadyInEffect {
		t.Errorf("same name again: %+v %v", again, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 64), "a\x00b"} {
		if _, err := d.(router.Renamer).RenameClient(context.Background(), "aa:bb:cc:00:00:03", bad); !errors.Is(err, router.ErrInvalidArgument) {
			t.Errorf("name %q: want invalid argument, got %v", bad, err)
		}
	}
	if _, err := d.(router.Renamer).RenameClient(context.Background(), "aa:bb:cc:00:00:99", "x"); !errors.Is(err, router.ErrNotFound) {
		t.Errorf("unknown device: %v", err)
	}
}

func TestWiFiOnOff(t *testing.T) {
	srv := start(t, controlsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	w := d.(router.WiFiController)
	ch, err := w.SetWiFiEnabled(context.Background(), "2", true)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || ch.MAC != "" || !strings.Contains(ch.Detail, "Home_guest1") || srv.WLAN()[1]["wlEnable"] != true || srv.WlChecks != 1 {
		t.Errorf("guest on: %+v wlan=%v wlchecks=%d", ch, srv.WLAN()[1], srv.WlChecks)
	}
	if put := srv.Puts[len(srv.Puts)-1]; len(put.Body) != 2 || put.Body["Index"] != float64(2) {
		t.Errorf("the request must carry only Index and wlEnable: %+v", put.Body)
	}
	if ch, err := w.SetWiFiEnabled(context.Background(), "2", true); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Errorf("already on: %+v %v", ch, err)
	}
	// A guest network next to a main network that is off: refused like the router's own page.
	if _, err := w.SetWiFiEnabled(context.Background(), "6", true); !errors.Is(err, router.ErrInvalidArgument) || srv.WLAN()[5]["wlEnable"] != false {
		t.Errorf("guest 5 GHz with main off: %v", err)
	}
	for _, id := range []string{"3", "99", "x", ""} {
		if _, err := w.SetWiFiEnabled(context.Background(), id, true); err == nil {
			t.Errorf("network %q should be refused", id)
		}
	}
}

func TestReservations(t *testing.T) {
	srv := start(t, controlsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	r := d.(router.ReservationManager)
	ch, err := r.AddReservation(context.Background(), "aa:bb:cc:00:00:01", "192.168.1.50")
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || ch.MAC != "aa:bb:cc:00:00:01" || ch.Undo == "" {
		t.Errorf("add: %+v", ch)
	}
	post := srv.Puts[len(srv.Puts)-1]
	if post.OID != "static_dhcp" || post.Body["MACAddr"] != "aa:bb:cc:00:00:01" || post.Body["IPAddr"] != "192.168.1.50" || post.Body["Enable"] != true || post.Body["BrWan"] != "Default" {
		t.Errorf("request: %+v", post)
	}
	if ch, err := r.AddReservation(context.Background(), "aa:bb:cc:00:00:01", "192.168.1.50"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Errorf("same again: %+v %v", ch, err)
	}
	for _, c := range []struct{ mac, ip, why string }{
		{"aa:bb:cc:00:00:01", "192.168.1.51", "already reserved to another address"},
		{"aa:bb:cc:00:00:03", "192.168.1.21", "address reserved for another device"},
		{"aa:bb:cc:00:00:03", "192.168.1.1", "the router itself"},
		{"aa:bb:cc:00:00:03", "192.168.1.255", "broadcast"},
		{"aa:bb:cc:00:00:03", "192.168.1.0", "network address"},
		{"aa:bb:cc:00:00:03", "192.168.2.5", "other subnet"},
		{"aa:bb:cc:00:00:03", "8.8.8.8", "public"},
		{"aa:bb:cc:00:00:03", "fe80::1", "IPv6"},
		{"ff:ff:ff:ff:ff:ff", "192.168.1.60", "broadcast MAC"},
	} {
		if _, err := r.AddReservation(context.Background(), c.mac, c.ip); !errors.Is(err, router.ErrInvalidArgument) {
			t.Errorf("%s: want invalid argument, got %v", c.why, err)
		}
	}
	ch, err = r.RemoveReservation(context.Background(), "aa:bb:cc:00:00:02")
	if err != nil || !ch.Applied || !strings.Contains(ch.Undo, "192.168.1.21") {
		t.Fatalf("remove: %+v %v", ch, err)
	}
	if del := srv.Deletes[len(srv.Deletes)-1]; del.OID != "static_dhcp" || del.Body["Index"] != float64(1) {
		t.Errorf("delete request: %+v", del)
	}
	if ch, err := r.RemoveReservation(context.Background(), "aa:bb:cc:00:00:02"); err != nil || ch.Applied {
		t.Errorf("remove again: %+v %v", ch, err)
	}
	if len(srv.StaticDHCP()) != 1 {
		t.Errorf("table: %+v", srv.StaticDHCP())
	}
}

func TestReservationRefusedByRouter(t *testing.T) {
	cfg := controlsFixture()
	cfg.RejectPOST = map[string]bool{"static_dhcp": true}
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	if _, err := d.(router.ReservationManager).AddReservation(context.Background(), "aa:bb:cc:00:00:01", "192.168.1.50"); !errors.Is(err, router.ErrRejected) {
		t.Errorf("want rejected, got %v", err)
	}
}

func TestPortForwards(t *testing.T) {
	srv := start(t, controlsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	f := d.(router.PortForwarder)
	ch, err := f.AddPortForward(context.Background(), router.PortForward{Description: "Game server", Protocol: "both", ExternalStart: 25565, InternalIP: "192.168.1.20"})
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || !strings.Contains(ch.Detail, "BOTH 25565 -> 192.168.1.20:25565") {
		t.Errorf("add: %+v", ch)
	}
	post := srv.Puts[len(srv.Puts)-1]
	if post.OID != "nat" || post.Body["Protocol"] != "ALL" || post.Body["Description"] != "LAN Detective: Game server" || post.Body["InternalClient"] != "192.168.1.20" ||
		post.Body["ExternalPortEnd"] != float64(25565) || post.Body["InternalPortStart"] != float64(25565) || post.Body["X_ZYXEL_AutoDetectWanStatus"] != true {
		t.Errorf("request: %+v", post.Body)
	}
	s, _ := d.(router.SettingsReader).Settings(context.Background())
	var mine router.PortForward
	for _, p := range s.PortForwards {
		if p.Owner == router.OwnerProduct {
			mine = p
		}
	}
	if mine.ID == "" || mine.ExternalStart != 25565 {
		t.Fatalf("the new rule is not listed as ours: %+v", s.PortForwards)
	}
	for _, c := range []struct {
		r   router.PortForward
		why string
	}{
		{router.PortForward{Protocol: "tcp", ExternalStart: 8080, InternalIP: "192.168.1.20"}, "overlaps the administrator's rule"},
		{router.PortForward{Protocol: "udp", ExternalStart: 25565, InternalIP: "192.168.1.21"}, "overlaps (both covers udp)"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 7547, InternalIP: "192.168.1.20"}, "TR-069 port"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 400, ExternalEnd: 500, InternalIP: "192.168.1.20"}, "covers 443"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 9000, ExternalEnd: 9010, InternalStart: 1, InternalEnd: 2, InternalIP: "192.168.1.20"}, "range lengths differ"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 10000, ExternalEnd: 12000, InternalIP: "192.168.1.20"}, "too many ports"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 9000, InternalIP: "192.168.1.1"}, "the router itself"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 9000, InternalIP: "10.0.0.5"}, "off the LAN"},
		{router.PortForward{Protocol: "icmp", ExternalStart: 9000, InternalIP: "192.168.1.20"}, "protocol"},
		{router.PortForward{Protocol: "tcp", ExternalStart: 70000, InternalIP: "192.168.1.20"}, "port range"},
	} {
		if _, err := f.AddPortForward(context.Background(), c.r); !errors.Is(err, router.ErrInvalidArgument) {
			t.Errorf("%s: want invalid argument, got %v", c.why, err)
		}
	}
	// Removal re-checks the rule's content: a stale view is refused.
	stale := mine
	stale.InternalIP = "192.168.1.21"
	if _, err := f.RemovePortForward(context.Background(), stale); !errors.Is(err, router.ErrNotFound) {
		t.Errorf("stale rule: %v", err)
	}
	ch, err = f.RemovePortForward(context.Background(), mine)
	if err != nil || !ch.Applied || !strings.Contains(ch.Undo, "LAN Detective: Game server") {
		t.Fatalf("remove: %+v %v", ch, err)
	}
	if n := len(srv.NAT()); n != 1 {
		t.Errorf("table after remove: %d rules", n)
	}
}

func TestReboot(t *testing.T) {
	srv := start(t, controlsFixture())
	c := &creds{user: "admin", pass: testPassword}
	d := open(t, srv, c, nil)
	ch, err := d.(router.Rebooter).Reboot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || srv.Reboots != 1 || srv.CSRFRejected != 0 {
		t.Errorf("reboot: %+v reboots=%d csrf=%d", ch, srv.Reboots, srv.CSRFRejected)
	}
	if err := d.Close(context.Background()); err != nil {
		t.Errorf("close after reboot: %v", err)
	}
	if c.calls != 1 {
		t.Errorf("logins: %d", c.calls)
	}
}

func TestValidateHelpers(t *testing.T) {
	if n, err := router.CleanName(" ok "); err != nil || n != "ok" {
		t.Errorf("CleanName: %q %v", n, err)
	}
	a := router.PortForward{Protocol: "TCP", ExternalStart: 1, ExternalEnd: 1, InternalStart: 2, InternalEnd: 2, InternalIP: "192.168.1.9"}
	b := a
	b.Protocol = "tcp"
	if !router.SameRule(a, b) {
		t.Error("SameRule should ignore protocol case")
	}
}

// Firmware that rotates the CSRF token on every change: the driver adopts each new "sessionkey" (as the
// router's web UI does), so a second change in the same session and the closing logout are accepted and
// no session is left open. Before this, the logout carried a stale token, the router kept the session,
// and the next login was refused ("Duplicated login") until the session timed out.
func TestRotatingSessionKeyIsFollowedAndLogoutCloses(t *testing.T) {
	cfg := controlsFixture()
	cfg.RotateSessionKey = true
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	if _, err := d.(router.Renamer).RenameClient(context.Background(), "aa:bb:cc:00:00:03", "Kids tablet"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.(router.ReservationManager).AddReservation(context.Background(), "aa:bb:cc:00:00:03", "192.168.1.60"); err != nil {
		t.Fatalf("second change in the same session: %v", err)
	}
	if err := d.Close(context.Background()); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if srv.CSRFRejected != 0 || srv.ActiveSessions() != 0 || srv.Logouts != 1 {
		t.Fatalf("csrf rejected=%d sessions left=%d logouts=%d", srv.CSRFRejected, srv.ActiveSessions(), srv.Logouts)
	}
}
