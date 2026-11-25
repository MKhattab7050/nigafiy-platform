package configbackup

import (
	"context"
	"net/netip"
	"regexp"
	"sort"
	"strings"
)

// VyOS / Ubiquiti EdgeOS restore with "commit-confirm".
//
// Vendor sources: VyOS documentation, "Configuration Overview" and "Command Line Interface"
// (docs.vyos.io, VyOS 1.3 / 1.4 / 1.5: configure, set, delete, commit-confirm <minutes>, confirm,
// discard, save, "show configuration commands"); Ubiquiti EdgeOS CLI (EdgeOS 1.10 / 2.0, a Vyatta
// derivative with the same configuration commands, "commit-confirm" and "confirm"). Both print the
// configuration as "set" commands with "show configuration commands", which is what Nigafiy backs up
// (drivers.go), and accept those lines back in configuration mode.
//
// What the device guarantees: "commit-confirm N" activates the candidate and schedules a reboot in N
// minutes; "confirm" cancels it. The reboot loads the saved boot configuration (/config/config.boot).
// Nigafiy therefore runs "save" right before the restore, so the boot configuration — the device's own
// rollback point — is exactly the configuration it ran before. (VyOS 1.4+ can be told to reload
// instead of reboot with "system config-management commit-confirm action reload"; Nigafiy does not
// change that setting.)
//
// Steps, session A:
//  1. operational prompt (user@host:~$), device identity ("show version"), the configuration before
//     the restore ("show configuration commands");
//  2. "configure"; "save" (the rollback point);
//  3. "delete <node>" for every top-level node, then every "set" line of the version — all in the
//     candidate, nothing active yet. A refused line discards the candidate ("discard") and stops;
//  4. "commit-confirm N" (answering its "Proceed?" question). A failed commit is checked by reading the
//     active configuration: unchanged → "confirm" cancels the reboot (nothing changed); otherwise the
//     reboot timer is left to put the saved configuration back;
//
// session B (a fresh login) reads the configuration back. Equal → "confirm", "save" (the restored
// configuration survives a reboot). Different or not readable → the previous "set" lines are applied
// again in session A and committed; only when a third session reads exactly the previous configuration
// back is the reboot cancelled with "confirm". Otherwise the timer reboots into the saved previous
// configuration.

const (
	vyosShowConfig = "show configuration commands | cat"
	vyosMaxLines   = 20000
)

var (
	vyosErrorRe   = regexp.MustCompile(`(?im)^.*(set failed|delete failed|commit failed|is not valid|invalid command|invalid value|error:|failed to|cannot be|not allowed).*$`)
	vyosProceedRe = regexp.MustCompile(`(?i)proceed\?|\[confirm\]|\[y/n\]`)
	vyosSetLineRe = regexp.MustCompile(`^set [A-Za-z0-9_-]+( |$)`)
)

func vyosLines(text string) []string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// sameSetConfig compares two "show configuration commands" outputs line by line, ignoring order,
// surrounding spaces and blank lines.
func sameSetConfig(a, b string) bool {
	x, y := vyosLines(a), vyosLines(b)
	if len(x) != len(y) {
		return false
	}
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// vyosTopNodes returns the distinct top-level configuration nodes ("interfaces", "system", …).
func vyosTopNodes(texts ...string) []string {
	seen := map[string]bool{}
	var out []string
	for _, text := range texts {
		for _, l := range vyosLines(text) {
			f := strings.Fields(l)
			if len(f) >= 2 && f[0] == "set" && !seen[f[1]] {
				seen[f[1]] = true
				out = append(out, f[1])
			}
		}
	}
	return out
}

func validVyOSConfig(cfg string) bool {
	lines := vyosLines(cfg)
	if len(lines) == 0 || len(lines) > vyosMaxLines {
		return false
	}
	for _, l := range lines {
		if !vyosSetLineRe.MatchString(l) {
			return false
		}
	}
	return true
}

type vyosSession struct {
	sh        *shell
	prompt    string // operational
	cfgPrompt string
}

// vyosPrompts: "vyos@vyos:~$" → configuration prompt "vyos@vyos#".
func vyosPrompts(prompt string) (string, bool) {
	p := strings.TrimSpace(prompt)
	if promptFamily(p) != familyShell {
		return "", false
	}
	i := strings.Index(p, ":")
	if i <= 0 {
		return "", false
	}
	return p[:i] + "#", true
}

// cfg runs one configuration-mode command and returns its output and the first error line, if any.
func (v *vyosSession) cfg(ctx context.Context, cmd string) (string, string, error) {
	out, err := v.sh.run(ctx, cmd, v.cfgPrompt)
	if err != nil {
		return "", "", err
	}
	if m := vyosErrorRe.FindString(out); m != "" {
		return out, clip(strings.TrimSpace(m), 200), nil
	}
	return out, "", nil
}

// replace rebuilds the candidate: delete every top-level node, then set every line of text.
func (v *vyosSession) replace(ctx context.Context, text string, nodes []string) (string, error) {
	for _, n := range nodes {
		if _, msg, err := v.cfg(ctx, "delete "+n); err != nil {
			return "", err
		} else if msg != "" && !strings.Contains(strings.ToLower(msg), "nothing to delete") {
			return msg, nil
		}
	}
	for _, l := range vyosLines(text) {
		_, msg, err := v.cfg(ctx, l)
		if err != nil {
			return "", err
		}
		if msg != "" {
			return msg, nil
		}
	}
	return "", nil
}

// commitConfirm runs "commit-confirm N", answering the device's "Proceed?" question.
func (v *vyosSession) commitConfirm(ctx context.Context, minutes int) (string, error) {
	cmd := "commit-confirm " + itoa(minutes)
	if err := v.sh.write(cmd + "\n"); err != nil {
		return "", err
	}
	want := strings.TrimSpace(v.cfgPrompt)
	raw, err := v.sh.read(ctx, 0, func(tail string) bool {
		ll := strings.TrimSpace(lastLine(tail))
		return ll == want || vyosProceedRe.MatchString(ll)
	})
	if err != nil {
		return "", err
	}
	out := cleanTerminal(string(raw))
	if vyosProceedRe.MatchString(strings.TrimSpace(lastLine(out))) {
		if err := v.sh.write("y\n"); err != nil {
			return "", err
		}
		more, err := v.sh.read(ctx, 0, func(tail string) bool { return strings.TrimSpace(lastLine(tail)) == want })
		if err != nil {
			return "", err
		}
		out += cleanTerminal(string(more))
	}
	return commandOutput(out, cmd, v.cfgPrompt), nil
}

func restoreVyOS(ctx context.Context, addr netip.Addr, port int, t Target, spec RestoreSpec, cfg string, minutes int, opts Options, res *RestoreResult) error {
	if !validVyOSConfig(cfg) {
		return fail(ErrInvalidArgument, "the version is not a list of VyOS / EdgeOS \"set\" commands; nothing was changed")
	}

	// ── session A ──
	hk := &Result{}
	client, _, err := connect(ctx, addr, port, t, opts, hk)
	res.HostKey, res.HostKeyStatus = hk.HostKey, hk.HostKeyStatus
	if err != nil {
		return err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stop()
	res.ServerVersion = clip(string(client.ServerVersion()), 120)
	sh, err := openShell(ctx, client, opts)
	if err != nil {
		return err
	}
	defer sh.close()
	prompt, _, err := sh.learnPrompt(ctx)
	if err != nil {
		return ctxErr(ctx, err)
	}
	cfgPrompt, ok := vyosPrompts(prompt)
	if !ok {
		return fail(ErrUnsupported, "the device prompt %q is not a VyOS / EdgeOS operational-mode prompt; nothing was changed", clip(prompt, 60))
	}
	v := &vyosSession{sh: sh, prompt: prompt, cfgPrompt: cfgPrompt}
	if err := checkIdentity(res, spec, readIdentity(ctx, sh, vyosDriverID, prompt)); err != nil {
		return err
	}
	before, err := sh.run(ctx, vyosShowConfig, prompt)
	if err != nil {
		return ctxErr(ctx, err)
	}
	if msg, bad := looksLikeCommandError(before); bad || !validVyOSConfig(before) {
		if msg == "" {
			msg = "no \"set\" commands"
		}
		return fail(ErrCommandFailed, "the current configuration could not be read (%s); nothing was changed", msg)
	}
	res.step("show configuration commands: configuration before the restore read")
	if sameSetConfig(before, cfg) {
		res.Config = before
		res.step("the device already runs this configuration; nothing was applied")
		return nil
	}

	out, err := sh.run(ctx, "configure", cfgPrompt)
	if err != nil {
		return ctxErr(ctx, fail(ErrCommandFailed, "configuration mode was not entered; nothing was changed"))
	}
	if m := vyosErrorRe.FindString(out); m != "" {
		return fail(ErrCommandFailed, "configuration mode was not entered (%s); nothing was changed", clip(strings.TrimSpace(m), 200))
	}
	res.step("configure: configuration mode")
	leave := func() {
		_, _, _ = v.cfg(ctx, "discard")
		_, _ = sh.run(ctx, "exit discard", prompt)
	}
	if _, msg, err := v.cfg(ctx, "save"); err != nil || msg != "" {
		leave()
		if err != nil {
			return ctxErr(ctx, err)
		}
		return fail(ErrCommandFailed, "saving the current configuration as the rollback point failed (%s); nothing was changed", msg)
	}
	res.step("save: the configuration before the restore is the boot configuration (the rollback point)")

	if msg, err := v.replace(ctx, cfg, vyosTopNodes(before, cfg)); err != nil {
		leave()
		return ctxErr(ctx, err)
	} else if msg != "" {
		leave()
		return fail(ErrCommandFailed, "the device refused the configuration (%s); the candidate was discarded and nothing was changed", msg)
	}
	res.Loaded = true
	res.step("delete + set: candidate configuration rebuilt from the version")

	out, err = v.commitConfirm(ctx, minutes)
	if err != nil {
		return fail(ErrProtocol, "the session ended during the commit; if the commit went through, the device reboots into the saved previous configuration within %d minutes", minutes)
	}
	if m := vyosErrorRe.FindString(out); m != "" {
		reason := clip(strings.TrimSpace(m), 200)
		// Did anything become active? Compare the running configuration with the one before.
		now, rerr := sh.run(ctx, "run "+vyosShowConfig, cfgPrompt)
		if rerr == nil && sameSetConfig(now, before) {
			_, _, _ = v.cfg(ctx, "confirm")
			leave()
			res.step("commit-confirm failed; the active configuration is unchanged, the reboot timer was cancelled")
			return fail(ErrCommandFailed, "the commit was refused (%s); the candidate was discarded and nothing was changed", reason)
		}
		res.Committed = true
		res.step("commit-confirm failed part-way; the device reboots into the saved previous configuration when the timer ends")
		return fail(ErrCommandFailed, "the commit was refused part-way (%s); the device reboots into the saved previous configuration within %d minutes", reason, minutes)
	}
	res.Committed = true
	res.step("commit-confirm " + itoa(minutes) + ": active, the device reboots into the saved previous configuration unless confirmed")

	undo := func(why string) error {
		msg, err := v.replace(ctx, before, vyosTopNodes(before, cfg))
		if err == nil && msg == "" {
			_, msg, err = v.cfg(ctx, "commit")
		}
		if err != nil || msg != "" {
			res.step("putting the previous configuration back failed: the device reboots into it when the timer ends")
			return fail(ErrCommandFailed, "%s; putting the previous configuration back failed, the device reboots into the saved previous configuration within %d minutes", why, minutes)
		}
		check, err := vyosReadBack(ctx, addr, port, t, opts)
		if err != nil || !sameSetConfig(check, before) {
			res.step("previous configuration committed, but not read back over a new SSH session: the reboot timer stays")
			return fail(ErrCommandFailed, "%s; the previous configuration was committed again, the device still reboots into the saved previous configuration within %d minutes as a safeguard", why, minutes)
		}
		if _, msg, err := v.cfg(ctx, "confirm"); err != nil || msg != "" {
			res.step("previous configuration active again; cancelling the reboot timer failed")
			res.RolledBack = true
			return fail(ErrCommandFailed, "%s; the previous configuration was put back, the device may still reboot within %d minutes (into the same configuration)", why, minutes)
		}
		_, _ = sh.run(ctx, "exit", prompt)
		res.RolledBack = true
		res.step("previous configuration committed and read back; reboot timer cancelled")
		return fail(ErrCommandFailed, "%s; the previous configuration was put back", why)
	}

	// ── session B: a fresh login proves the device is still reachable and manageable ──
	after, err := vyosReadBack(ctx, addr, port, t, opts)
	if err != nil {
		res.step("read back over a new SSH session failed: " + clip(err.Error(), 160))
		return undo("after the commit the device could not be read over a new SSH session (" + clip(err.Error(), 120) + ")")
	}
	res.Config = after
	res.step("read back over a new SSH session")
	if !sameSetConfig(cfg, after) {
		return undo("the configuration read back differs from the restored one")
	}
	if _, msg, err := v.cfg(ctx, "confirm"); err != nil || msg != "" {
		return fail(ErrCommandFailed, "confirming the commit failed; the device reboots into the saved previous configuration within %d minutes", minutes)
	}
	res.Confirmed = true
	res.step("confirm: reboot timer cancelled")
	if _, msg, err := v.cfg(ctx, "save"); err != nil || msg != "" {
		_, _ = sh.run(ctx, "exit", prompt)
		res.step("save failed: the restored configuration is active but not saved")
		return fail(ErrCommandFailed, "the configuration was restored and confirmed, but saving it failed; the device returns to the previous configuration on its next reboot unless it is saved")
	}
	res.step("save: the restored configuration is the boot configuration")
	_, _ = sh.run(ctx, "exit", prompt)
	return nil
}

// vyosReadBack logs in again and reads the configuration in operational mode.
func vyosReadBack(ctx context.Context, addr netip.Addr, port int, t Target, opts Options) (string, error) {
	client, _, err := connect(ctx, addr, port, t, opts, &Result{})
	if err != nil {
		return "", err
	}
	defer client.Close()
	sh, err := openShell(ctx, client, opts)
	if err != nil {
		return "", err
	}
	defer sh.close()
	prompt, _, err := sh.learnPrompt(ctx)
	if err != nil {
		return "", ctxErr(ctx, err)
	}
	if _, ok := vyosPrompts(prompt); !ok {
		return "", fail(ErrCommandFailed, "the device did not show its operational prompt (%q)", clip(prompt, 60))
	}
	out, err := sh.run(ctx, vyosShowConfig, prompt)
	if err != nil {
		return "", ctxErr(ctx, err)
	}
	if msg, bad := looksLikeCommandError(out); bad {
		return "", fail(ErrCommandFailed, "reading the configuration back was refused: %s", msg)
	}
	r := &Result{}
	if err := finish(r, []string{out}); err != nil {
		return "", err
	}
	return r.Config, nil
}
