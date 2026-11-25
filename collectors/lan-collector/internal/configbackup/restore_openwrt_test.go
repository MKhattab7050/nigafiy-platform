package configbackup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// owrtDevice emulates the parts of OpenWrt a restore uses over SSH exec channels: /etc/openwrt_release,
// "uci export", "ubus -v list", "ubus call system board" and rpcd's session / uci objects (session
// create / grant / destroy; uci get / delete / add / revert / apply with rollback / confirm /
// rollback), with per-session staged changes like rpcd's savedir. A protocol test double on loopback.
type owrtDevice struct {
	mu        sync.Mutex
	committed map[string]*owrtPkg
	order     []string
	staged    map[string]map[string]*owrtPkg // sid → package → staged copy
	granted   map[string]bool
	snapshot  map[string]*owrtPkg
	applySID  string
	connects  int
	model     string
	nextID    int
	calls     []string
	// Faults.
	rejectAdd       string // an "add" whose values contain this is refused
	mangleOnApply   bool   // apply activates something else than the staged packages
	refuseReconnect bool   // while an apply is pending, new exec channels fail
	denyApply       bool   // apply refused before anything is committed (another apply pending)
	noRollback      bool   // old rpcd without apply rollback
	confirmed       bool
	rolledBack      bool
}

type owrtSec struct {
	id   string
	anon bool
	s    *uciSection
}

type owrtPkg struct {
	name string
	secs []*owrtSec
}

func (p *owrtPkg) clone() *owrtPkg {
	c := &owrtPkg{name: p.name}
	for _, s := range p.secs {
		cs := *s.s
		cs.Options = append([]uciOption(nil), s.s.Options...)
		c.secs = append(c.secs, &owrtSec{id: s.id, anon: s.anon, s: &cs})
	}
	return c
}

func (p *owrtPkg) export() *uciPackage {
	u := &uciPackage{Name: p.name}
	for _, s := range p.secs {
		cs := *s.s
		if s.anon {
			cs.Name = ""
		}
		u.Sections = append(u.Sections, &cs)
	}
	return u
}

const owrtRunning = `package network

config interface 'loopback'
	option device 'lo'
	option proto 'static'
	option ipaddr '127.0.0.1'

config interface 'lan'
	option device 'br-lan'
	option proto 'static'
	option ipaddr '192.168.1.1'
	list dns '1.1.1.1'

package firewall

config defaults
	option input 'REJECT'

config rule
	option name 'Allow-Ping'
	option target 'ACCEPT'

package rpcd

config rpcd
	option socket '/var/run/ubus/ubus.sock'
`

const owrtRestore = `package network

config interface 'loopback'
	option device 'lo'
	option proto 'static'
	option ipaddr '127.0.0.1'

config interface 'lan'
	option device 'br-lan'
	option proto 'static'
	option ipaddr '192.168.1.1'
	list dns '9.9.9.9'
	list dns '149.112.112.112'

config interface 'guest'
	option proto 'static'
	option ipaddr '10.9.0.1'
	option description 'It'\''s the guest net'

package firewall

config defaults
	option input 'REJECT'

config rule
	option name 'Allow-DHCP'
	option target 'ACCEPT'

config rule
	option name 'Allow-Ping'
	option target 'ACCEPT'

package rpcd

config rpcd
	option socket '/var/run/ubus/ubus.sock'
`

func (d *owrtDevice) load(text string) {
	pkgs, ok := parseUCIExport(text)
	if !ok {
		panic("bad fixture")
	}
	d.committed, d.order = map[string]*owrtPkg{}, nil
	for _, p := range pkgs {
		op := &owrtPkg{name: p.Name}
		for _, s := range p.Sections {
			op.secs = append(op.secs, d.newSec(s))
		}
		d.committed[p.Name] = op
		d.order = append(d.order, p.Name)
	}
}

func (d *owrtDevice) newSec(s *uciSection) *owrtSec {
	if s.Name != "" {
		return &owrtSec{id: s.Name, s: s}
	}
	d.nextID++
	return &owrtSec{id: fmt.Sprintf("cfg%06x", d.nextID), anon: true, s: s}
}

func (d *owrtDevice) exportText() string {
	var pkgs []*uciPackage
	for _, n := range d.order {
		pkgs = append(pkgs, d.committed[n].export())
	}
	return renderUCI(pkgs)
}

func (d *owrtDevice) stagedPkg(sid, name string) *owrtPkg {
	if d.staged[sid] == nil {
		d.staged[sid] = map[string]*owrtPkg{}
	}
	if p := d.staged[sid][name]; p != nil {
		return p
	}
	c := d.committed[name]
	if c == nil {
		return nil
	}
	d.staged[sid][name] = c.clone()
	return d.staged[sid][name]
}

func (d *owrtDevice) exec(cmd string, stdin io.Reader, out io.Writer) uint32 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, cmd)
	if d.refuseReconnect && d.applySID != "" {
		_, _ = io.WriteString(out, "ssh: management address unreachable\n")
		return 255
	}
	say := func(s string) uint32 { _, _ = io.WriteString(out, s); return 0 }
	switch cmd {
	case "cat /etc/openwrt_release":
		return say("DISTRIB_ID='OpenWrt'\nDISTRIB_RELEASE='23.05.5'\n")
	case "ubus call system board":
		return say(`{"kernel": "5.15.167", "hostname": "OpenWrt", "model": "` + d.model + `", "board_name": "tplink,archer-c7-v5"}` + "\n")
	case "ubus -v list uci":
		if d.noRollback {
			return say("'uci' @1a2b3c4d\n\t\"get\":{\"config\":\"String\"}\n\t\"apply\":{\"timeout\":\"Integer\"}\n")
		}
		return say("'uci' @1a2b3c4d\n\t\"get\":{\"config\":\"String\"}\n\t\"apply\":{\"rollback\":\"Boolean\",\"timeout\":\"Integer\",\"ubus_rpc_session\":\"String\"}\n\t\"confirm\":{\"ubus_rpc_session\":\"String\"}\n\t\"rollback\":{\"ubus_rpc_session\":\"String\"}\n")
	case "ubus -v list session":
		return say("'session' @5e6f7a8b\n\t\"create\":{\"timeout\":\"Integer\"}\n\t\"grant\":{\"ubus_rpc_session\":\"String\",\"scope\":\"String\",\"objects\":\"Array\"}\n")
	case "uci export":
		return say(d.exportText())
	}
	var obj, method string
	if n, _ := fmt.Sscanf(cmd, "ubus call %s %s", &obj, &method); n != 2 || !strings.HasSuffix(cmd, `"$(cat)"`) {
		_, _ = io.WriteString(out, "ash: unknown command\n")
		return 127
	}
	d.mu.Unlock()
	raw, _ := io.ReadAll(stdin)
	d.mu.Lock()
	var a struct {
		SID      string          `json:"ubus_rpc_session"`
		Config   string          `json:"config"`
		Section  string          `json:"section"`
		Type     string          `json:"type"`
		Name     string          `json:"name"`
		Values   json.RawMessage `json:"values"`
		Scope    string          `json:"scope"`
		Rollback bool            `json:"rollback"`
		Timeout  int             `json:"timeout"`
	}
	if json.Unmarshal(raw, &a) != nil {
		_, _ = io.WriteString(out, "Command failed: Invalid argument\n")
		return 2
	}
	failed := func(why string) uint32 { _, _ = io.WriteString(out, "Command failed: "+why+"\n"); return 4 }
	switch obj + "." + method {
	case "session.create":
		sid := fmt.Sprintf("%032x", 0xabc0+len(d.granted))
		d.granted[sid] = false
		return say(`{"ubus_rpc_session": "` + sid + `", "timeout": 1200}` + "\n")
	case "session.grant":
		if _, ok := d.granted[a.SID]; !ok || a.Scope != "uci" {
			return failed("Not found")
		}
		d.granted[a.SID] = true
		return 0
	case "session.destroy":
		delete(d.granted, a.SID)
		delete(d.staged, a.SID)
		return 0
	}
	if !d.granted[a.SID] {
		return failed("Permission denied")
	}
	switch method {
	case "get":
		p := d.stagedPkg(a.SID, a.Config)
		if p == nil {
			return failed("Not found")
		}
		vals := map[string]map[string]any{}
		for i, s := range p.secs {
			vals[s.id] = map[string]any{".anonymous": s.anon, ".type": s.s.Type, ".name": s.id, ".index": i}
		}
		b, _ := json.Marshal(map[string]any{"values": vals})
		return say(string(b) + "\n")
	case "delete":
		p := d.stagedPkg(a.SID, a.Config)
		if p == nil {
			return failed("Not found")
		}
		for i, s := range p.secs {
			if s.id == a.Section {
				p.secs = append(p.secs[:i], p.secs[i+1:]...)
				return 0
			}
		}
		return failed("Not found")
	case "add":
		p := d.stagedPkg(a.SID, a.Config)
		if p == nil {
			return failed("Not found")
		}
		if d.rejectAdd != "" && strings.Contains(string(a.Values), d.rejectAdd) {
			return failed("Invalid argument")
		}
		s := &uciSection{Type: a.Type, Name: a.Name}
		if len(a.Values) > 0 {
			dec := json.NewDecoder(strings.NewReader(string(a.Values)))
			_, _ = dec.Token()
			for dec.More() {
				k, _ := dec.Token()
				var v any
				_ = dec.Decode(&v)
				switch x := v.(type) {
				case string:
					s.Options = append(s.Options, uciOption{Key: k.(string), Value: x})
				case []any:
					for _, e := range x {
						s.Options = append(s.Options, uciOption{Key: k.(string), List: true, Value: e.(string)})
					}
				}
			}
		}
		sec := d.newSec(s)
		p.secs = append(p.secs, sec)
		return say(`{"section": "` + sec.id + `"}` + "\n")
	case "revert":
		if d.staged[a.SID] != nil {
			delete(d.staged[a.SID], a.Config)
		}
		return 0
	case "apply":
		if d.denyApply || d.applySID != "" {
			return failed("Permission denied")
		}
		if !a.Rollback || a.Timeout <= 0 {
			return failed("Invalid argument")
		}
		d.snapshot = map[string]*owrtPkg{}
		for name, p := range d.staged[a.SID] {
			d.snapshot[name] = d.committed[name].clone()
			d.committed[name] = p
		}
		if d.mangleOnApply {
			d.committed["firewall"].secs = d.committed["firewall"].secs[:1]
		}
		delete(d.staged, a.SID)
		d.applySID = a.SID
		return 0
	case "confirm":
		if d.applySID == "" {
			return failed("No data")
		}
		if d.applySID != a.SID {
			return failed("Permission denied")
		}
		d.applySID, d.snapshot, d.confirmed = "", nil, true
		return 0
	case "rollback":
		if d.applySID == "" || d.applySID != a.SID {
			return failed("Permission denied")
		}
		for name, p := range d.snapshot {
			d.committed[name] = p
		}
		d.applySID, d.snapshot, d.rolledBack = "", nil, true
		return 0
	}
	return failed("Method not found")
}

// timerExpires is what rpcd does when the rollback timer runs out.
func (d *owrtDevice) timerExpires() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for name, p := range d.snapshot {
		d.committed[name] = p
	}
	d.applySID, d.snapshot = "", nil
}

func startOpenWrt(t *testing.T, d *owrtDevice) (*server, Target) {
	t.Helper()
	old := openwrtSettle
	openwrtSettle = 0
	t.Cleanup(func() { openwrtSettle = old })
	if d.committed == nil {
		d.load(owrtRunning)
	}
	d.staged, d.granted = map[string]map[string]*owrtPkg{}, map[string]bool{}
	dev := &device{version: "SSH-2.0-dropbear_2022.83", password: "s3cret-Pass", noShell: true, execFn: func(cmd string, ch ssh.Channel) uint32 { return d.exec(cmd, ch, ch) }}
	key := newHostKey(t)
	srv := startServer(t, dev, key)
	tg := target(srv)
	tg.HostKeySHA256 = ssh.FingerprintSHA256(key.PublicKey())
	tg.HostKeyType = key.PublicKey().Type()
	tg.Driver = openwrtDriverID
	return srv, tg
}

func TestParseUCIExportQuotingAndRender(t *testing.T) {
	pkgs, ok := parseUCIExport(owrtRestore)
	if !ok || len(pkgs) != 3 {
		t.Fatalf("parse failed: %v %d", ok, len(pkgs))
	}
	guest := pkgs[0].Sections[2]
	if guest.Name != "guest" || guest.Options[2].Value != "It's the guest net" {
		t.Fatalf("guest section = %+v", guest)
	}
	if !sameUCI(owrtRestore, renderUCI(pkgs)) {
		t.Fatal("render does not round-trip")
	}
	if !sameUCI("package a\nconfig x 'y'\n\toption k \"v w\"\n", "package a\n\nconfig x y\n\toption k 'v w'\n\n") {
		t.Fatal("quoting variants must compare equal")
	}
	for _, bad := range []string{"", "config x\n", "package a\nrm -rf /\n", "package a\nconfig x 'unterminated\n", "package a b\n", "package a\nconfig x 'y-z'\n"} {
		if _, ok := parseUCIExport(bad); ok {
			t.Fatalf("parsed %q", bad)
		}
	}
	if v := sectionValues(pkgs[0].Sections[1]); v != `{"device":"br-lan","proto":"static","ipaddr":"192.168.1.1","dns":["9.9.9.9","149.112.112.112"]}` {
		t.Fatalf("values = %s", v)
	}
}

func TestRestoreOpenWrtApplyRollbackConfirmed(t *testing.T) {
	d := &owrtDevice{model: "TP-Link Archer C7 v5"}
	srv, tg := startOpenWrt(t, d)
	o := opts(srv.addr)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: owrtRestore, ConfirmMinutes: 3, ExpectedIdentity: &DeviceIdentity{Model: "TP-Link Archer C7 v5"}}, o)
	if err != nil {
		t.Fatalf("restore failed: %v (steps %v)", err, res.Steps)
	}
	if res.Method != RestoreMethodOpenWrt || !res.Loaded || !res.Committed || !res.Confirmed || res.RolledBack {
		t.Fatalf("result = %+v", res)
	}
	if !sameUCI(d.exportText(), owrtRestore) || !sameUCI(res.Config, owrtRestore) || !d.confirmed || d.applySID != "" {
		t.Fatalf("device after restore:\n%s", d.exportText())
	}
	if res.Identity == nil || res.Identity.Model != "TP-Link Archer C7 v5" {
		t.Fatalf("identity = %+v", res.Identity)
	}
	// Only the changed packages were staged; rpcd's own configuration was not touched.
	for _, c := range d.calls {
		if strings.Contains(c, "uci import") || strings.Contains(c, "192.168") || strings.Contains(c, "9.9.9.9") {
			t.Fatalf("configuration values on a command line: %q", c)
		}
	}
	// Anonymous sections are recreated in the version's order.
	fw := d.committed["firewall"].export()
	if fw.Sections[1].Options[0].Value != "Allow-DHCP" || fw.Sections[2].Options[0].Value != "Allow-Ping" {
		t.Fatalf("firewall order = %s", fw.render())
	}
	// Nothing to do the second time.
	res, err = Restore(context.Background(), tg, RestoreSpec{Config: owrtRestore}, o)
	if err != nil || res.Committed || !strings.Contains(strings.Join(res.Steps, "|"), "already runs") {
		t.Fatalf("second restore: %v %+v", err, res)
	}
}

func TestRestoreOpenWrtRolledBackWhenReadBackDiffers(t *testing.T) {
	d := &owrtDevice{mangleOnApply: true}
	srv, tg := startOpenWrt(t, d)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: owrtRestore}, opts(srv.addr))
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "differs") || !strings.Contains(err.Error(), "put back") {
		t.Fatalf("want a rolled back restore, got %v", err)
	}
	if !res.Committed || res.Confirmed || !res.RolledBack || !d.rolledBack || !sameUCI(d.exportText(), owrtRunning) {
		t.Fatalf("result %+v, device:\n%s", res, d.exportText())
	}
}

func TestRestoreOpenWrtUnreachableAfterApplyLeavesTimer(t *testing.T) {
	d := &owrtDevice{refuseReconnect: true}
	srv, tg := startOpenWrt(t, d)
	o := opts(srv.addr)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: owrtRestore, ConfirmMinutes: 2}, o)
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "within 2 minutes") {
		t.Fatalf("want the timer to remain, got %v (steps %v)", err, res.Steps)
	}
	if !res.Committed || res.Confirmed || res.RolledBack || d.applySID == "" {
		t.Fatalf("result %+v pending=%q", res, d.applySID)
	}
	d.timerExpires()
	if !sameUCI(d.exportText(), owrtRunning) {
		t.Fatalf("rpcd's timer must restore the snapshot:\n%s", d.exportText())
	}
}

func TestRestoreOpenWrtRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("refused section reverts the staged changes", func(t *testing.T) {
		d := &owrtDevice{rejectAdd: "guest net"}
		srv, tg := startOpenWrt(t, d)
		res, err := Restore(ctx, tg, RestoreSpec{Config: owrtRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "nothing was changed") || res.Committed {
			t.Fatalf("got %v %+v", err, res)
		}
		if !sameUCI(d.exportText(), owrtRunning) || len(d.staged) != 0 || len(d.granted) != 0 {
			t.Fatalf("staged %v granted %v", d.staged, d.granted)
		}
	})
	t.Run("apply refused", func(t *testing.T) {
		d := &owrtDevice{denyApply: true}
		srv, tg := startOpenWrt(t, d)
		res, err := Restore(ctx, tg, RestoreSpec{Config: owrtRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "nothing was changed") || res.Committed || !sameUCI(d.exportText(), owrtRunning) {
			t.Fatalf("got %v %+v", err, res)
		}
	})
	t.Run("another device", func(t *testing.T) {
		d := &owrtDevice{model: "GL.iNet GL-MT6000"}
		srv, tg := startOpenWrt(t, d)
		spec := RestoreSpec{Config: owrtRestore, ExpectedIdentity: &DeviceIdentity{Model: "TP-Link Archer C7 v5"}}
		res, err := Restore(ctx, tg, spec, opts(srv.addr))
		if KindOf(err) != ErrDeviceMismatch || res.Loaded || !sameUCI(d.exportText(), owrtRunning) {
			t.Fatalf("got %v %+v", err, res)
		}
		spec.AllowOtherDevice = true
		if res, err = Restore(ctx, tg, spec, opts(srv.addr)); err != nil || !res.Confirmed {
			t.Fatalf("forced restore: %v %+v", err, res)
		}
	})
	t.Run("old rpcd", func(t *testing.T) {
		d := &owrtDevice{noRollback: true}
		srv, tg := startOpenWrt(t, d)
		if _, err := Restore(ctx, tg, RestoreSpec{Config: owrtRestore}, opts(srv.addr)); KindOf(err) != ErrUnsupported {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("different packages", func(t *testing.T) {
		d := &owrtDevice{}
		srv, tg := startOpenWrt(t, d)
		v := owrtRestore + "\npackage dropbear\n\nconfig dropbear\n\toption Port '22'\n"
		if _, err := Restore(ctx, tg, RestoreSpec{Config: v}, opts(srv.addr)); KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "missing on the device: dropbear") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("rpcd package changed", func(t *testing.T) {
		d := &owrtDevice{}
		srv, tg := startOpenWrt(t, d)
		v := strings.Replace(owrtRestore, "/var/run/ubus/ubus.sock", "/tmp/other.sock", 1)
		if _, err := Restore(ctx, tg, RestoreSpec{Config: v}, opts(srv.addr)); KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "rpcd") {
			t.Fatalf("got %v", err)
		}
		if len(d.granted) != 0 {
			t.Fatal("no session may be created")
		}
	})
	t.Run("not a uci export", func(t *testing.T) {
		d := &owrtDevice{}
		srv, tg := startOpenWrt(t, d)
		if _, err := Restore(ctx, tg, RestoreSpec{Config: "set system host-name x"}, opts(srv.addr)); KindOf(err) != ErrInvalidArgument {
			t.Fatalf("got %v", err)
		}
		if len(d.calls) != 0 {
			t.Fatalf("nothing may run: %v", d.calls)
		}
	})
}

func TestOpenWrtIdentityParsing(t *testing.T) {
	id := parseIdentity(openwrtDriverID, []string{`{"kernel": "5.15", "model": "Linksys E8450 (UBI)", "board_name": "linksys,e8450-ubi"}`})
	if id == nil || id.Model != "Linksys E8450 (UBI)" || id.Serial != "" {
		t.Fatalf("identity = %+v", id)
	}
	if parseIdentity(openwrtDriverID, []string{"Command failed: Not found"}) != nil {
		t.Fatal("no identity expected")
	}
}
