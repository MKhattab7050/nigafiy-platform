package configbackup

import (
	"bufio"
	"context"
	"crypto/md5" //nolint:gosec // the double answers "verify /md5" like IOS XE
	"encoding/hex"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// iosxeDevice emulates the parts of IOS XE a restore uses: privileged EXEC, show version,
// show running-config, dir, the SCP sink ("scp -t"), verify /md5, configure replace … revert trigger
// error timer N, configure confirm, configure revert now, write memory and delete. A protocol test
// double on loopback only; no real device is ever contacted.
type iosxeDevice struct {
	mu        sync.Mutex
	running   string
	previous  string
	files     map[string]string
	pending   bool
	confirmed bool
	saved     bool
	sessions  int
	cmds      []string
	// Faults / variants.
	classicIOS      bool // show version reports classic IOS
	noArchive       bool
	noTimerSyntax   bool // older IOS XE: "revert trigger" unknown
	rejectReplace   bool // a command of the file fails: the device reverts by itself
	mangleOnReplace bool
	refuseReconnect bool
	noSCP           bool
	corruptUpload   bool
	noBootflash     bool
}

const iosxeRunning = "Building configuration...\n\nCurrent configuration : 812 bytes\n!\nversion 17.9\nhostname R1\n!\narchive\n path bootflash:archive\n maximum 5\n!\ninterface GigabitEthernet1\n ip address 192.168.30.1 255.255.255.0\n!\nip scp server enable\nend"

const iosxeRestore = "version 17.9\nhostname R1-old\n!\nenable secret 9 $9$abc$def\n!\narchive\n path bootflash:archive\n maximum 5\n!\ninterface GigabitEthernet1\n ip address 192.168.30.1 255.255.255.0\n!\nip scp server enable\nend"

func (x *iosxeDevice) scp(cmd string, ch ssh.Channel) uint32 {
	x.mu.Lock()
	no := x.noSCP
	x.mu.Unlock()
	if no || !strings.HasPrefix(cmd, "scp -t ") {
		_, _ = ch.Write([]byte{1})
		_, _ = io.WriteString(ch, "scp: permission denied\n")
		return 1
	}
	dest := strings.TrimPrefix(cmd, "scp -t ")
	_, _ = ch.Write([]byte{0})
	r := bufio.NewReader(ch)
	hdr, err := r.ReadString('\n')
	if err != nil {
		return 1
	}
	f := strings.Fields(hdr)
	if len(f) != 3 || f[0] != "C0644" {
		_, _ = ch.Write([]byte{1})
		return 1
	}
	n, _ := strconv.Atoi(f[1])
	_, _ = ch.Write([]byte{0})
	data := make([]byte, n+1)
	if _, err := io.ReadFull(r, data); err != nil {
		return 1
	}
	x.mu.Lock()
	text := string(data[:n])
	if x.corruptUpload {
		text += "garbage\n"
	}
	x.files[dest] = text
	x.mu.Unlock()
	_, _ = ch.Write([]byte{0})
	return 0
}

func (x *iosxeDevice) cli(ch ssh.Channel) {
	w := func(text string) { _, _ = io.WriteString(ch, strings.ReplaceAll(text, "\n", "\r\n")) }
	x.mu.Lock()
	x.sessions++
	if x.refuseReconnect && x.pending {
		x.mu.Unlock()
		w("% Connection refused by remote host\n")
		return
	}
	x.mu.Unlock()
	prompt := "R1#"
	w("\n" + prompt)
	buf := make([]byte, 1)
	readLine := func() (string, bool) {
		var line []byte
		for {
			if _, err := ch.Read(buf); err != nil {
				return "", false
			}
			if buf[0] == '\r' || buf[0] == '\n' {
				w("\n")
				return string(line), true
			}
			line = append(line, buf[0])
			_, _ = ch.Write(buf)
		}
	}
	for {
		cmd, ok := readLine()
		if !ok {
			return
		}
		cmd = strings.TrimSpace(cmd)
		x.mu.Lock()
		x.cmds = append(x.cmds, cmd)
		switch {
		case cmd == "", cmd == "terminal length 0", cmd == "terminal width 0":
		case cmd == "show version":
			if x.classicIOS {
				w("Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E8\n")
			} else {
				w("Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.9.4a\n")
			}
		case cmd == "show running-config":
			run := x.running
			if x.noArchive {
				run = strings.Replace(run, "archive\n path bootflash:archive\n maximum 5\n", "", 1)
			}
			w(run + "\n")
		case cmd == "dir bootflash:":
			if x.noBootflash {
				w("%Error opening bootflash:/ (No such device)\n")
			} else {
				w("Directory of bootflash:/\n\n   11  drwx            16384  Nov 1 2026 10:00:00 +00:00  lost+found\n")
			}
		case strings.HasPrefix(cmd, "verify /md5 "):
			file := strings.TrimPrefix(cmd, "verify /md5 ")
			text, ok := x.files[file]
			if !ok {
				w("%Error verifying " + file + " (No such file or directory)\n")
				break
			}
			sum := md5.Sum([]byte(text)) //nolint:gosec // emulating IOS XE
			w("..........\nverify /md5 (" + file + ") = " + hex.EncodeToString(sum[:]) + "\n")
		case strings.HasPrefix(cmd, "configure replace "):
			f := strings.Fields(cmd)
			file := f[2]
			if x.noTimerSyntax {
				w("                                                      ^\n% Invalid input detected at '^' marker.\n")
				break
			}
			text, ok := x.files[file]
			if !ok {
				w("%Error opening " + file + " (No such file or directory)\n")
				break
			}
			if x.rejectReplace {
				w("Total number of passes: 1\n%Rollback aborted: a command failed: enable secret 9 $9$abc$def\nReverting to the previous configuration\n")
				break
			}
			x.previous = x.running
			x.running = "Building configuration...\n\nCurrent configuration : 790 bytes\n!\n" + strings.TrimRight(text, "\n")
			if x.mangleOnReplace {
				x.running = strings.Replace(x.running, "R1-old", "R1-mangled", 1)
			}
			x.pending, x.confirmed = true, false
			w("Timer has been set for " + f[len(f)-1] + " min(s), use 'configure confirm' to stop the timer\nTotal number of passes: 1\nRollback Done\n\n")
		case cmd == "configure confirm":
			if !x.pending {
				w("%No Rollback Confirmation timer is running\n")
				break
			}
			x.pending, x.confirmed = false, true
		case cmd == "configure revert now":
			if x.pending {
				x.running, x.pending = x.previous, false
				w("Rollback Done\n")
			} else {
				w("%No Rollback Confirmation timer is running\n")
			}
		case cmd == "write memory":
			x.saved = true
			w("Building configuration...\n[OK]\n")
		case strings.HasPrefix(cmd, "delete /force "):
			delete(x.files, strings.TrimPrefix(cmd, "delete /force "))
		default:
			w("                ^\n% Invalid input detected at '^' marker.\n")
		}
		x.mu.Unlock()
		w(prompt)
	}
}

func startIOSXE(t *testing.T, x *iosxeDevice) (*server, Target) {
	t.Helper()
	x.files = map[string]string{}
	dev := &device{version: "SSH-2.0-Cisco-1.25", password: "s3cret-Pass", cliFn: x.cli, execFn: x.scp}
	key := newHostKey(t)
	srv := startServer(t, dev, key)
	tg := target(srv)
	tg.HostKeySHA256 = ssh.FingerprintSHA256(key.PublicKey())
	tg.HostKeyType = key.PublicKey().Type()
	tg.Driver = iosxeDriverID
	return srv, tg
}

func (x *iosxeDevice) sent(prefix string) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, c := range x.cmds {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func TestRestoreIOSXEConfigureReplaceVerifiedThenSaved(t *testing.T) {
	x := &iosxeDevice{running: iosxeRunning}
	srv, tg := startIOSXE(t, x)
	res, err := Restore(context.Background(), tg, RestoreSpec{Config: iosxeRestore, ConfirmMinutes: 4}, opts(srv.addr))
	if err != nil {
		t.Fatalf("restore failed: %v (steps %v)", err, res.Steps)
	}
	if res.Method != RestoreMethodIOSXE || !res.Committed || !res.Confirmed || res.RolledBack || res.HostKeyStatus != "matched" {
		t.Fatalf("unexpected result: %+v", res)
	}
	if !strings.Contains(x.running, "hostname R1-old") || x.pending || !x.confirmed || !x.saved {
		t.Fatalf("device state: running=%q pending=%v confirmed=%v saved=%v", x.running, x.pending, x.confirmed, x.saved)
	}
	if !x.sent("configure replace bootflash:nigafiy-restore.cfg force revert trigger error timer 4") {
		t.Fatalf("configure replace with the rollback timer was not sent: %v", x.cmds)
	}
	if x.sessions != 2 {
		t.Fatalf("the read-back must use a second SSH session, got %d", x.sessions)
	}
	if len(x.files) != 0 {
		t.Fatalf("the temporary file must be deleted, got %v", x.files)
	}
	if len(res.ReadBackCommands) != 1 || res.ReadBackCommands[0] != "show running-config" || !strings.Contains(res.Config, "hostname R1-old") {
		t.Fatalf("read back: %v %q", res.ReadBackCommands, res.Config)
	}
	// write memory only after configure confirm.
	ci, wi := -1, -1
	for i, c := range x.cmds {
		if c == "configure confirm" {
			ci = i
		}
		if c == "write memory" {
			wi = i
		}
	}
	if ci < 0 || wi < ci {
		t.Fatalf("write memory must follow configure confirm: %v", x.cmds)
	}
}

func TestRestoreIOSXEFlashFallback(t *testing.T) {
	x := &iosxeDevice{running: iosxeRunning, noBootflash: true}
	srv, tg := startIOSXE(t, x)
	if _, err := Restore(context.Background(), tg, RestoreSpec{Config: iosxeRestore}, opts(srv.addr)); err != nil {
		t.Fatal(err)
	}
	if !x.sent("configure replace flash:nigafiy-restore.cfg force revert trigger error timer 5") {
		t.Fatalf("want flash: and the default 5-minute timer: %v", x.cmds)
	}
}

func TestRestoreIOSXERevertedWhenReadBackDiffersOrDeviceLost(t *testing.T) {
	for _, tc := range []struct {
		name string
		x    *iosxeDevice
		want string
	}{
		{"read back differs", &iosxeDevice{running: iosxeRunning, mangleOnReplace: true}, "differs"},
		{"management lost", &iosxeDevice{running: iosxeRunning, refuseReconnect: true}, "new SSH session"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, tg := startIOSXE(t, tc.x)
			res, err := Restore(context.Background(), tg, RestoreSpec{Config: iosxeRestore}, opts(srv.addr))
			if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "previous configuration was put back") {
				t.Fatalf("want a reverted restore, got %v", err)
			}
			if !res.Committed || res.Confirmed || !res.RolledBack {
				t.Fatalf("unexpected result %+v", res)
			}
			if tc.x.running != iosxeRunning || tc.x.saved || tc.x.sent("configure confirm") || tc.x.sent("write memory") {
				t.Fatalf("previous configuration must be active and nothing saved: saved=%v cmds=%v", tc.x.saved, tc.x.cmds)
			}
		})
	}
}

func TestRestoreIOSXERefusals(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		x    *iosxeDevice
		kind string
		want string
	}{
		{"classic IOS", &iosxeDevice{running: iosxeRunning, classicIOS: true}, ErrUnsupported, "IOS XE"},
		{"no archive", &iosxeDevice{running: iosxeRunning, noArchive: true}, ErrUnsupported, "archive"},
		{"version without the timer syntax", &iosxeDevice{running: iosxeRunning, noTimerSyntax: true}, ErrUnsupported, "does not accept"},
		{"no SCP server", &iosxeDevice{running: iosxeRunning, noSCP: true}, ErrCommandFailed, "ip scp server enable"},
		{"corrupted upload", &iosxeDevice{running: iosxeRunning, corruptUpload: true}, ErrCommandFailed, "verify /md5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, tg := startIOSXE(t, tc.x)
			res, err := Restore(ctx, tg, RestoreSpec{Config: iosxeRestore}, opts(srv.addr))
			if KindOf(err) != tc.kind || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %s (%s), got %v", tc.kind, tc.want, err)
			}
			if res.Committed || tc.x.running != iosxeRunning || tc.x.saved || tc.x.sent("write memory") {
				t.Fatalf("nothing may change: %+v", res)
			}
		})
	}

	t.Run("a failing command: device reverts, proven by read back", func(t *testing.T) {
		x := &iosxeDevice{running: iosxeRunning, rejectReplace: true}
		srv, tg := startIOSXE(t, x)
		res, err := Restore(ctx, tg, RestoreSpec{Config: iosxeRestore}, opts(srv.addr))
		if KindOf(err) != ErrCommandFailed || !strings.Contains(err.Error(), "Rollback aborted") || strings.Contains(err.Error(), "$9$") || !res.RolledBack || res.Committed {
			t.Fatalf("want a refused, reverted restore, got %v %+v", err, res)
		}
		if x.running != iosxeRunning || x.saved || len(x.files) != 0 {
			t.Fatalf("nothing may change and the file must be gone: saved=%v files=%v", x.saved, x.files)
		}
	})
}

func TestIOSConfigHelpers(t *testing.T) {
	if !hasArchivePath(iosxeRunning) || hasArchivePath("archive\n maximum 5\n!\n") || hasArchivePath("hostname x\n path a\n") {
		t.Fatal("hasArchivePath")
	}
	if !sameIOSConfig("Building configuration...\n\nCurrent configuration : 9 bytes\n!\nhostname a  \n!\nend", "hostname a\nend") || sameIOSConfig("hostname a", "hostname b") {
		t.Fatal("sameIOSConfig must ignore the header and comments only")
	}
}
