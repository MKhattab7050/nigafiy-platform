package zyxel

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
	"github.com/lan-detective/lan-collector/internal/router/zyxel/zyxeltest"
)

const testPassword = "correct-horse-7"

func fixture() zyxeltest.Config {
	return zyxeltest.Config{
		Model: "VMG3625-T50B", Firmware: "V5.50(TEST)", User: "admin", Password: testPassword,
		Hosts: []zyxeltest.Host{
			{MAC: "AA:BB:CC:00:00:01", IP: "192.168.1.20", DeviceName: "laptop-1", Icon: "iPC", ConnType: "Wi-Fi 5GHz"},
			{MAC: "AA:BB:CC:00:00:02", IP: "192.168.1.21", DeviceName: "printer", CurName: "Office printer", Icon: "iPrinter", ConnType: "Ethernet"},
			{MAC: "AA:BB:CC:00:00:03", IP: "192.168.1.22", DeviceName: "android-x", Icon: "", ConnType: "Wi-Fi 2.4GHz", Blocked: true},
		},
	}
}

type creds struct {
	user, pass string
	given      [][]byte
	calls      int
}

func (c *creds) source(context.Context) (string, []byte, error) {
	c.calls++
	b := []byte(c.pass)
	c.given = append(c.given, b)
	return c.user, b, nil
}

func open(t *testing.T, srv *zyxeltest.Server, c *creds, mutate func(*router.Target)) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	tg := router.Target{ID: "r1", Vendor: "zyxel", Address: addr, Port: port, Transport: router.TransportHTTPSPinned,
		PinSHA256: srv.PinSHA256(), Timeout: 5 * time.Second}
	if mutate != nil {
		mutate(&tg)
	}
	d, err := router.Open(tg, c.source, router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func start(t *testing.T, cfg zyxeltest.Config) *zyxeltest.Server {
	t.Helper()
	srv := zyxeltest.Start(cfg)
	t.Cleanup(srv.Close)
	return srv
}

func TestIdentifyNeedsNoLogin(t *testing.T) {
	srv := start(t, fixture())
	c := &creds{user: "admin", pass: testPassword}
	d := open(t, srv, c, nil)
	info, err := d.Identify(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.Vendor != "Zyxel" || info.Model != "VMG3625-T50B" || info.Firmware != "V5.50(TEST)" {
		t.Errorf("info: %+v", info)
	}
	if c.calls != 0 || srv.Logins != 0 {
		t.Errorf("identify asked for credentials (%d) or logged in (%d)", c.calls, srv.Logins)
	}
	if err := d.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEndToEndBlockUnblock(t *testing.T) {
	srv := start(t, fixture())
	c := &creds{user: "admin", pass: testPassword}
	d := open(t, srv, c, nil)
	ctx := context.Background()

	clients, err := d.Clients(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(clients) != 3 {
		t.Fatalf("clients: %+v", clients)
	}
	laptop, printer, phone := clients[0], clients[1], clients[2]
	if laptop.MAC != "aa:bb:cc:00:00:01" || laptop.Hostname != "laptop-1" || laptop.Connection != router.ConnWiFi5 || laptop.IP != "192.168.1.20" {
		t.Errorf("laptop: %+v", laptop)
	}
	if printer.Hostname != "Office printer" || printer.Connection != router.ConnWired {
		t.Errorf("printer: %+v", printer)
	}
	if phone.Connection != router.ConnWiFi24 || phone.Blocked == nil || !*phone.Blocked {
		t.Errorf("phone: %+v", phone)
	}
	if laptop.Raw["X_ZYXEL_ConnectionType"] != "Wi-Fi 5GHz" {
		t.Errorf("raw fields missing: %v", laptop.Raw)
	}
	for _, g := range c.given {
		for _, b := range g {
			if b != 0 {
				t.Fatal("password slice was not zeroed after login")
			}
		}
	}

	caps, err := d.Capabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// This fixture has no QoS objects, so the speed limit is not offered; parental control answers,
	// so the schedule is.
	if !caps.Supports(router.CapClients) || !caps.Supports(router.CapBlock) || caps.Supports(router.CapRateLimit) || !caps.Supports(router.CapSchedule) {
		t.Errorf("capabilities: %+v", caps)
	}

	ch, err := d.Block(ctx, "aa-bb-cc-00-00-01")
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || ch.AlreadyInEffect || ch.MAC != "aa:bb:cc:00:00:01" || ch.Undo == "" {
		t.Errorf("change: %+v", ch)
	}
	if !srv.HostBlocked("AA:BB:CC:00:00:01") {
		t.Fatal("double does not show the block")
	}
	if len(srv.Puts) != 1 {
		t.Fatalf("want exactly one change request, got %+v", srv.Puts)
	}
	p := srv.Puts[0].Body
	if srv.Puts[0].OID != "lanhosts" || p["MacAddress"] != "AA:BB:CC:00:00:01" || p["HostName"] != "laptop-1" || p["DeviceIcon"] != "iPC" || p["Internet_Blocking_Enable"] != true {
		t.Errorf("request: %+v", p)
	}
	if h := srv.Host("AA:BB:CC:00:00:01"); h.Icon != "iPC" || h.CurName != "" {
		t.Errorf("block changed name or icon: %+v", h)
	}

	again, err := d.Block(ctx, "AA:BB:CC:00:00:01")
	if err != nil || again.Applied || !again.AlreadyInEffect {
		t.Errorf("second block: %+v %v", again, err)
	}
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Errorf("block of an already blocked device: %+v %v", pre, err)
	}

	blocked, err := d.Blocked(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocked) != 2 || !blocked[0].Managed || blocked[0].Owner != router.OwnerUnknown {
		t.Errorf("blocked: %+v", blocked)
	}

	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
	if srv.HostBlocked("AA:BB:CC:00:00:01") {
		t.Fatal("still blocked")
	}
	if _, err := d.Block(ctx, "aa:bb:cc:99:99:99"); !errors.Is(err, router.ErrNotFound) {
		t.Errorf("unknown MAC: %v", err)
	}
	if _, err := d.Block(ctx, "ff:ff:ff:ff:ff:ff"); !errors.Is(err, router.ErrInvalidArgument) {
		t.Errorf("broadcast MAC: %v", err)
	}

	if err := d.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if srv.Logouts != 1 || srv.ActiveSessions() != 0 {
		t.Errorf("logout: %d logouts, %d sessions left", srv.Logouts, srv.ActiveSessions())
	}
	if srv.Logins != 1 || srv.CSRFRejected != 0 {
		t.Errorf("logins %d, csrf rejected %d", srv.Logins, srv.CSRFRejected)
	}
	if srv.PlaintextPasswordSeen {
		t.Error("the password crossed the wire unencrypted")
	}
	zd := d.(*Driver)
	if zd.sess.aesKey != nil || zd.sess.csrf != nil || zd.sess.cookies != nil {
		t.Error("session material not wiped after Close")
	}
}

func TestWrongPassword(t *testing.T) {
	srv := start(t, fixture())
	c := &creds{user: "admin", pass: "not-the-password"}
	d := open(t, srv, c, nil)
	_, err := d.Clients(context.Background())
	if !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want bad credentials, got %v", err)
	}
	if strings.Contains(err.Error(), "not-the-password") {
		t.Fatal("error message contains the password")
	}
	_ = d.Close(context.Background())
	if srv.Logouts != 0 {
		t.Error("logout sent without a session")
	}
}

func TestLockedOut(t *testing.T) {
	cfg := fixture()
	cfg.LockAfter = 2
	srv := start(t, cfg)
	c := &creds{user: "admin", pass: "wrong"}
	d := open(t, srv, c, nil)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := d.Clients(ctx); !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	_, err := d.Clients(ctx)
	var re *router.Error
	if !errors.Is(err, router.ErrLockedOut) || !errors.As(err, &re) || re.RetryAfter != 60*time.Second {
		t.Fatalf("want locked out for 60s, got %v", err)
	}
}

func TestExpiredSessionIsRenewedOnce(t *testing.T) {
	srv := start(t, fixture())
	c := &creds{user: "admin", pass: testPassword}
	d := open(t, srv, c, nil)
	ctx := context.Background()
	if _, err := d.Clients(ctx); err != nil {
		t.Fatal(err)
	}
	srv.ExpireSessions()
	if _, err := d.Clients(ctx); err != nil {
		t.Fatalf("after expiry: %v", err)
	}
	if srv.Logins != 2 || c.calls != 2 {
		t.Errorf("want a second login, got %d logins / %d credential requests", srv.Logins, c.calls)
	}
	_ = d.Close(ctx)
}

func TestSessionThatKeepsExpiring(t *testing.T) {
	cfg := fixture()
	cfg.ExpireEveryRequest = true
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	_, err := d.Clients(context.Background())
	if !errors.Is(err, router.ErrSessionExpired) {
		t.Fatalf("want session expired, got %v", err)
	}
	if srv.Logins != 2 {
		t.Errorf("want exactly one retry, got %d logins", srv.Logins)
	}
}

func TestUnsupportedFirmware(t *testing.T) {
	cfg := fixture()
	cfg.Model = "VMG0000-OTHER"
	cfg.NoBlockingSwitch = true
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	ctx := context.Background()
	caps, err := d.Capabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if caps.Supports(router.CapBlock) || caps.Get(router.CapBlock).Note == "" {
		t.Errorf("block should be reported unsupported with a reason: %+v", caps.Get(router.CapBlock))
	}
	if !strings.Contains(caps.Get(router.CapClients).Note, "untested") {
		t.Errorf("untested model not flagged: %+v", caps.Get(router.CapClients))
	}
	if _, err := d.Block(ctx, "aa:bb:cc:00:00:01"); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("want unsupported, got %v", err)
	}
	if len(srv.Puts) != 0 {
		t.Errorf("a change was sent to a router that does not support it: %+v", srv.Puts)
	}
	_ = d.Close(ctx)
}

func TestAdministratorRulesAreReadOnly(t *testing.T) {
	cfg := fixture()
	cfg.MACFilterEnable, cfg.MACFilterDeny = true, true
	cfg.MACFilter = []zyxeltest.Host{{MAC: "AA:BB:CC:00:00:09", DeviceName: "kid-tablet"}}
	cfg.ParentalEnable = true
	cfg.ParentalProfiles = []map[string]any{{"Index": 1, "pcpName": "homework", "pcpEnable": true,
		"MACAddressList": "AA:BB:CC:00:00:02", "Days": "Mon,Tue", "TimeRangeList": "16:00-18:00"}}
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	ctx := context.Background()
	blocked, err := d.Blocked(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var mf, pcp bool
	for _, b := range blocked {
		if b.MAC == "aa:bb:cc:00:00:09" && b.Owner == router.OwnerAdmin && !b.Managed {
			mf = true
		}
		if b.MAC == "aa:bb:cc:00:00:02" && b.Partial && b.Owner == router.OwnerAdmin && !b.Managed {
			pcp = true
		}
	}
	if !mf || !pcp {
		t.Errorf("administrator rules not reported read-only: %+v", blocked)
	}
	if len(srv.Puts) != 0 {
		t.Errorf("reading block state changed something: %+v", srv.Puts)
	}
	_ = d.Close(ctx)
}

func TestCertificatePinIsEnforced(t *testing.T) {
	srv := start(t, fixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, func(tg *router.Target) {
		tg.PinSHA256 = strings.Repeat("ab", 32)
	})
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrCertificate) {
		t.Fatalf("pin mismatch: %v", err)
	}
	d2 := open(t, srv, &creds{user: "admin", pass: testPassword}, func(tg *router.Target) {
		tg.Transport, tg.PinSHA256 = router.TransportHTTPS, ""
	})
	if _, err := d2.Identify(context.Background()); !errors.Is(err, router.ErrCertificate) {
		t.Fatalf("self-signed certificate accepted without a pin: %v", err)
	}
}

func TestOpenRefusesUnauthorizedRouters(t *testing.T) {
	c := &creds{}
	cases := []struct {
		addr string
		auth []netip.Prefix
	}{
		{"192.168.1.2", []netip.Prefix{netip.MustParsePrefix("192.168.50.0/24")}}, // private but outside the scope
		{"8.8.8.8", []netip.Prefix{netip.MustParsePrefix("8.8.8.0/24")}},          // public, even if "authorized"
		{"127.0.0.1", []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},       // loopback without the test switch
	}
	for _, tc := range cases {
		_, err := router.Open(router.Target{Vendor: "zyxel", Address: netip.MustParseAddr(tc.addr), Transport: router.TransportHTTP},
			c.source, router.Options{Authorized: tc.auth})
		if !errors.Is(err, router.ErrNotAuthorized) {
			t.Errorf("%s: want not authorized, got %v", tc.addr, err)
		}
	}
	if c.calls != 0 {
		t.Error("credentials requested for a refused router")
	}
}
