package opnsense

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

	"github.com/nigafiy/sensor/internal/router"
)

const (
	opnCtlKey    = "opn-ctl-key"
	opnCtlSecret = "opn-ctl-secret-8841"
)

// opnControls is a protocol test double of the OPNsense REST API (Kea reservations, reboot),
// served over TLS with its own self-signed certificate.
type opnControls struct {
	mu           sync.Mutex
	rows         []map[string]any
	rebooted     bool
	reconfigures int
	failWrites   bool
	dnatCalls    int
	firmware     string
	dnat         []map[string]any // destination-NAT rules as get_rule returns them (with "uuid")
	dnatApplied  int
	nextUUID     int
	srv          *httptest.Server
}

func newOpnControls(t *testing.T) *opnControls {
	f := &opnControls{firmware: "25.1.4", rows: []map[string]any{{"uuid": "r1", "hw_address": "aa:bb:cc:00:00:10", "ip_address": "192.168.20.10"}}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *opnControls) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if k, s, ok := r.BasicAuth(); !ok || k != opnCtlKey || s != opnCtlSecret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/firewall/d_nat") {
		f.dnatCalls++
	}
	isWrite := r.URL.Path == "/api/kea/dhcpv4/addReservation" || strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/setReservation/") ||
		(r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/firewall/d_nat/")) || strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/") || r.URL.Path == "/api/core/system/reboot"
	if f.failWrites && isWrite {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "failed"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/firewall/d_nat/") {
		if !dnatAvailable(f.firmware) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.handleDNat(w, r)
		return
	}
	switch {
	case r.URL.Path == "/api/core/firmware/info":
		_ = json.NewEncoder(w).Encode(map[string]any{"product_name": "OPNsense", "product_version": f.firmware})
	case strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/setReservation/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/kea/dhcpv4/setReservation/")
		var b struct {
			Reservation map[string]any `json:"reservation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		for _, row := range f.rows {
			if row["uuid"] == id {
				if h, ok := b.Reservation["hostname"].(string); ok && strings.ContainsAny(h, " _") {
					_ = json.NewEncoder(w).Encode(map[string]any{"result": "failed", "validations": map[string]string{"reservation.hostname": "invalid hostname"}})
					return
				}
				for k, v := range b.Reservation {
					row[k] = v
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"result": "saved"})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "failed"})
	case r.URL.Path == "/api/diagnostics/system/systemTime":
		_ = json.NewEncoder(w).Encode(map[string]any{"uptime": "1 day, 02:00:00"})
	case r.URL.Path == "/api/diagnostics/interface/getInterfaceConfig":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"lan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "192.168.20.1", "subnetbits": 24}}},
			"wan": map[string]any{"status": "active", "ipv4": []map[string]any{{"ipaddr": "41.3.4.5"}}},
		})
	case r.URL.Path == "/api/kea/dhcpv4/searchReservation":
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": f.rows})
	case r.URL.Path == "/api/kea/dhcpv4/searchSubnet":
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": []map[string]any{{"uuid": "sub1", "subnet": "192.168.20.0/24"}}})
	case r.URL.Path == "/api/kea/dhcpv4/addReservation":
		var b struct {
			Reservation map[string]any `json:"reservation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		b.Reservation["uuid"] = "r2"
		f.rows = append(f.rows, b.Reservation)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "saved", "uuid": "r2"})
	case strings.HasPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/kea/dhcpv4/delReservation/")
		kept := f.rows[:0]
		for _, row := range f.rows {
			if row["uuid"] != id {
				kept = append(kept, row)
			}
		}
		f.rows = kept
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "deleted"})
	case r.URL.Path == "/api/kea/service/reconfigure":
		f.reconfigures++
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	case r.URL.Path == "/api/core/system/reboot":
		f.rebooted = true
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *opnControls) driver(t *testing.T, pin, secret string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "opn", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return opnCtlKey, []byte(secret), nil })
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
		if strings.Contains(s, opnCtlSecret) {
			t.Fatalf("%s leaked the API secret: %s", what, s)
		}
	}
}

func TestExtendedControls(t *testing.T) {
	f := newOpnControls(t)
	d := f.driver(t, "", opnCtlSecret)
	ctx := context.Background()

	s, err := d.Settings(ctx)
	if err != nil || s.Overview == nil || *s.Overview.UptimeSeconds != 93600 || len(s.Reservations) != 1 || s.Overview.LANIP != "192.168.20.1" {
		t.Fatalf("unexpected settings: err=%v s=%+v", err, s)
	}
	noSecret(t, "Settings", s)
	ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22")
	if err != nil || !ch.Applied || len(f.rows) != 2 || f.rows[1]["subnet"] != "sub1" {
		t.Fatalf("AddReservation failed: %+v %v rows=%v", ch, err, f.rows)
	}
	noSecret(t, "AddReservation", ch)
	if ch, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("AddReservation must be idempotent: %+v %v", ch, err)
	}
	if ch, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:22"); err != nil || !ch.Applied || len(f.rows) != 1 {
		t.Fatalf("RemoveReservation failed: %+v %v", ch, err)
	}
	if f.reconfigures != 2 {
		t.Fatalf("Kea must be reconfigured after each change, got %d", f.reconfigures)
	}
	if ch, err := d.Reboot(ctx); err != nil || !ch.Applied || !f.rebooted {
		t.Fatalf("Reboot failed: err=%v rebooted=%v", err, f.rebooted)
	}
}

// Before 26.1 port forwards are refused, honestly: the capability says why (with the firmware that
// was detected), a change is refused with ErrUnsupported, and nothing is sent to the destination-NAT API.
func TestPortForwardRefusedBefore26(t *testing.T) {
	f := newOpnControls(t)
	d := f.driver(t, "", opnCtlSecret)
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	pf := caps.Get(router.CapPortForward)
	if pf.Supported || !strings.Contains(pf.Note, "runs 25.1.4") || !strings.Contains(pf.Note, "Firewall → NAT → Port Forward") || !strings.Contains(pf.Note, "26.1") {
		t.Fatalf("want an unsupported port-forward capability naming the firmware, got %+v", pf)
	}
	if _, err := d.AddPortForward(context.Background(), router.PortForward{Protocol: "tcp", ExternalStart: 8080, InternalIP: "192.168.20.40"}); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}
	if _, err := d.RemovePortForward(context.Background(), router.PortForward{ID: "x", Protocol: "tcp", ExternalStart: 8080, InternalIP: "192.168.20.40"}); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}
	s, _ := d.Settings(context.Background())
	if s.PortForwards != nil || f.dnatCalls != 0 {
		t.Fatalf("no port-forward data may be invented or requested: %v, %d d_nat calls", s.PortForwards, f.dnatCalls)
	}
	if got := portForwardNote(""); !strings.Contains(got, "unknown version") {
		t.Fatalf("unexpected note without a version: %q", got)
	}
}

func TestControlsErrorPaths(t *testing.T) {
	ctx := context.Background()

	t.Run("router refuses writes", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", opnCtlSecret)
		f.failWrites = true
		_, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "192.168.20.22")
		if !errors.Is(err, router.ErrRejected) {
			t.Fatalf("want ErrRejected, got %v", err)
		}
		noSecret(t, "AddReservation error", err)
		if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:00:10"); !errors.Is(err, router.ErrRejected) || len(f.rows) != 1 {
			t.Fatalf("want ErrRejected and the reservation kept, got %v", err)
		}
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrRejected) || f.rebooted {
			t.Fatalf("want ErrRejected and no reboot, got %v", err)
		}
		if f.reconfigures != 0 {
			t.Fatal("a refused change must not be applied")
		}
	})

	t.Run("reservation outside the DHCP subnet never reaches the router", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", opnCtlSecret)
		if _, err := d.AddReservation(ctx, "aa:bb:cc:00:00:22", "10.99.0.5"); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("want ErrInvalidArgument, got %v", err)
		}
		if len(f.rows) != 1 {
			t.Fatal("refused input changed the router")
		}
	})

	t.Run("wrong API secret", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, "", "wrong-"+opnCtlSecret)
		_, err := d.Settings(ctx)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatalf("want ErrBadCredentials, got %v", err)
		}
		noSecret(t, "login error", err)
	})

	t.Run("certificate does not match the pin", func(t *testing.T) {
		f := newOpnControls(t)
		d := f.driver(t, strings.Repeat("ef", 32), opnCtlSecret)
		if _, err := d.Reboot(ctx); !errors.Is(err, router.ErrCertificate) || f.rebooted {
			t.Fatalf("want ErrCertificate and no reboot, got %v", err)
		}
	})
}

// dnatAvailable mirrors the release that added the destination-NAT API (26.1); the double answers
// 404 on older firmware, as a real OPNsense without the controller would.
func dnatAvailable(fw string) bool { return dnatSupported(fw) }

// handleDNat is the destination-NAT part of the double: search_rule / get_rule / add_rule /
// del_rule / apply as OPNsense 26.1 DNatController answers them, with the DNat.xml field layout.
func (f *opnControls) handleDNat(w http.ResponseWriter, r *http.Request) {
	f.dnatCalls++
	path := strings.TrimPrefix(r.URL.Path, "/api/firewall/d_nat/")
	enc := json.NewEncoder(w)
	switch {
	case r.Method == http.MethodGet && path == "search_rule":
		rows := []map[string]any{}
		for _, x := range f.dnat {
			rows = append(rows, map[string]any{"uuid": x["uuid"], "descr": x["descr"]})
		}
		_ = enc.Encode(map[string]any{"rows": rows, "rowCount": len(rows), "total": len(rows), "current": 1})
	case r.Method == http.MethodGet && strings.HasPrefix(path, "get_rule/"):
		id := strings.TrimPrefix(path, "get_rule/")
		for _, x := range f.dnat {
			if x["uuid"] == id {
				_ = enc.Encode(map[string]any{"rule": getRuleView(x)})
				return
			}
		}
		_ = enc.Encode(map[string]any{})
	case r.Method == http.MethodPost && path == "add_rule":
		var b struct {
			Rule map[string]any `json:"rule"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		dst, _ := b.Rule["destination"].(map[string]any)
		if b.Rule["target"] == "" || dst == nil || dst["port"] == "" {
			_ = enc.Encode(map[string]any{"result": "failed", "validations": map[string]string{"rule.target": "required"}})
			return
		}
		f.nextUUID++
		b.Rule["uuid"] = "dn-" + strconv.Itoa(f.nextUUID)
		f.dnat = append(f.dnat, b.Rule)
		_ = enc.Encode(map[string]any{"result": "saved", "uuid": b.Rule["uuid"]})
	case r.Method == http.MethodPost && strings.HasPrefix(path, "del_rule/"):
		id := strings.TrimPrefix(path, "del_rule/")
		kept := f.dnat[:0]
		found := false
		for _, x := range f.dnat {
			if x["uuid"] == id {
				found = true
				continue
			}
			kept = append(kept, x)
		}
		f.dnat = kept
		if !found {
			_ = enc.Encode(map[string]any{"result": "not found"})
			return
		}
		_ = enc.Encode(map[string]any{"result": "deleted"})
	case r.Method == http.MethodPost && path == "apply":
		f.dnatApplied++
		_ = enc.Encode(map[string]any{"status": "ok"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// getRuleView renders a stored rule the way MVC get_rule does: option fields as selection maps.
func getRuleView(x map[string]any) map[string]any {
	sel := func(chosen string, opts ...string) map[string]any {
		m := map[string]any{}
		for _, o := range opts {
			s := 0
			if o == chosen {
				s = 1
			}
			m[o] = map[string]any{"value": strings.ToUpper(o), "selected": s}
		}
		return m
	}
	dst, _ := x["destination"].(map[string]any)
	return map[string]any{
		"disabled":    x["disabled"],
		"interface":   sel(fmt.Sprint(x["interface"]), "wan", "lan"),
		"ipprotocol":  sel(fmt.Sprint(x["ipprotocol"]), "inet", "inet6", "inet46"),
		"protocol":    sel(fmt.Sprint(x["protocol"]), "", "tcp", "udp", "tcp/udp", "icmp"),
		"destination": map[string]any{"network": sel(fmt.Sprint(dst["network"]), "any", "wanip", "lanip"), "port": dst["port"]},
		"target":      x["target"],
		"local-port":  x["local-port"],
		"descr":       x["descr"],
		"pass":        sel(fmt.Sprint(x["pass"]), "", "pass", "rule"),
	}
}

func TestPortForwardsOn26(t *testing.T) {
	ctx := context.Background()
	f := newOpnControls(t)
	f.firmware = "26.1.2"
	// An administrator's rule that exists before (forwarding 2222 → 22 on the NAS).
	f.dnat = []map[string]any{{"uuid": "admin-1", "disabled": "0", "interface": "wan", "ipprotocol": "inet", "protocol": "tcp",
		"destination": map[string]any{"network": "wanip", "port": "2222"}, "target": "192.168.20.10", "local-port": "22", "descr": "NAS ssh", "pass": "pass"}}
	d := f.driver(t, "", opnCtlSecret)

	caps, err := d.Capabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c := caps.Get(router.CapPortForward); !c.Supported || c.Mechanism != mechPortForward {
		t.Fatalf("26.1 must offer port forwards: %+v", c)
	}
	s, err := d.Settings(ctx)
	if err != nil || len(s.PortForwards) != 1 {
		t.Fatalf("settings must list the administrator's rule: %v %+v", err, s.PortForwards)
	}
	admin := s.PortForwards[0]
	if admin.Owner != router.OwnerAdmin || admin.ExternalStart != 2222 || admin.InternalStart != 22 || admin.InternalIP != "192.168.20.10" || admin.Protocol != router.ProtoTCP {
		t.Fatalf("unexpected rule: %+v", admin)
	}
	noSecret(t, "Settings", s)

	ch, err := d.AddPortForward(ctx, router.PortForward{Description: "Game", Protocol: "both", ExternalStart: 27015, ExternalEnd: 27016, InternalIP: "192.168.20.40"})
	if err != nil || !ch.Applied || len(f.dnat) != 2 || f.dnatApplied != 1 {
		t.Fatalf("add failed: %+v %v rules=%v applied=%d", ch, err, f.dnat, f.dnatApplied)
	}
	made := f.dnat[1]
	dst := made["destination"].(map[string]any)
	if made["protocol"] != "tcp/udp" || dst["port"] != "27015-27016" || dst["network"] != "wanip" || made["target"] != "192.168.20.40" ||
		made["local-port"] != "27015" || made["descr"] != router.ProductRulePrefix+"Game" || made["interface"] != "wan" || made["ipprotocol"] != "inet" {
		t.Fatalf("rule sent in the wrong shape: %v", made)
	}
	noSecret(t, "AddPortForward", ch)

	s2, _ := d.Settings(ctx)
	var mine router.PortForward
	for _, p := range s2.PortForwards {
		if p.Owner == router.OwnerProduct {
			mine = p
		}
	}
	if mine.ID == "" || mine.ExternalEnd != 27016 || mine.InternalEnd != 27016 || mine.Protocol != router.ProtoBoth {
		t.Fatalf("the new rule must read back: %+v", s2.PortForwards)
	}

	// Refused before sending: management port, overlap with the admin's rule, outside the LAN, the router itself.
	for _, bad := range []router.PortForward{
		{Protocol: "tcp", ExternalStart: 443, InternalIP: "192.168.20.40"},
		{Protocol: "tcp", ExternalStart: 2222, InternalIP: "192.168.20.40"},
		{Protocol: "tcp", ExternalStart: 9000, InternalIP: "10.0.0.5"},
		{Protocol: "tcp", ExternalStart: 9000, InternalIP: "192.168.20.1"},
	} {
		if _, err := d.AddPortForward(ctx, bad); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("%+v: want ErrInvalidArgument, got %v", bad, err)
		}
	}
	if len(f.dnat) != 2 {
		t.Fatal("refused input changed the router")
	}

	// Removal checks the rule is still what the operator saw.
	changed := mine
	changed.InternalIP = "192.168.20.41"
	if _, err := d.RemovePortForward(ctx, changed); !errors.Is(err, router.ErrNotFound) || len(f.dnat) != 2 {
		t.Fatalf("a changed rule must be refused: %v", err)
	}
	ch, err = d.RemovePortForward(ctx, mine)
	if err != nil || !ch.Applied || len(f.dnat) != 1 || f.dnatApplied != 2 || !strings.Contains(ch.Undo, "192.168.20.40") {
		t.Fatalf("remove failed: %+v %v", ch, err)
	}
	if ch, err := d.RemovePortForward(ctx, mine); err != nil || ch.Applied {
		t.Fatalf("removing a rule that is gone must be a no-op: %+v %v", ch, err)
	}

	// The router refuses: error, rules unchanged, nothing applied.
	f.failWrites = true
	if _, err := d.AddPortForward(ctx, router.PortForward{Protocol: "udp", ExternalStart: 5000, InternalIP: "192.168.20.40"}); !errors.Is(err, router.ErrRejected) || len(f.dnat) != 1 || f.dnatApplied != 2 {
		t.Fatalf("want ErrRejected and no change, got %v", err)
	}
	if _, err := d.RemovePortForward(ctx, admin); !errors.Is(err, router.ErrRejected) || len(f.dnat) != 1 {
		t.Fatalf("want ErrRejected and the rule kept, got %v", err)
	}
}

func TestPortForwardAuthAndPinOn26(t *testing.T) {
	ctx := context.Background()
	f := newOpnControls(t)
	f.firmware = "26.1"
	rule := router.PortForward{Protocol: "tcp", ExternalStart: 8080, InternalIP: "192.168.20.40"}
	if _, err := f.driver(t, "", "wrong-"+opnCtlSecret).AddPortForward(ctx, rule); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	} else {
		noSecret(t, "error", err)
	}
	if _, err := f.driver(t, strings.Repeat("ab", 32), opnCtlSecret).AddPortForward(ctx, rule); !errors.Is(err, router.ErrCertificate) {
		t.Fatalf("want ErrCertificate, got %v", err)
	}
	if len(f.dnat) != 0 || f.dnatCalls != 0 {
		t.Fatal("nothing may be sent with a wrong secret or certificate")
	}
}

func TestDNatVersionGate(t *testing.T) {
	for fw, want := range map[string]bool{"26.1": true, "26.1.2": true, "26.4": true, "26.10": true, "27.1": true, "25.7.9": false, "25.10": false, "25.1.4": false, "": false, "abc": false, "26": false} {
		if got := dnatSupported(fw); got != want {
			t.Errorf("%q: got %v want %v", fw, got, want)
		}
	}
}

// Rename is stored as the host name of the device's Kea reservation.
func TestRenameThroughKeaReservation(t *testing.T) {
	ctx := context.Background()
	f := newOpnControls(t)
	d := f.driver(t, "", opnCtlSecret)
	caps, _ := d.Capabilities(ctx)
	if c := caps.Get(router.CapRename); !c.Supported || c.Requires != router.RequiresReservation {
		t.Fatalf("rename must be offered through the reservation: %+v", c)
	}
	ch, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "office-printer")
	if err != nil || !ch.Applied || f.rows[0]["hostname"] != "office-printer" || f.reconfigures != 1 {
		t.Fatalf("rename failed: %+v %v %v", ch, err, f.rows)
	}
	noSecret(t, "RenameClient", ch)
	if ch, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "office-printer"); err != nil || ch.Applied || !ch.AlreadyInEffect {
		t.Fatalf("same name must be a no-op: %+v %v", ch, err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:77", "phone"); !errors.Is(err, router.ErrNotFound) {
		t.Fatalf("want ErrNotFound without a reservation, got %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "my printer"); !errors.Is(err, router.ErrInvalidArgument) || f.rows[0]["hostname"] != "office-printer" {
		t.Fatalf("an invalid host name must be refused before sending: %v", err)
	}
	f.failWrites = true
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:00:10", "other"); !errors.Is(err, router.ErrRejected) || f.rows[0]["hostname"] != "office-printer" {
		t.Fatalf("want ErrRejected and no change, got %v", err)
	}
	f.failWrites = false
	if _, err := f.driver(t, "", "bad").RenameClient(ctx, "aa:bb:cc:00:00:10", "x1"); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
	if _, err := f.driver(t, strings.Repeat("12", 32), opnCtlSecret).RenameClient(ctx, "aa:bb:cc:00:00:10", "x1"); !errors.Is(err, router.ErrCertificate) || f.rows[0]["hostname"] != "office-printer" {
		t.Fatalf("want ErrCertificate, got %v", err)
	}
}
