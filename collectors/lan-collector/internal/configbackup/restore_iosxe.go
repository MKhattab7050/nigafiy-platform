package configbackup

import (
	"context"
	"crypto/md5" //nolint:gosec // MD5 only compares the uploaded file with the device's own "verify /md5" (integrity, not security)
	"encoding/hex"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Cisco IOS XE restore: "configure replace" with an automatic rollback timer.
//
// The documented IOS XE mechanism (Configuration Replace and Configuration Rollback, IOS XE 16.x and
// later; Cisco "Configuration Replace and Configuration Rollback" configuration guide and the
// "configure replace", "configure confirm", "configure revert" and "archive" command references):
//
//	configure replace <file> force revert trigger error timer <minutes>
//
// replaces the running configuration as a whole with the file, reverts at once when a command of the
// file fails ("revert trigger error") and — unless "configure confirm" is entered within <minutes> —
// the device itself returns to the previous configuration (the archive it took before the replace).
// "configure revert now" goes back at once. The timer needs the configuration archive
// ("archive" / " path ..."); without it IOS XE refuses the timer, so Nigafiy refuses first.
//
// The steps (each is reported):
//  1. the prompt must be privileged ("#", after "enable" when the account logs in at '>'),
//     "show version" must say "Cisco IOS XE Software", and the running configuration must contain an
//     "archive" section with a "path" (otherwise nothing is changed);
//  2. the configuration is copied to bootflash: (flash: when the device has no bootflash:) over SCP on
//     the same, host-key-pinned SSH connection ("ip scp server enable" is a prerequisite) and checked
//     with the device's own "verify /md5" against the MD5 of what was sent;
//  3. configure replace … force revert trigger error timer N; it must end with "Rollback Done";
//  4. a SECOND, fresh SSH session logs in and reads "show running-config". Only when that works and
//     equals the restored text (ignoring comment lines and the header IOS prints) is the change kept:
//     "configure confirm", then "write memory" (only now, after the verified change), then the
//     temporary file is deleted. Otherwise "configure revert now" puts the previous configuration back
//     at once, and the running configuration is read again to prove it.
//
// Never run against real hardware here: verified only with the protocol double in restore_iosxe_test.go.

const (
	RestoreMethodIOSXE  = "iosxe_configure_replace"
	iosxeDriverID       = "cisco_ios"
	iosxeRestoreFile    = "nigafiy-restore.cfg"
	iosxeReadBack       = "show running-config"
	iosxeMaxTimerMinute = 10
)

// IOS error lines start with "%" ("% Invalid input detected", "%Rollback aborted ...").
var iosErrorRe = regexp.MustCompile(`(?m)^\s*%.*$`)

func iosErrorLine(out string) (string, bool) {
	if m := iosErrorRe.FindString(out); m != "" {
		return clip(strings.TrimSpace(m), 200), true
	}
	return "", false
}

// sameIOSConfig compares two IOS configurations as "show running-config" prints them, ignoring the
// header ("Building configuration...", "Current configuration : N bytes"), "!" comment lines, the
// measured "ntp clock-period", trailing spaces and blank lines.
func sameIOSConfig(a, b string) bool {
	norm := func(s string) string {
		var out []string
		for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
			l = strings.TrimRight(l, " \t")
			t := strings.TrimSpace(l)
			if t == "" || strings.HasPrefix(t, "!") || t == "Building configuration..." ||
				strings.HasPrefix(t, "Current configuration") || strings.HasPrefix(t, "ntp clock-period") {
				continue
			}
			out = append(out, l)
		}
		return strings.Join(out, "\n")
	}
	return norm(a) == norm(b)
}

var archivePathRe = regexp.MustCompile(`(?m)^archive\s*\n(?:[ \t]+.*\n)*?[ \t]+path\s+\S+`)

// hasArchivePath reports whether a running configuration has "archive" with a " path".
func hasArchivePath(running string) bool {
	return archivePathRe.MatchString(strings.ReplaceAll(running, "\r\n", "\n") + "\n")
}

// scpUpload writes data to dest (e.g. "bootflash:nigafiy-restore.cfg") with the SCP sink protocol
// ("scp -t <dest>", one "C0644 <size> <name>" record, the bytes, a zero byte; each step acknowledged
// with a zero byte). This is how "scp file user@router:bootflash:file" reaches the IOS SCP server.
func scpUpload(ctx context.Context, client *ssh.Client, dest string, data []byte) error {
	sess, err := client.NewSession()
	if err != nil {
		return fail(ErrProtocol, "the device refused an SCP channel")
	}
	defer sess.Close()
	stop := context.AfterFunc(ctx, func() { _ = sess.Close() })
	defer stop()
	in, err := sess.StdinPipe()
	if err != nil {
		return fail(ErrProtocol, "SCP: no input stream")
	}
	out, err := sess.StdoutPipe()
	if err != nil {
		return fail(ErrProtocol, "SCP: no output stream")
	}
	if err := sess.Start("scp -t " + dest); err != nil {
		return fail(ErrCommandFailed, "the device refused SCP (enable \"ip scp server enable\")")
	}
	ack := func(step string) error {
		b := make([]byte, 1)
		if _, err := io.ReadFull(out, b); err != nil {
			return fail(ErrCommandFailed, "SCP %s: the device closed the transfer (enable \"ip scp server enable\" and exec authorization for the account)", step)
		}
		if b[0] != 0 {
			msg := make([]byte, 200)
			n, _ := out.Read(msg)
			return fail(ErrCommandFailed, "SCP %s refused by the device (%s); check \"ip scp server enable\" and exec authorization for the account. Nothing was changed", step, clip(printableASCII(string(msg[:n])), 160))
		}
		return nil
	}
	if err := ack("start"); err != nil {
		return err
	}
	name := dest[strings.LastIndexAny(dest, ":/")+1:]
	if _, err := fmt.Fprintf(in, "C0644 %d %s\n", len(data), name); err != nil {
		return fail(ErrProtocol, "SCP: header not sent")
	}
	if err := ack("header"); err != nil {
		return err
	}
	if _, err := in.Write(data); err != nil {
		return fail(ErrProtocol, "SCP: data not sent")
	}
	if _, err := in.Write([]byte{0}); err != nil {
		return fail(ErrProtocol, "SCP: end not sent")
	}
	if err := ack("data"); err != nil {
		return err
	}
	_ = in.Close()
	return nil
}

func printableASCII(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ciscoPrivShell logs in, enters privileged mode and turns the pager off. It returns the "#" prompt.
func ciscoPrivShell(ctx context.Context, client *ssh.Client, t Target, opts Options) (*shell, string, error) {
	sh, err := openShell(ctx, client, opts)
	if err != nil {
		return nil, "", err
	}
	prompt, _, err := sh.learnPrompt(ctx)
	if err != nil {
		sh.close()
		return nil, "", ctxErr(ctx, err)
	}
	if promptFamily(prompt) != familyCisco {
		sh.close()
		return nil, "", fail(ErrUnsupported, "the device prompt %q is not a Cisco IOS prompt; nothing was changed", clip(prompt, 60))
	}
	if strings.HasSuffix(prompt, ">") {
		if t.EnableSecret == "" {
			sh.close()
			return nil, "", fail(ErrPrivilege, "the device is in unprivileged mode (prompt ends with '>'); add the enable secret")
		}
		p, err := sh.enable(ctx, t.EnableSecret)
		if err != nil {
			sh.close()
			return nil, "", ctxErr(ctx, err)
		}
		prompt = p
	}
	if !strings.HasSuffix(prompt, "#") || strings.Contains(prompt, "(config") {
		sh.close()
		return nil, "", fail(ErrUnsupported, "the device prompt %q is not the privileged EXEC prompt; nothing was changed", clip(prompt, 60))
	}
	for _, c := range []string{"terminal length 0", "terminal width 0"} {
		if _, err := sh.run(ctx, c, prompt); err != nil {
			sh.close()
			return nil, "", ctxErr(ctx, err)
		}
	}
	return sh, prompt, nil
}

func iosRunning(ctx context.Context, sh *shell, prompt string) (string, error) {
	out, err := sh.run(ctx, iosxeReadBack, prompt)
	if err != nil {
		return "", ctxErr(ctx, err)
	}
	if msg, bad := iosErrorLine(out); bad && !strings.Contains(out, "\nhostname ") {
		return "", fail(ErrCommandFailed, "reading the running configuration was refused: %s", msg)
	}
	r := &Result{}
	if err := finish(r, []string{out}); err != nil {
		return "", err
	}
	return r.Config, nil
}

func restoreIOSXE(ctx context.Context, addr netip.Addr, port int, t Target, cfg string, minutes int, opts Options, res *RestoreResult) (*RestoreResult, error) {
	if minutes > iosxeMaxTimerMinute {
		minutes = iosxeMaxTimerMinute
	}
	ctx, cancel := context.WithTimeout(ctx, opts.Budget+opts.Budget/2)
	defer cancel()

	// ── session A ──
	hk := &Result{}
	client, _, err := connect(ctx, addr, port, t, opts, hk)
	res.HostKey, res.HostKeyStatus = hk.HostKey, hk.HostKeyStatus
	if err != nil {
		return res, err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stop()
	res.ServerVersion = clip(string(client.ServerVersion()), 120)
	sh, prompt, err := ciscoPrivShell(ctx, client, t, opts)
	if err != nil {
		return res, err
	}
	defer sh.close()

	ver, err := sh.run(ctx, "show version", prompt)
	if err != nil {
		return res, ctxErr(ctx, err)
	}
	if !strings.Contains(ver, "Cisco IOS XE Software") && !strings.Contains(ver, "Cisco IOS-XE software") {
		return res, fail(ErrUnsupported, "restore needs Cisco IOS XE (configure replace with a rollback timer); \"show version\" does not report IOS XE, nothing was changed")
	}
	before, err := iosRunning(ctx, sh, prompt)
	if err != nil {
		return res, err
	}
	if !hasArchivePath(before) {
		return res, fail(ErrUnsupported, "the configuration archive is not enabled, so IOS XE cannot roll a replace back by itself; configure \"archive\" with \"path bootflash:archive\" first. Nothing was changed")
	}
	res.step("show version: Cisco IOS XE; configuration archive enabled")

	fs := "bootflash:"
	if out, err := sh.run(ctx, "dir bootflash:", prompt); err != nil {
		return res, ctxErr(ctx, err)
	} else if _, bad := iosErrorLine(out); bad || !strings.Contains(out, "Directory of bootflash:") {
		fs = "flash:"
	}
	file := fs + iosxeRestoreFile
	body := []byte(strings.TrimRight(cfg, "\n") + "\n")
	if err := scpUpload(ctx, client, file, body); err != nil {
		return res, err
	}
	sum := md5.Sum(body) //nolint:gosec // integrity comparison with the device's verify /md5
	want := hex.EncodeToString(sum[:])
	out, err := sh.run(ctx, "verify /md5 "+file, prompt)
	if err != nil {
		return res, ctxErr(ctx, err)
	}
	removeFile := func() { _, _ = sh.run(ctx, "delete /force "+file, prompt) }
	if !strings.Contains(strings.ToLower(out), "= "+want) {
		removeFile()
		return res, fail(ErrCommandFailed, "the copied file does not match what was sent (verify /md5); it was deleted and nothing was changed")
	}
	res.step("copied to " + file + " over SCP; verify /md5 matches")

	replace := "configure replace " + file + " force revert trigger error timer " + itoa(minutes)
	out, err = sh.runTimeout(ctx, replace, prompt, 2*time.Minute)
	if err != nil {
		return res, fail(ErrProtocol, "the session ended during configure replace; if it went through, the device reverts by itself within %d minutes", minutes)
	}
	// revertNow puts the previous configuration back and proves it by reading it again.
	revertNow := func(why string) error {
		_, _ = sh.run(ctx, "configure revert now", prompt)
		after, rerr := iosRunning(ctx, sh, prompt)
		removeFile()
		if rerr == nil && sameIOSConfig(after, before) {
			res.RolledBack = true
			res.step("configure revert now: previous configuration active again (read back)")
			return fail(ErrCommandFailed, "%s; the previous configuration was put back", why)
		}
		res.step("configure revert now could not be proven: the device reverts by itself when the timer ends")
		return fail(ErrCommandFailed, "%s; putting the previous configuration back could not be confirmed, the device reverts by itself within %d minutes", why, minutes)
	}
	if !strings.Contains(out, "Rollback Done") {
		msg, _ := iosErrorLine(out)
		// Only the device's error text before the first ':' is kept: what follows can quote a line of
		// the configuration (and so a secret).
		if i := strings.Index(msg, ":"); i > 0 {
			msg = msg[:i]
		}
		if msg == "" {
			msg = "no \"Rollback Done\""
		}
		if strings.Contains(msg, "Invalid input") {
			removeFile()
			return res, fail(ErrUnsupported, "this IOS XE version does not accept \"configure replace … revert trigger error timer\" (%s); nothing was changed", msg)
		}
		return res, revertNow("the device refused the configuration (" + msg + ")")
	}
	res.Loaded, res.Committed = true, true
	res.step(replace + ": Rollback Done, reverts automatically unless confirmed")

	// ── session B: a fresh login proves the device is still reachable and manageable ──
	after, err := iosxeReadBackSession(ctx, addr, port, t, opts)
	if err != nil {
		res.step("read back over a new SSH session failed: " + clip(err.Error(), 160))
		return res, revertNow("after the replace the device could not be read over a new SSH session (" + clip(err.Error(), 120) + ")")
	}
	res.Config = after
	res.step("read back over a new SSH session")
	if !sameIOSConfig(cfg, after) {
		return res, revertNow("the configuration read back differs from the restored one")
	}
	out, err = sh.run(ctx, "configure confirm", prompt)
	if err != nil {
		return res, fail(ErrCommandFailed, "confirming the replace failed; the device reverts by itself within %d minutes", minutes)
	}
	if msg, bad := iosErrorLine(out); bad {
		return res, fail(ErrCommandFailed, "confirming the replace was refused (%s); the device reverts by itself within %d minutes", msg, minutes)
	}
	res.Confirmed = true
	res.step("configure confirm: confirmed")
	out, err = sh.runTimeout(ctx, "write memory", prompt, time.Minute)
	if err != nil || !strings.Contains(out, "[OK]") {
		res.step("write memory did not report [OK]: the restored configuration is active but not saved for the next restart")
	} else {
		res.step("write memory: [OK]")
	}
	removeFile()
	return res, nil
}

func iosxeReadBackSession(ctx context.Context, addr netip.Addr, port int, t Target, opts Options) (string, error) {
	client, _, err := connect(ctx, addr, port, t, opts, &Result{})
	if err != nil {
		return "", err
	}
	defer client.Close()
	sh, prompt, err := ciscoPrivShell(ctx, client, t, opts)
	if err != nil {
		return "", err
	}
	defer sh.close()
	return iosRunning(ctx, sh, prompt)
}

// runTimeout is run for a command that may stay silent longer than the usual idle limit
// (configure replace, write memory).
func (s *shell) runTimeout(ctx context.Context, cmd, prompt string, idle time.Duration) (string, error) {
	saved := s.opts.Idle
	if idle > saved {
		s.opts.Idle = idle
	}
	defer func() { s.opts.Idle = saved }()
	return s.run(ctx, cmd, prompt)
}
