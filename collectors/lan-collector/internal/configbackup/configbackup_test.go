package configbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// ── in-test SSH server emulating network CLIs on loopback ─────────────────

type device struct {
	version      string // SSH identification string
	banner       string // shown after login, before the first prompt
	prompt       string // unprivileged / initial prompt
	privPrompt   string // after a successful enable ("" = no enable step)
	enableSecret string
	pagerAlways  bool // ignore "terminal length 0": always page (FortiOS-like)
	pageLines    int
	commands     map[string]string // command → output (privileged commands only after enable)
	privileged   map[string]bool
	exec         map[string]string // exec channel command → output (MikroTik)
	noShell      bool
	auth         string // "password" | "keyboard" | "publickey"
	password     string
	pubKey       ssh.PublicKey
	// cliFn replaces the generic CLI (restore tests emulate Junos configuration mode).
	cliFn func(ch ssh.Channel)
	// execFn handles exec channels itself (the IOS XE restore test emulates the SCP sink, the OpenWrt
	// restore test ubus); it returns the exit status.
	execFn func(cmd string, ch ssh.Channel) uint32

	authCalls atomic.Int32
	execSeen  []string
	shellCmds []string
	mu        sync.Mutex
}

type server struct {
	ln   net.Listener
	addr netip.AddrPort
	key  ssh.Signer
	dev  *device
	wg   sync.WaitGroup
}

func newHostKey(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func startServer(t *testing.T, dev *device, key ssh.Signer) *server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{ln: ln, addr: netip.MustParseAddrPort(ln.Addr().String()), key: key, dev: dev}
	cfg := &ssh.ServerConfig{ServerVersion: dev.version}
	switch dev.auth {
	case "keyboard":
		cfg.KeyboardInteractiveCallback = func(conn ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			dev.authCalls.Add(1)
			answers, err := challenge("", "", []string{"Password: "}, []bool{false})
			if err != nil || len(answers) != 1 || answers[0] != dev.password {
				return nil, fmt.Errorf("denied")
			}
			return nil, nil
		}
	case "publickey":
		cfg.PublicKeyCallback = func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			dev.authCalls.Add(1)
			if string(key.Marshal()) == string(dev.pubKey.Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("denied")
		}
	default:
		cfg.PasswordCallback = func(conn ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			dev.authCalls.Add(1)
			if conn.User() == "netops" && string(pw) == dev.password {
				return nil, nil
			}
			return nil, fmt.Errorf("denied")
		}
	}
	cfg.AddHostKey(key)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				s.serve(c, cfg)
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close(); s.wg.Wait() })
	return s
}

func (s *server) serve(c net.Conn, cfg *ssh.ServerConfig) {
	defer c.Close()
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "no")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			return
		}
		go s.session(ch, creqs)
	}
}

func (s *server) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		switch req.Type {
		case "pty-req", "env":
			_ = req.Reply(true, nil)
		case "exec":
			var p struct{ Cmd string }
			_ = ssh.Unmarshal(req.Payload, &p)
			s.dev.mu.Lock()
			s.dev.execSeen = append(s.dev.execSeen, p.Cmd)
			s.dev.mu.Unlock()
			if s.dev.execFn != nil {
				_ = req.Reply(true, nil)
				status := s.dev.execFn(p.Cmd, ch)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
				return
			}
			out, ok := s.dev.exec[p.Cmd]
			_ = req.Reply(true, nil)
			status := uint32(0)
			if !ok {
				out, status = "bad command name\n", 1
			}
			_, _ = io.WriteString(ch, strings.ReplaceAll(out, "\n", "\r\n"))
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
			return
		case "shell":
			if s.dev.noShell {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			if s.dev.cliFn != nil {
				s.dev.cliFn(ch)
			} else {
				s.cli(ch)
			}
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}

// cli is a tiny line-oriented CLI with echo, enable, pager and prompts.
func (s *server) cli(ch ssh.Channel) {
	d := s.dev
	w := func(text string) { _, _ = io.WriteString(ch, strings.ReplaceAll(text, "\n", "\r\n")) }
	if d.banner != "" {
		w(d.banner + "\n")
	}
	prompt := d.prompt
	priv := d.privPrompt == ""
	pager := true
	w(prompt)
	buf := make([]byte, 1)
	var line []byte
	readLine := func(echo bool) (string, bool) {
		line = line[:0]
		for {
			if _, err := ch.Read(buf); err != nil {
				return "", false
			}
			switch buf[0] {
			case '\r', '\n':
				if len(line) == 0 && buf[0] == '\n' && false {
					continue
				}
				w("\n")
				return string(line), true
			default:
				line = append(line, buf[0])
				if echo {
					_, _ = ch.Write(buf)
				}
			}
		}
	}
	for {
		cmd, ok := readLine(true)
		if !ok {
			return
		}
		cmd = strings.TrimSpace(cmd)
		d.mu.Lock()
		d.shellCmds = append(d.shellCmds, cmd)
		d.mu.Unlock()
		switch {
		case cmd == "":
		case cmd == "enable" && d.privPrompt != "":
			w("Password: ")
			secret, ok := readLine(false)
			if !ok {
				return
			}
			if secret == d.enableSecret {
				priv, prompt = true, d.privPrompt
			} else {
				w("% Access denied\n")
			}
		case cmd == "terminal length 0" || cmd == "set cli screen-length 0" || cmd == "no page" || cmd == "screen-length 0 temporary":
			if !d.pagerAlways {
				pager = false
			}
			if strings.HasPrefix(cmd, "set cli") {
				w("Screen length set to 0\n")
			}
		default:
			out, known := d.commands[cmd]
			if known && d.privileged[cmd] && !priv {
				known = false
			}
			if !known {
				w("% Invalid input detected at '^' marker.\n")
				break
			}
			lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
			for i, l := range lines {
				if pager && d.pageLines > 0 && i > 0 && i%d.pageLines == 0 {
					w(" --More-- ")
					if _, err := ch.Read(buf); err != nil {
						return
					}
					w("\b\b\b\b\b\b\b\b\b\b          \b\b\b\b\b\b\b\b\b\b")
				}
				w("\x1b[0m" + l + "\n")
			}
		}
		w(prompt)
	}
}

func opts(addr netip.AddrPort) Options {
	return Options{
		Authorized:    []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
		AllowLoopback: true,
		Budget:        20 * time.Second,
		Idle:          5 * time.Second,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr.String())
		},
	}
}

func target(s *server) Target {
	return Target{Address: "127.0.0.1", Port: int(s.addr.Port()), Username: "netops", Password: "s3cret-Pass"}
}

const ciscoConfig = `Building configuration...

Current configuration : 1534 bytes
!
! Last configuration change at 10:02:11 UTC Sat Nov 21 2026 by netops
!
version 15.2
hostname R1
!
enable secret 9 $9$abcdefghijkl$mnopqrstuvwxyz0123456789
!
username netops privilege 15 secret 9 $9$zzzz
!
interface GigabitEthernet0/1
 description uplink
 ip address 192.168.10.1 255.255.255.0
!
snmp-server community s3cr3tcomm RO
ntp clock-period 17179868
line vty 0 4
 transport input ssh
end`

func ciscoDevice() *device {
	return &device{
		version: "SSH-2.0-Cisco-1.25", prompt: "R1>", privPrompt: "R1#", enableSecret: "en-Secret",
		password: "s3cret-Pass", pageLines: 6,
		commands: map[string]string{
			"show version":        "Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E8\nROM: Bootstrap program is C2960 boot loader\nR1 uptime is 3 weeks, 2 days",
			"show running-config": ciscoConfig,
			"terminal width 0":    "",
		},
		privileged: map[string]bool{"show running-config": true},
	}
}

// ── tests ─────────────────────────────────────────────────────────────────

func TestCiscoAutoDetectEnablePagerAndTOFU(t *testing.T) {
	dev := ciscoDevice()
	srv := startServer(t, dev, newHostKey(t))
	tg := target(srv)
	tg.EnableSecret = "en-Secret"
	tg.Hints = Hints{OUIVendor: "Cisco Systems, Inc"}

	res, err := Run(context.Background(), tg, opts(srv.addr))
	if err != nil {
		t.Fatalf("backup failed: %v", err)
	}
	if res.HostKeyStatus != "first_use" || res.HostKey == nil || !strings.HasPrefix(res.HostKey.SHA256, "SHA256:") || res.HostKey.Type != "ssh-ed25519" {
		t.Fatalf("host key not reported for trust on first use: %+v %+v", res.HostKeyStatus, res.HostKey)
	}
	if res.Detection.Driver != "cisco_ios" || res.Detection.Confidence != "high" {
		t.Fatalf("detection = %+v", res.Detection)
	}
	var sources []string
	for _, e := range res.Detection.Evidence {
		if e.Driver == "cisco_ios" {
			sources = append(sources, e.Source)
		}
	}
	for _, want := range []string{"server_version", "prompt", "probe", "oui_vendor"} {
		if !contains(sources, want) {
			t.Errorf("missing %s evidence in %v", want, sources)
		}
	}
	for _, want := range []string{"hostname R1", "interface GigabitEthernet0/1", " ip address 192.168.10.1 255.255.255.0", "end"} {
		if !strings.Contains(res.Config, want+"\n") {
			t.Errorf("config lacks %q:\n%s", want, res.Config)
		}
	}
	for _, bad := range []string{"--More--", "\x1b", "\b", "R1#", "show running-config"} {
		if strings.Contains(res.Config, bad) {
			t.Errorf("config contains artefact %q:\n%s", bad, res.Config)
		}
	}
	// Only the closed command list was sent; the enable secret never appears in what we report.
	dev.mu.Lock()
	cmds := append([]string(nil), dev.shellCmds...)
	dev.mu.Unlock()
	allowed := map[string]bool{"": true, "show version": true, "enable": true, "terminal length 0": true, "terminal width 0": true, "show running-config": true}
	for _, c := range cmds {
		if !allowed[c] {
			t.Errorf("unexpected command sent to the device: %q", c)
		}
	}
	if strings.Contains(fmt.Sprintf("%+v", res), "en-Secret") || strings.Contains(fmt.Sprintf("%+v", res), "s3cret-Pass") {
		t.Fatal("a secret leaked into the result")
	}

	// Second run with the pinned key matches.
	tg.HostKeySHA256, tg.HostKeyType = res.HostKey.SHA256, res.HostKey.Type
	res2, err := Run(context.Background(), tg, opts(srv.addr))
	if err != nil || res2.HostKeyStatus != "matched" || res2.Config != res.Config {
		t.Fatalf("pinned run: status=%q err=%v", res2.HostKeyStatus, err)
	}
}

func TestPagerAnsweredWhenDeviceIgnoresPagerOff(t *testing.T) {
	dev := ciscoDevice()
	dev.pagerAlways = true
	dev.pageLines = 4
	srv := startServer(t, dev, newHostKey(t))
	tg := target(srv)
	tg.EnableSecret = "en-Secret"
	tg.Driver = "cisco_ios"
	res, err := Run(context.Background(), tg, opts(srv.addr))
	if err != nil {
		t.Fatalf("backup failed: %v", err)
	}
	if res.Detection.Confidence != "manual" {
		t.Fatalf("override not labelled manual: %+v", res.Detection)
	}
	if strings.Contains(res.Config, "More") || !strings.Contains(res.Config, "line vty 0 4\n") || !strings.Contains(res.Config, "snmp-server community s3cr3tcomm RO\n") {
		t.Fatalf("paged config not reassembled:\n%s", res.Config)
	}
}

func TestEnableSecretMissingOrWrong(t *testing.T) {
	dev := ciscoDevice()
	srv := startServer(t, dev, newHostKey(t))
	tg := target(srv)
	_, err := Run(context.Background(), tg, opts(srv.addr))
	if KindOf(err) != ErrPrivilege {
		t.Fatalf("want privilege error, got %v", err)
	}
	tg.EnableSecret = "wrong"
	_, err = Run(context.Background(), tg, opts(srv.addr))
	if KindOf(err) != ErrAuthFailed || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("want auth_failed without the secret in the message, got %v", err)
	}
}

func TestHostKeyChangeBlocksBeforeCredentialsAreSent(t *testing.T) {
	dev := ciscoDevice()
	first := startServer(t, dev, newHostKey(t))
	tg := target(first)
	tg.EnableSecret = "en-Secret"
	res, err := Run(context.Background(), tg, opts(first.addr))
	if err != nil {
		t.Fatal(err)
	}
	pinned := *res.HostKey

	// Same address, different key (device replaced, or someone in the middle).
	impostor := &device{version: "SSH-2.0-Cisco-1.25", prompt: "R1#", password: "s3cret-Pass", commands: map[string]string{}}
	second := startServer(t, impostor, newHostKey(t))
	tg = target(second)
	tg.HostKeySHA256, tg.HostKeyType = pinned.SHA256, pinned.Type
	res, err = Run(context.Background(), tg, opts(second.addr))
	if KindOf(err) != ErrHostKeyChanged {
		t.Fatalf("want host_key_changed, got %v", err)
	}
	if res.HostKeyStatus != "changed" || res.HostKey == nil || res.HostKey.SHA256 == pinned.SHA256 {
		t.Fatalf("presented key not reported: %+v", res.HostKey)
	}
	if n := impostor.authCalls.Load(); n != 0 {
		t.Fatalf("credentials were offered to a device with a changed host key (%d auth attempts)", n)
	}
}

func TestMikroTikUsesExecExport(t *testing.T) {
	export := "# nov/21/2026 10:00:00 by RouterOS 7.12.1\n# software id = ABCD-1234\n/interface bridge add name=bridge\n/ip address add address=192.168.88.1/24 interface=bridge network=192.168.88.0\n/system identity set name=edge-mt\n"
	dev := &device{version: "SSH-2.0-ROSSSH", auth: "keyboard", password: "s3cret-Pass", noShell: true, exec: map[string]string{"/export terse": export}}
	srv := startServer(t, dev, newHostKey(t))
	res, err := Run(context.Background(), target(srv), opts(srv.addr))
	if err != nil {
		t.Fatalf("backup failed: %v", err)
	}
	if res.Detection.Driver != "mikrotik_routeros" || res.Detection.Confidence != "high" {
		t.Fatalf("detection = %+v", res.Detection)
	}
	if !strings.Contains(res.Config, "/system identity set name=edge-mt\n") || strings.Contains(res.Config, "\r") {
		t.Fatalf("export = %q", res.Config)
	}
	if len(dev.execSeen) != 1 || dev.execSeen[0] != "/export terse" {
		t.Fatalf("exec commands = %v", dev.execSeen)
	}
}

func TestJunosDetectedByProbeWithPublicKey(t *testing.T) {
	_, userPriv, _ := ed25519.GenerateKey(rand.Reader)
	block, err := ssh.MarshalPrivateKey(userPriv, "backup")
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := ssh.NewSignerFromKey(userPriv)
	cfg := "## Last commit: 2026-11-20 10:00:00 UTC by netops\nversion 21.4R3.15;\nsystem {\n    host-name srx;\n    root-authentication {\n        encrypted-password \"$6$abc$def\"; ## SECRET-DATA\n    }\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet {\n                address 192.168.20.1/24;\n            }\n        }\n    }\n}"
	dev := &device{
		version: "SSH-2.0-OpenSSH_7.5", auth: "publickey", pubKey: signer.PublicKey(),
		banner: "--- JUNOS 21.4R3.15 Kernel 64-bit  JNPR-12.1", prompt: "netops@srx> ",
		commands: map[string]string{
			"show version":                 "Hostname: srx\nModel: srx300\nJunos: 21.4R3.15",
			"set cli screen-width 0":       "Screen width set to 0",
			"show configuration | no-more": cfg,
		},
	}
	srv := startServer(t, dev, newHostKey(t))
	tg := Target{Address: "127.0.0.1", Port: int(srv.addr.Port()), Username: "netops", PrivateKey: string(pem.EncodeToMemory(block))}
	res, err := Run(context.Background(), tg, opts(srv.addr))
	if err != nil {
		t.Fatalf("backup failed: %v", err)
	}
	if res.Detection.Driver != "juniper_junos" || res.Detection.Confidence != "high" {
		t.Fatalf("detection = %+v", res.Detection)
	}
	if !strings.Contains(res.Config, "address 192.168.20.1/24;") || strings.Contains(res.Config, "netops@srx>") {
		t.Fatalf("config = %s", res.Config)
	}
}

func TestUnknownDeviceIsNotGuessed(t *testing.T) {
	dev := &device{version: "SSH-2.0-OpenSSH_9.0", password: "s3cret-Pass", prompt: "mystery-box> ", commands: map[string]string{}}
	srv := startServer(t, dev, newHostKey(t))
	res, err := Run(context.Background(), target(srv), opts(srv.addr))
	if KindOf(err) != ErrUnsupported {
		t.Fatalf("want unsupported_vendor, got %v", err)
	}
	if res.Detection == nil || res.Detection.Driver != "" || res.Detection.Prompt != "mystery-box>" {
		t.Fatalf("detection = %+v", res.Detection)
	}
}

func TestBadPasswordAndScopeAndSize(t *testing.T) {
	dev := ciscoDevice()
	srv := startServer(t, dev, newHostKey(t))
	tg := target(srv)
	tg.Password = "nope"
	if _, err := Run(context.Background(), tg, opts(srv.addr)); KindOf(err) != ErrAuthFailed {
		t.Fatalf("want auth_failed, got %v", err)
	}

	// Outside the collector's authorized scopes: refused before dialling.
	o := opts(srv.addr)
	o.Authorized = []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}
	dialled := false
	o.Dial = func(context.Context, string, string) (net.Conn, error) { dialled = true; return nil, fmt.Errorf("no") }
	if _, err := Run(context.Background(), target(srv), o); KindOf(err) != ErrOutOfScope || dialled {
		t.Fatalf("want out_of_scope without dialling, got %v (dialled=%v)", err, dialled)
	}
	if _, err := Run(context.Background(), Target{Address: "8.8.8.8", Username: "u", Password: "p"}, Options{Authorized: []netip.Prefix{netip.MustParsePrefix("8.8.8.0/24")}}); KindOf(err) != ErrOutOfScope {
		t.Fatalf("public address must be refused, got %v", err)
	}

	// Output bound.
	big := ciscoDevice()
	big.commands["show running-config"] = strings.Repeat("interface Loopback0\n description padding padding padding\n", 4000)
	bigSrv := startServer(t, big, newHostKey(t))
	tg = target(bigSrv)
	tg.EnableSecret = "en-Secret"
	o = opts(bigSrv.addr)
	o.MaxOutput = 64 * 1024
	if _, err := Run(context.Background(), tg, o); KindOf(err) != ErrOutputTooLarge {
		t.Fatalf("want output_too_large, got %v", err)
	}
}

func TestCleanTerminal(t *testing.T) {
	raw := "\x1b[1;32mhostname R1\x1b[0m\r\n --More-- \b\b\b\b\b\b\b\b\b\b          \b\b\b\b\b\b\b\b\b\binterface Gi0/1\r\n---- More ----\x1b[42D                \x1b[42D ip address 10.0.0.1\r\n"
	got := cleanTerminal(raw)
	want := "hostname R1\ninterface Gi0/1\n ip address 10.0.0.1\n"
	if got != want {
		t.Fatalf("clean = %q, want %q", got, want)
	}
	if out := commandOutput("R1#show run\nline 1\nline 2\nR1#", "show run", "R1#"); out != "line 1\nline 2" {
		t.Fatalf("commandOutput = %q", out)
	}
	if msg, bad := looksLikeCommandError("% Invalid input detected at '^' marker."); !bad || !strings.Contains(msg, "Invalid input") {
		t.Fatalf("error not recognised: %q %v", msg, bad)
	}
	for prompt, fam := range map[string]string{"R1#": familyCisco, "[admin@MikroTik] >": familyMik, "<HUAWEI>": familyAngle, "admin@PA-220>": familyAtUser, "root@OpenWrt:~#": familyShell, "FGT60F #": familyForti, "ubnt@edge:~$": familyShell} {
		if got := promptFamily(prompt); got != fam {
			t.Errorf("promptFamily(%q) = %q, want %q", prompt, got, fam)
		}
	}
}

func TestEveryDriverHasReadOnlyCommands(t *testing.T) {
	readOnly := []string{"show ", "display ", "/export", "uci export", "show"}
	for _, d := range Drivers() {
		if len(d.Commands) == 0 {
			t.Errorf("%s has no commands", d.ID)
		}
		for _, c := range d.Commands {
			ok := false
			for _, p := range readOnly {
				ok = ok || strings.HasPrefix(c, p)
			}
			if !ok {
				t.Errorf("%s: %q is not a read-only command", d.ID, c)
			}
		}
		for _, c := range d.Session {
			if !strings.HasPrefix(c, "terminal ") && !strings.HasPrefix(c, "set cli ") && c != "no page" && c != "screen-length 0 temporary" {
				t.Errorf("%s: session command %q is not session-only", d.ID, c)
			}
		}
	}
}
