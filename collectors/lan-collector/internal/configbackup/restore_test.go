package configbackup

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// junosDevice emulates the parts of the Junos CLI a restore uses: operational and configuration
// mode, "configure exclusive", "load override terminal" (input ended by ^D), "commit confirmed N",
// "rollback N", "commit" and "show configuration". A protocol test double on loopback only.
type junosDevice struct {
	mu        sync.Mutex
	running   string
	previous  string
	candidate string
	locked    bool
	pending   bool // commit confirmed, not yet confirmed
	confirmed bool
	commits   []string
	sessions  int
	// Faults.
	lockedByOther   bool
	rejectLoad      bool
	mangleOnCommit  bool // the device stores something else than what was loaded
	refuseReconnect bool // after the confirmed commit, new SSH sessions get no CLI (lost management)
	loadedText      string
	model, serial   string // reported by "show version" / "show chassis hardware" when set
}

const junosRunning = "## Last commit: 2026-11-20 10:00:00 UTC by netops\nversion 21.4R3.15;\nsystem {\n    host-name srx;\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet {\n                address 192.168.20.1/24;\n            }\n        }\n    }\n}"

const junosRestore = "## Last commit: 2026-11-01 08:00:00 UTC by netops\nversion 21.4R3.15;\nsystem {\n    host-name srx-old;\n    root-authentication {\n        encrypted-password \"$6$abc$def\";\n    }\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet {\n                address 192.168.20.1/24;\n            }\n        }\n    }\n}"

func (j *junosDevice) cli(ch ssh.Channel) {
	w := func(text string) { _, _ = io.WriteString(ch, strings.ReplaceAll(text, "\n", "\r\n")) }
	j.mu.Lock()
	j.sessions++
	if j.refuseReconnect && j.pending {
		j.mu.Unlock()
		w("error: the management interface is unreachable\n")
		return
	}
	j.mu.Unlock()
	op, cfg := "netops@srx> ", "netops@srx# "
	prompt := op
	inConfig := false
	w("--- JUNOS 21.4R3.15 Kernel 64-bit  JNPR-12.1\n" + prompt)
	buf := make([]byte, 1)
	readUntil := func(stop byte, echo bool) (string, bool) {
		var line []byte
		for {
			if _, err := ch.Read(buf); err != nil {
				return "", false
			}
			if buf[0] == stop || (stop == '\n' && buf[0] == '\r') {
				if stop == '\n' {
					w("\n")
				}
				return string(line), true
			}
			line = append(line, buf[0])
			if echo {
				_, _ = ch.Write(buf)
			}
		}
	}
	for {
		cmd, ok := readUntil('\n', true)
		if !ok {
			return
		}
		cmd = strings.TrimSpace(cmd)
		j.mu.Lock()
		switch {
		case cmd == "":
		case cmd == "set cli screen-length 0":
			w("Screen length set to 0\n")
		case cmd == "set cli screen-width 0":
			w("Screen width set to 0\n")
		case cmd == "show version | no-more" && j.model != "":
			w("Hostname: srx\nModel: " + j.model + "\nJunos: 21.4R3.15\n")
		case cmd == "show chassis hardware | no-more" && j.serial != "":
			w("Hardware inventory:\nItem             Version  Part number  Serial number     Description\nChassis                                " + j.serial + "      SRX300\n")
		case cmd == "show configuration | no-more" && !inConfig, cmd == "run show configuration | no-more" && inConfig:
			w(j.running + "\n")
		case cmd == "configure exclusive" && !inConfig:
			if j.lockedByOther || j.locked {
				w("error: configuration database locked by:\n  admin terminal p0 (pid 4242) on since 2026-11-22 09:00:00 UTC\n")
				break
			}
			j.locked, inConfig, prompt = true, true, cfg
			j.candidate = j.running
			w("warning: uncommitted changes will be discarded on exit\nEntering configuration mode\n\n[edit]\n")
		case cmd == "load override terminal" && inConfig:
			w(junosLoadPromptMarker + "\n")
			j.mu.Unlock()
			text, ok := readUntil(0x04, true)
			j.mu.Lock()
			if !ok {
				j.mu.Unlock()
				return
			}
			j.loadedText = text
			if j.rejectLoad {
				w("\nterminal:3:(5) syntax error: host-nme\n[edit system]\n  'host-nme srx-old;'\n    syntax error\nload complete (1 errors)\n")
				break
			}
			j.candidate = strings.TrimRight(text, "\n")
			w("\nload complete\n\n[edit]\n")
		case strings.HasPrefix(cmd, "commit confirmed ") && inConfig:
			j.previous = j.running
			j.running = j.candidate
			if j.mangleOnCommit {
				j.running = strings.Replace(j.running, "srx-old", "srx-mangled", 1)
			}
			j.pending, j.confirmed = true, false
			j.commits = append(j.commits, cmd)
			w("configuration check succeeds\ncommit confirmed will be automatically rolled back in " + strings.TrimPrefix(cmd, "commit confirmed ") + " minutes unless confirmed\ncommit complete\n\n[edit]\n")
		case cmd == "rollback 1" && inConfig:
			j.candidate = j.previous
			w("load complete\n\n[edit]\n")
		case cmd == "rollback 0" && inConfig:
			j.candidate = j.running
			w("load complete\n\n[edit]\n")
		case cmd == "commit" && inConfig:
			j.running = j.candidate
			if j.pending {
				j.pending, j.confirmed = false, true
			}
			j.commits = append(j.commits, cmd)
			w("commit complete\n\n[edit]\n")
		case cmd == "exit configuration-mode" && inConfig:
			inConfig, prompt, j.locked = false, op, false
			w("Exiting configuration mode\n\n")
		default:
			w("\nerror: unknown command: " + cmd + "\n")
		}
		j.mu.Unlock()
		w(prompt)
	}
}

func startJunos(t *testing.T, j *junosDevice) (*server, Target) {
	t.Helper()
	dev := &device{version: "SSH-2.0-OpenSSH_7.5", password: "s3cret-Pass", cliFn: j.cli}
	key := newHostKey(t)
	srv := startServer(t, dev, key)
	tg := target(srv)
	tg.HostKeySHA256 = ssh.FingerprintSHA256(key.PublicKey())
	tg.HostKeyType = key.PublicKey().Type()
	tg.Driver = junosDriverID
	return srv, tg
}

func TestRestoreJunosCommitConfirmedVerifiedOverSecondSession(t *testing.T) {
	j := &junosDevice{running: junosRunning}
	srv, tg := startJunos(t, j)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: junosRestore, ConfirmMinutes: 4}, opts(srv.addr))
	if err != nil {
		t.Fatalf("restore failed: %v (steps %v)", err, res.Steps)
	}
	if res.Method != RestoreMethodJunos || !res.Loaded || !res.Committed || !res.Confirmed || res.RolledBack {
		t.Fatalf("unexpected result: %+v", res)
	}
	if res.HostKeyStatus != "matched" {
		t.Fatalf("the pinned host key must be checked, got %q", res.HostKeyStatus)
	}
	if !strings.Contains(j.running, "host-name srx-old;") || j.pending || !j.confirmed || j.locked {
		t.Fatalf("device state after restore: running=%q pending=%v confirmed=%v locked=%v", j.running, j.pending, j.confirmed, j.locked)
	}
	if strings.Join(j.commits, ",") != "commit confirmed 4,commit" {
		t.Fatalf("commits = %v", j.commits)
	}
	if j.sessions != 2 {
		t.Fatalf("the read-back must use a second SSH session, got %d sessions", j.sessions)
	}
	if !strings.Contains(res.Config, "host-name srx-old;") || strings.Contains(res.Config, "netops@srx") {
		t.Fatalf("read-back config = %q", res.Config)
	}
	if !strings.Contains(j.loadedText, "encrypted-password \"$6$abc$def\";") {
		t.Fatal("the unsanitized configuration must be loaded (secrets included)")
	}
}

func TestRestoreUndoneWhenReadBackDiffers(t *testing.T) {
	j := &junosDevice{running: junosRunning, mangleOnCommit: true}
	srv, tg := startJunos(t, j)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: junosRestore}, opts(srv.addr))
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "differs") || !strings.Contains(err.Error(), "previous configuration was put back") {
		t.Fatalf("want a refused restore, got %v", err)
	}
	if !res.Committed || res.Confirmed || !res.RolledBack {
		t.Fatalf("unexpected result: %+v", res)
	}
	if j.running != junosRunning {
		t.Fatalf("the previous configuration must be active again, got %q", j.running)
	}
	if strings.Join(j.commits, ",") != "commit confirmed 5,commit" {
		t.Fatalf("commits = %v (default timer 5 minutes, then the undo commit)", j.commits)
	}
}

func TestRestoreUndoneWhenDeviceNotReachableAfterCommit(t *testing.T) {
	j := &junosDevice{running: junosRunning, refuseReconnect: true}
	srv, tg := startJunos(t, j)
	o := opts(srv.addr)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: junosRestore}, o)
	if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "new SSH session") {
		t.Fatalf("want a refused restore, got %v", err)
	}
	if res.Confirmed || !res.RolledBack || j.running != junosRunning {
		t.Fatalf("the commit must not be confirmed and must be undone: %+v running=%q", res, j.running)
	}
}

func TestRestoreRefusals(t *testing.T) {
	ctx := context.Background()

	t.Run("syntax error: candidate discarded, nothing committed", func(t *testing.T) {
		j := &junosDevice{running: junosRunning, rejectLoad: true}
		srv, tg := startJunos(t, j)
		res, err := Restore(ctx, tg, RestoreSpec{Config: junosRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "syntax error") {
			t.Fatalf("want ErrCommandFailed with the device's reason, got %v", err)
		}
		if res.Loaded || res.Committed || len(j.commits) != 0 || j.running != junosRunning || j.locked {
			t.Fatalf("nothing may be committed: %+v commits=%v", res, j.commits)
		}
	})

	t.Run("configuration locked by someone else", func(t *testing.T) {
		j := &junosDevice{running: junosRunning, lockedByOther: true}
		srv, tg := startJunos(t, j)
		_, err := Restore(ctx, tg, RestoreSpec{Config: junosRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "locked") || len(j.commits) != 0 {
			t.Fatalf("want a lock refusal, got %v", err)
		}
	})

	t.Run("not pinned, other vendor, bad text, out of scope", func(t *testing.T) {
		j := &junosDevice{running: junosRunning}
		srv, tg := startJunos(t, j)
		o := opts(srv.addr)
		unpinned := tg
		unpinned.HostKeySHA256 = ""
		if _, err := Restore(ctx, unpinned, RestoreSpec{Config: junosRestore}, o); KindOf(err) != ErrInvalidArgument {
			t.Fatalf("unpinned host key: want ErrInvalidArgument, got %v", err)
		}
		cisco := tg
		cisco.Driver = "cisco_ios"
		if _, err := Restore(ctx, cisco, RestoreSpec{Config: junosRestore}, o); KindOf(err) != ErrUnsupported {
			t.Fatalf("Cisco: want ErrUnsupported, got %v", err)
		}
		if _, err := Restore(ctx, tg, RestoreSpec{Config: "system {\x1b[2J}"}, o); KindOf(err) != ErrInvalidArgument {
			t.Fatalf("control characters: want ErrInvalidArgument, got %v", err)
		}
		far := tg
		far.Address = "10.9.9.9"
		if _, err := Restore(ctx, far, RestoreSpec{Config: junosRestore}, o); KindOf(err) != ErrOutOfScope {
			t.Fatalf("out of scope: want ErrOutOfScope, got %v", err)
		}
		if j.sessions != 0 {
			t.Fatalf("a refused restore must not even log in, got %d sessions", j.sessions)
		}
	})

	t.Run("changed host key: no credentials sent, nothing changed", func(t *testing.T) {
		j := &junosDevice{running: junosRunning}
		srv, tg := startJunos(t, j)
		tg.HostKeySHA256 = ssh.FingerprintSHA256(newHostKey(t).PublicKey())
		_, err := Restore(ctx, tg, RestoreSpec{Config: junosRestore}, opts(srv.addr))
		if KindOf(err) != ErrHostKeyChanged || j.sessions != 0 || srv.dev.authCalls.Load() != 0 {
			t.Fatalf("want ErrHostKeyChanged before login, got %v (sessions %d, auth %d)", err, j.sessions, srv.dev.authCalls.Load())
		}
	})
}

func TestRestoreMethodOnlyJunosAndVyOS(t *testing.T) {
	for _, d := range Drivers() {
		m := RestoreMethod(d.ID)
		if (d.ID == junosDriverID || d.ID == vyosDriverID) != (m != "") {
			t.Errorf("%s: restore method %q", d.ID, m)
		}
	}
	if !sameConfig("## Last commit: x\nsystem {\n    host-name a;  \n}\n\n", "system {\n    host-name a;\n}") || sameConfig("a;", "b;") {
		t.Fatal("sameConfig must ignore commit headers, trailing spaces and blank lines only")
	}
}

func TestRestoreJunosRefusesAnotherDeviceUnlessForced(t *testing.T) {
	j := &junosDevice{running: junosRunning, model: "srx300", serial: "CV0000NEW001"}
	srv, tg := startJunos(t, j)
	spec := RestoreSpec{Config: junosRestore, ExpectedIdentity: &DeviceIdentity{Model: "srx300", Serial: "CV0000OLD001"}}
	res, err := Restore(context.Background(), tg, spec, opts(srv.addr))
	if KindOf(err) != ErrDeviceMismatch || j.locked || len(j.commits) != 0 || res.Identity == nil || res.Identity.Serial != "CV0000NEW001" {
		t.Fatalf("want ErrDeviceMismatch before the lock, got %v (%+v, commits %v)", err, res, j.commits)
	}
	spec.AllowOtherDevice = true
	if res, err = Restore(context.Background(), tg, spec, opts(srv.addr)); err != nil || !res.Confirmed {
		t.Fatalf("forced: %v %+v", err, res)
	}
}
