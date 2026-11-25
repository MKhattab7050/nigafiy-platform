package configbackup

import (
	"context"
	"net/netip"
	"regexp"
	"strings"
)

// Administrator-confirmed configuration restore. This is the only code path in this package that
// changes a device, and it is deliberately narrow:
//
//   - only vendors that replace the configuration as a whole AND roll it back by themselves when it
//     is not confirmed are supported:
//       Juniper Junos: "load override terminal" replaces the candidate configuration as a whole and
//       "commit confirmed N" activates it with a timer — unless it is confirmed within N minutes the
//       device itself returns to the previous configuration;
//       VyOS / Ubiquiti EdgeOS (restore_vyos.go): the candidate is rebuilt from the version's "set"
//       commands and activated with "commit-confirm N" — unless "confirm" follows within N minutes
//       the device reboots into its saved boot configuration, which Nigafiy saves just before;
//       OpenWrt (restore_openwrt.go): the version's packages are staged in a ubus session and
//       activated with rpcd's "uci apply" with rollback — unless "uci confirm" follows within N
//       minutes, rpcd copies the snapshot of the previous packages back and reloads them;
//     every other vendor is refused (ErrUnsupported); the server shows "restore not supported" with
//     the vendor-specific reason;
//   - the SSH host key must already be pinned (no trust on first use for a write);
//   - the device identity (model / serial, identity.go) is compared with the one recorded with the
//     version before anything is changed; a different device is refused unless the administrator
//     forced it (AllowOtherDevice);
//   - after the commit a SECOND, fresh SSH session logs in and reads the configuration back. Only when
//     that works (the device is still reachable and manageable) and the text read back equals the
//     restored one is the commit confirmed. Otherwise the previous configuration is put back at once,
//     or — if even the first session is gone — the device rolls back by itself when the timer runs out;
//   - the configuration text is used only in memory for this one restore, never logged or reported.

// Restore methods (mirrored by the server, modules/configbackup/restore.ts).
const (
	RestoreMethodJunos     = "junos_commit_confirmed"
	RestoreMethodVyOS      = "vyos_commit_confirm"
	defaultConfirmMinutes  = 5
	maxConfirmMinutes      = 10
	junosLoadPromptMarker  = "[Type ^D at a new line to end input]"
	junosDriverID          = "juniper_junos"
	vyosDriverID           = "vyos_edgeos"
	maxRestoreConfigLength = defaultMaxOutput
)

// RestoreMethod returns the restore method for a driver, or "" when restore is not supported.
func RestoreMethod(driver string) string {
	switch driver {
	case junosDriverID:
		return RestoreMethodJunos
	case vyosDriverID:
		return RestoreMethodVyOS
	case openwrtDriverID:
		return RestoreMethodOpenWrt
	}
	return ""
}

// RestoreSpec is what to restore.
type RestoreSpec struct {
	// Config is the normalized running configuration of the chosen version (unsanitized).
	Config string
	// ConfirmMinutes is the automatic rollback timer (1–10, default 5).
	ConfirmMinutes int
	// ExpectedIdentity is the device identity recorded with the version (nil = not recorded).
	ExpectedIdentity *DeviceIdentity
	// AllowOtherDevice: the administrator confirmed restoring onto a device whose identity differs.
	AllowOtherDevice bool
}

// RestoreResult reports what happened, step by step. Config is the configuration read back from the
// device after the commit (set whenever it could be read, also when the restore was undone).
type RestoreResult struct {
	HostKey       *HostKey
	HostKeyStatus string
	ServerVersion string
	Method        string
	Steps         []string
	Loaded        bool
	Committed     bool
	Confirmed     bool
	RolledBack    bool
	Config        string
	// Identity is what the device reported in the restore session before anything was changed.
	Identity *DeviceIdentity
}

func (r *RestoreResult) step(s string) { r.Steps = append(r.Steps, s) }

var junosErrorLineRe = regexp.MustCompile(`(?m)^\s*(error:|syntax error|.*\(\d+ errors?\))`)

func junosErrorLine(out string) (string, bool) {
	if m := junosErrorLineRe.FindString(out); m != "" {
		return clip(strings.TrimSpace(m), 200), true
	}
	return "", false
}

// sameConfig compares two Junos configurations as the device prints them, ignoring the
// "## Last commit" / "## Last changed" header comments, trailing spaces and blank lines.
func sameConfig(a, b string) bool {
	norm := func(s string) string {
		var out []string
		for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
			l = strings.TrimRight(l, " \t")
			t := strings.TrimSpace(l)
			if t == "" || strings.HasPrefix(t, "## Last commit") || strings.HasPrefix(t, "## Last changed") {
				continue
			}
			out = append(out, l)
		}
		return strings.Join(out, "\n")
	}
	return norm(a) == norm(b)
}

func validRestoreText(s string) bool {
	for _, r := range s {
		if r == '\n' || r == '\t' || r == '\r' {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Restore applies spec.Config to the device (see the package rules above).
func Restore(ctx context.Context, t Target, spec RestoreSpec, opts Options) (*RestoreResult, error) {
	opts = opts.withDefaults()
	res := &RestoreResult{}
	addr, err := netip.ParseAddr(strings.TrimSpace(t.Address))
	if err != nil || !addr.Is4() {
		return res, fail(ErrInvalidArgument, "the device address is not an IPv4 address")
	}
	if err := authorize(addr, opts.Authorized, opts.AllowLoopback); err != nil {
		return res, err
	}
	if t.Username == "" || (t.Password == "" && t.PrivateKey == "") {
		return res, fail(ErrInvalidArgument, "no SSH credentials are configured for this device")
	}
	if t.HostKeySHA256 == "" {
		return res, fail(ErrInvalidArgument, "a restore needs the device's SSH host key to be pinned (take a backup first)")
	}
	driver := t.Driver
	if driver == "" {
		driver = t.Hints.Driver
	}
	res.Method = RestoreMethod(driver)
	if res.Method == "" {
		return res, fail(ErrUnsupported, "restore is not supported for this device type (only Juniper Junos with commit confirmed, VyOS / EdgeOS with commit-confirm and OpenWrt with uci apply rollback)")
	}
	cfg := strings.TrimSpace(strings.ReplaceAll(spec.Config, "\r\n", "\n"))
	if cfg == "" || len(cfg) > maxRestoreConfigLength || !validRestoreText(cfg) {
		return res, fail(ErrInvalidArgument, "the configuration to restore is empty, too large or contains control characters")
	}
	minutes := spec.ConfirmMinutes
	if minutes <= 0 {
		minutes = defaultConfirmMinutes
	}
	if minutes > maxConfirmMinutes {
		minutes = maxConfirmMinutes
	}
	port := t.Port
	if port <= 0 || port > 65535 {
		port = defaultPort
	}
	ctx, cancel := context.WithTimeout(ctx, opts.Budget+opts.Budget/2)
	defer cancel()
	if res.Method == RestoreMethodVyOS {
		return res, restoreVyOS(ctx, addr, port, t, spec, cfg, minutes, opts, res)
	}
	if res.Method == RestoreMethodOpenWrt {
		return res, restoreOpenWrt(ctx, addr, port, t, spec, cfg, minutes, opts, res)
	}

	// ── session A: lock, load, commit confirmed ──
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
	sh, err := openShell(ctx, client, opts)
	if err != nil {
		return res, err
	}
	defer sh.close()
	prompt, _, err := sh.learnPrompt(ctx)
	if err != nil {
		return res, ctxErr(ctx, err)
	}
	if promptFamily(prompt) != familyAtUser || !strings.HasSuffix(prompt, ">") {
		return res, fail(ErrUnsupported, "the device prompt %q is not a Junos operational-mode prompt; nothing was changed", clip(prompt, 60))
	}
	for _, c := range []string{"set cli screen-length 0", "set cli screen-width 0"} {
		if _, err := sh.run(ctx, c, prompt); err != nil {
			return res, ctxErr(ctx, err)
		}
	}
	if err := checkIdentity(res, spec, readIdentity(ctx, sh, junosDriverID, prompt)); err != nil {
		return res, err
	}
	cfgPrompt := strings.TrimSuffix(prompt, ">") + "#"
	// A refused "configure exclusive" (database locked by someone else) leaves the operational prompt.
	if err := sh.write("configure exclusive\n"); err != nil {
		return res, err
	}
	raw, err := sh.read(ctx, 0, func(tail string) bool {
		ll := strings.TrimSpace(lastLine(tail))
		return ll == cfgPrompt || ll == prompt
	})
	if err != nil {
		return res, ctxErr(ctx, err)
	}
	cleaned := cleanTerminal(string(raw))
	if strings.TrimSpace(lastLine(cleaned)) != cfgPrompt {
		msg, _ := junosErrorLine(cleaned)
		if msg == "" {
			msg = "configuration mode was not entered"
		}
		return res, fail(ErrCommandFailed, "the configuration could not be locked (%s); nothing was changed", msg)
	}
	res.step("configure exclusive: configuration locked")
	leave := func() {
		_, _ = sh.run(ctx, "rollback 0", cfgPrompt)
		_, _ = sh.run(ctx, "exit configuration-mode", prompt)
	}

	if err := sh.write("load override terminal\n"); err != nil {
		return res, err
	}
	if _, err := sh.read(ctx, 0, func(tail string) bool { return strings.Contains(tail, junosLoadPromptMarker) }); err != nil {
		leave()
		return res, ctxErr(ctx, err)
	}
	var body strings.Builder
	for _, l := range strings.Split(cfg, "\n") {
		body.WriteString(l)
		body.WriteString("\n")
	}
	body.WriteString("\x04")
	if err := sh.write(body.String()); err != nil {
		return res, err
	}
	raw, err = sh.read(ctx, 0, func(tail string) bool { return strings.TrimSpace(lastLine(tail)) == cfgPrompt })
	if err != nil {
		leave()
		return res, ctxErr(ctx, err)
	}
	loadOut := cleanTerminal(string(raw))
	if msg, bad := junosErrorLine(loadOut); bad || !strings.Contains(loadOut, "load complete") {
		leave()
		if msg == "" {
			msg = "no \"load complete\""
		}
		return res, fail(ErrCommandFailed, "the device refused the configuration (%s); the candidate was discarded and nothing was changed", msg)
	}
	res.Loaded = true
	res.step("load override terminal: load complete")

	out, err := sh.run(ctx, "commit confirmed "+itoa(minutes), cfgPrompt)
	if err != nil {
		// The session broke during the commit: if it went through, the timer rolls it back.
		return res, fail(ErrProtocol, "the session ended during the commit; if the commit went through, the device rolls back by itself within %d minutes", minutes)
	}
	if msg, bad := junosErrorLine(out); bad || !strings.Contains(out, "commit complete") {
		leave()
		if msg == "" {
			msg = "no \"commit complete\""
		}
		return res, fail(ErrCommandFailed, "the commit was refused (%s); the candidate was discarded and nothing was changed", msg)
	}
	res.Committed = true
	res.step("commit confirmed " + itoa(minutes) + ": active, rolls back automatically unless confirmed")

	undo := func(why string) error {
		o1, e1 := sh.run(ctx, "rollback 1", cfgPrompt)
		o2, e2 := sh.run(ctx, "commit", cfgPrompt)
		_, _ = sh.run(ctx, "exit configuration-mode", prompt)
		if e1 == nil && e2 == nil && strings.Contains(o1, "load complete") && strings.Contains(o2, "commit complete") {
			res.RolledBack = true
			res.step("rollback 1 + commit: previous configuration active again")
			return fail(ErrCommandFailed, "%s; the previous configuration was put back", why)
		}
		res.step("rollback 1 + commit failed: the device rolls back by itself when the timer ends")
		return fail(ErrCommandFailed, "%s; putting the previous configuration back failed, the device rolls back by itself within %d minutes", why, minutes)
	}

	// ── session B: a fresh login proves the device is still reachable and manageable ──
	after, err := readBack(ctx, addr, port, t, opts)
	if err != nil {
		res.step("read back over a new SSH session failed: " + clip(err.Error(), 160))
		return res, undo("after the commit the device could not be read over a new SSH session (" + clip(err.Error(), 120) + ")")
	}
	res.Config = after
	res.step("read back over a new SSH session")
	if !sameConfig(cfg, after) {
		return res, undo("the configuration read back differs from the restored one")
	}

	out, err = sh.run(ctx, "commit", cfgPrompt)
	if err != nil || !strings.Contains(out, "commit complete") {
		return res, fail(ErrCommandFailed, "confirming the commit failed; the device rolls back by itself within %d minutes", minutes)
	}
	res.Confirmed = true
	res.step("commit: confirmed")
	_, _ = sh.run(ctx, "exit configuration-mode", prompt)
	return res, nil
}

// readBack logs in again and reads the configuration in operational mode.
func readBack(ctx context.Context, addr netip.Addr, port int, t Target, opts Options) (string, error) {
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
	for _, c := range []string{"set cli screen-length 0", "set cli screen-width 0"} {
		if _, err := sh.run(ctx, c, prompt); err != nil {
			return "", ctxErr(ctx, err)
		}
	}
	out, err := sh.run(ctx, "show configuration | no-more", prompt)
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

func itoa(n int) string {
	if n <= 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 && i > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
