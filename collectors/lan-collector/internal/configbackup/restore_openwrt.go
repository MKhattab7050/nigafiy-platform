package configbackup

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// OpenWrt restore with rpcd's "uci apply" rollback (the mechanism LuCI uses for "Save & Apply").
//
// Vendor sources: OpenWrt rpcd, uci.c (github.com/openwrt/rpcd, master, read 2026-11-25): object
// "uci" with methods get / add / delete / revert / apply {rollback, timeout, ubus_rpc_session} /
// confirm {ubus_rpc_session} / rollback {ubus_rpc_session}; session.c and the OpenWrt ubus
// documentation (openwrt.org/docs/techref/ubus): object "session" with create {timeout},
// grant {ubus_rpc_session, scope, objects} and destroy {ubus_rpc_session}. Apply with rollback exists
// since rpcd 2018 (OpenWrt 18.06); older images are refused before anything is changed.
//
// What the device guarantees: "uci apply" with rollback=true snapshots /etc/config/<package> of every
// package the session staged changes for, commits the session's changes, triggers the "config.change"
// event (procd reloads the services of those packages) and arms a timer. Unless "uci confirm" with the
// same session id arrives within the timeout, rpcd copies the snapshot back, commits it and triggers
// the reload again — the device returns to the previous configuration by itself. "uci rollback" does
// the same at once. The timer lives in the rpcd process: a reboot or an rpcd restart in that window
// keeps the restored configuration (documented in docs/features/config-backup.md); Nigafiy therefore
// refuses a version that changes the "rpcd" package itself.
//
// Every command runs on its own SSH exec channel (no terminal, exact exit status); ubus arguments go
// through stdin ("$(cat)"), so configuration values are never part of a command line.
//
// Steps, connection A:
//  1. /etc/openwrt_release names OpenWrt; device identity ("ubus call system board"); rpcd offers
//     uci apply / confirm / rollback; the configuration before the restore ("uci export");
//  2. the version and the device must have the same packages, and the version must not change
//     "rpcd" (otherwise nothing is changed);
//  3. a ubus session is created and granted uci read / write; for every package that differs, every
//     section is deleted and the version's sections are added in order — staged in the session only,
//     nothing active yet. A refused call reverts the session's changes and stops;
//  4. "uci apply" with rollback and a timeout of N minutes.
//
// connection B (a fresh login) reads "uci export" back. Equal → "uci confirm". Different or not
// readable → "uci rollback" (over B, or A when B failed), and a third connection must read exactly the
// previous configuration back before the restore is reported as undone; if even that fails, rpcd's
// timer still puts the snapshot back.

const (
	RestoreMethodOpenWrt = "openwrt_uci_apply_rollback"
	openwrtDriverID      = "openwrt"
	openwrtExport        = "uci export"
)

// openwrtSettle is how long the restore waits after "uci apply" before it logs in again: procd
// reloads the changed services (the network among them) asynchronously. Tests set it to 0.
var openwrtSettle = 8 * time.Second

// ── uci export parsing ────────────────────────────────────────────────────

type uciOption struct {
	Key   string
	List  bool
	Value string
}

type uciSection struct {
	Type    string
	Name    string // "" = anonymous
	Options []uciOption
}

type uciPackage struct {
	Name     string
	Sections []*uciSection
}

// uciStatements splits uci export text into statements of words, with uci's quoting rules: '…'
// literal, "…" with backslash escapes, a backslash outside quotes escapes the next character,
// adjacent quoted parts join, and a newline inside quotes belongs to the value.
func uciStatements(text string) ([][]string, bool) {
	var out [][]string
	var words []string
	var cur strings.Builder
	inWord := false
	rs := []rune(strings.ReplaceAll(text, "\r\n", "\n"))
	endWord := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\n':
			endWord()
			if len(words) > 0 {
				out = append(out, words)
				words = nil
			}
		case c == ' ' || c == '\t':
			endWord()
		case c == '#' && !inWord:
			for i < len(rs) && rs[i] != '\n' {
				i++
			}
			i--
		case c == '\'':
			inWord = true
			j := i + 1
			for j < len(rs) && rs[j] != '\'' {
				cur.WriteRune(rs[j])
				j++
			}
			if j >= len(rs) {
				return nil, false
			}
			i = j
		case c == '"':
			inWord = true
			j := i + 1
			for j < len(rs) && rs[j] != '"' {
				if rs[j] == '\\' && j+1 < len(rs) {
					j++
				}
				cur.WriteRune(rs[j])
				j++
			}
			if j >= len(rs) {
				return nil, false
			}
			i = j
		case c == '\\' && i+1 < len(rs):
			inWord = true
			i++
			cur.WriteRune(rs[i])
		default:
			inWord = true
			cur.WriteRune(c)
		}
	}
	endWord()
	if len(words) > 0 {
		out = append(out, words)
	}
	return out, true
}

func validUCIName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

// parseUCIExport parses the output of "uci export" (all packages). It returns false for anything
// that is not exactly package / config / option / list statements.
func parseUCIExport(text string) ([]*uciPackage, bool) {
	stmts, ok := uciStatements(text)
	if !ok {
		return nil, false
	}
	var pkgs []*uciPackage
	var pkg *uciPackage
	var sec *uciSection
	seen := map[string]bool{}
	for _, w := range stmts {
		switch w[0] {
		case "package":
			if len(w) != 2 || !validUCIName(w[1]) || seen[w[1]] {
				return nil, false
			}
			seen[w[1]] = true
			pkg, sec = &uciPackage{Name: w[1]}, nil
			pkgs = append(pkgs, pkg)
		case "config":
			if pkg == nil || len(w) < 2 || len(w) > 3 || !validUCIName(w[1]) {
				return nil, false
			}
			sec = &uciSection{Type: w[1]}
			if len(w) == 3 {
				if !validUCIName(w[2]) {
					return nil, false
				}
				sec.Name = w[2]
			}
			pkg.Sections = append(pkg.Sections, sec)
		case "option", "list":
			if sec == nil || len(w) != 3 || !validUCIName(w[1]) {
				return nil, false
			}
			sec.Options = append(sec.Options, uciOption{Key: w[1], List: w[0] == "list", Value: w[2]})
		default:
			return nil, false
		}
	}
	return pkgs, len(pkgs) > 0
}

func uciQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// render prints a package the way "uci export" does.
func (p *uciPackage) render() string {
	var b strings.Builder
	b.WriteString("package " + p.Name + "\n\n")
	for _, s := range p.Sections {
		b.WriteString("config " + s.Type)
		if s.Name != "" {
			b.WriteString(" " + uciQuote(s.Name))
		}
		b.WriteString("\n")
		for _, o := range s.Options {
			kw := "option"
			if o.List {
				kw = "list"
			}
			b.WriteString("\t" + kw + " " + o.Key + " " + uciQuote(o.Value) + "\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}

func renderUCI(pkgs []*uciPackage) string {
	var b strings.Builder
	for _, p := range pkgs {
		b.WriteString(p.render())
	}
	return b.String()
}

// sameUCI compares two uci exports by content (quoting and blank lines do not matter).
func sameUCI(a, b string) bool {
	x, ok1 := parseUCIExport(a)
	y, ok2 := parseUCIExport(b)
	return ok1 && ok2 && renderUCI(x) == renderUCI(y)
}

// ── ubus arguments (ordered JSON: option order is the order uci keeps) ──

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// sectionValues renders a section's options as a ubus "values" table: options as strings, lists as
// arrays, in the order they first appear.
func sectionValues(s *uciSection) string {
	var keys []string
	vals := map[string][]string{}
	list := map[string]bool{}
	for _, o := range s.Options {
		if _, ok := vals[o.Key]; !ok {
			keys = append(keys, o.Key)
		}
		if o.List {
			list[o.Key] = true
			vals[o.Key] = append(vals[o.Key], o.Value)
		} else {
			vals[o.Key] = []string{o.Value}
		}
	}
	var b strings.Builder
	b.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(jsonString(k) + ":")
		if list[k] {
			b.WriteString("[")
			for j, v := range vals[k] {
				if j > 0 {
					b.WriteString(",")
				}
				b.WriteString(jsonString(v))
			}
			b.WriteString("]")
		} else {
			b.WriteString(jsonString(vals[k][0]))
		}
	}
	b.WriteString("}")
	return b.String()
}

// ── exec channels ─────────────────────────────────────────────────────────

// execStatus runs one command on its own exec channel. It returns the combined output and the exit
// status; err is set only when the command could not be run at all.
func execStatus(ctx context.Context, client *ssh.Client, cmd, stdin string, maxOut int) (string, int, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", -1, ctxErr(ctx, fail(ErrProtocol, "the device refused a session: %s", clip(err.Error(), 160)))
	}
	defer session.Close()
	buf := &limitedBuffer{limit: maxOut}
	session.Stdout = buf
	session.Stderr = buf
	session.Stdin = strings.NewReader(stdin)
	done := make(chan error, 1)
	go func() { done <- session.Run(cmd) }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = session.Close()
		return "", -1, fail(ErrTimeout, "%q did not finish within the time budget", cmd)
	}
	if buf.over {
		return "", -1, fail(ErrOutputTooLarge, "the output of %q exceeds %d bytes", cmd, maxOut)
	}
	out := strings.ReplaceAll(string(buf.b), "\r\n", "\n")
	var exitErr *ssh.ExitError
	if err != nil {
		if errors.As(err, &exitErr) {
			return out, exitErr.ExitStatus(), nil
		}
		return out, -1, ctxErr(ctx, fail(ErrProtocol, "%q failed: %s", cmd, clip(err.Error(), 160)))
	}
	return out, 0, nil
}

type owrtConn struct {
	client *ssh.Client
	opts   Options
}

// run runs a read-only command and requires exit status 0.
func (o *owrtConn) run(ctx context.Context, cmd string) (string, error) {
	out, status, err := execStatus(ctx, o.client, cmd, "", o.opts.MaxOutput)
	if err != nil {
		return "", err
	}
	if status != 0 {
		return "", fail(ErrCommandFailed, "%q failed with exit status %d (%s)", cmd, status, clip(firstLine(out), 120))
	}
	return out, nil
}

// ubus calls object.method with args (JSON) passed on stdin. The returned error never contains the
// arguments; ubus prints only "Command failed: <status>" on failure.
func (o *owrtConn) ubus(ctx context.Context, object, method, args string) (string, error) {
	out, status, err := execStatus(ctx, o.client, `ubus call `+object+` `+method+` "$(cat)"`, args, o.opts.MaxOutput)
	if err != nil {
		return "", err
	}
	if status != 0 {
		return "", fail(ErrCommandFailed, "ubus %s %s failed (%s)", object, method, clip(firstLine(out), 120))
	}
	return out, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if hasControl(s) {
		return "unprintable output"
	}
	return s
}

func connectOpenWrt(ctx context.Context, addr netip.Addr, port int, t Target, opts Options, hk *Result) (*owrtConn, error) {
	client, _, err := connect(ctx, addr, port, t, opts, hk)
	if err != nil {
		return nil, err
	}
	return &owrtConn{client: client, opts: opts}, nil
}

// export reads "uci export" and returns it in the form a backup stores.
func (o *owrtConn) export(ctx context.Context) (string, error) {
	out, err := o.run(ctx, openwrtExport)
	if err != nil {
		return "", err
	}
	r := &Result{}
	if err := finish(r, []string{strings.Trim(out, "\n")}); err != nil {
		return "", err
	}
	return r.Config, nil
}

func packageNames(pkgs []*uciPackage) map[string]*uciPackage {
	m := map[string]*uciPackage{}
	for _, p := range pkgs {
		m[p.Name] = p
	}
	return m
}

func restoreOpenWrt(ctx context.Context, addr netip.Addr, port int, t Target, spec RestoreSpec, cfg string, minutes int, opts Options, res *RestoreResult) error {
	want, ok := parseUCIExport(cfg)
	if !ok {
		return fail(ErrInvalidArgument, "the version is not an OpenWrt \"uci export\"; nothing was changed")
	}

	// ── connection A ──
	hk := &Result{}
	a, err := connectOpenWrt(ctx, addr, port, t, opts, hk)
	res.HostKey, res.HostKeyStatus = hk.HostKey, hk.HostKeyStatus
	if err != nil {
		return err
	}
	defer a.client.Close()
	stop := context.AfterFunc(ctx, func() { _ = a.client.Close() })
	defer stop()
	res.ServerVersion = clip(string(a.client.ServerVersion()), 120)

	rel, err := a.run(ctx, "cat /etc/openwrt_release")
	if err != nil || !strings.Contains(rel, "OpenWrt") {
		return fail(ErrUnsupported, "the device does not identify itself as OpenWrt (/etc/openwrt_release); nothing was changed")
	}
	board, _ := a.run(ctx, "ubus call system board")
	if err := checkIdentity(res, spec, parseIdentity(openwrtDriverID, []string{board})); err != nil {
		return err
	}
	methods, err := a.run(ctx, "ubus -v list uci")
	if err != nil || !strings.Contains(methods, `"apply"`) || !strings.Contains(methods, `"confirm"`) || !strings.Contains(methods, `"rollback"`) {
		return fail(ErrUnsupported, "rpcd on this device offers no \"uci apply\" with rollback (OpenWrt 18.06 or later is needed); nothing was changed")
	}
	if s, err := a.run(ctx, "ubus -v list session"); err != nil || !strings.Contains(s, `"grant"`) {
		return fail(ErrUnsupported, "rpcd on this device offers no ubus sessions; nothing was changed")
	}
	before, err := a.export(ctx)
	if err != nil {
		return err
	}
	have, ok := parseUCIExport(before)
	if !ok {
		return fail(ErrCommandFailed, "the current configuration (\"uci export\") could not be read; nothing was changed")
	}
	res.step("uci export: configuration before the restore read")
	if sameUCI(before, cfg) {
		res.Config = before
		res.step("the device already runs this configuration; nothing was applied")
		return nil
	}
	haveBy, wantBy := packageNames(have), packageNames(want)
	var missing, extra []string
	for _, p := range want {
		if haveBy[p.Name] == nil {
			missing = append(missing, p.Name)
		}
	}
	for _, p := range have {
		if wantBy[p.Name] == nil {
			extra = append(extra, p.Name)
		}
	}
	if len(missing) > 0 || len(extra) > 0 {
		var parts []string
		if len(missing) > 0 {
			parts = append(parts, "missing on the device: "+strings.Join(missing, ", "))
		}
		if len(extra) > 0 {
			parts = append(parts, "not in the version: "+strings.Join(extra, ", "))
		}
		return fail(ErrCommandFailed, "the version and the device have different configuration packages (%s); install or remove those packages first; nothing was changed", clip(strings.Join(parts, "; "), 300))
	}
	var changed []*uciPackage
	for _, p := range want {
		if p.render() != haveBy[p.Name].render() {
			changed = append(changed, p)
		}
	}
	for _, p := range changed {
		if p.Name == "rpcd" {
			return fail(ErrCommandFailed, "the version changes the \"rpcd\" configuration; rpcd holds the rollback timer and may restart, so Nigafiy does not restore it; nothing was changed")
		}
	}

	// ubus session for the staged changes.
	out, err := a.ubus(ctx, "session", "create", `{"timeout":`+itoa(minutes*60+900)+`}`)
	if err != nil {
		return err
	}
	var created struct {
		SID string `json:"ubus_rpc_session"`
	}
	if json.Unmarshal([]byte(out), &created) != nil || !validUCISession(created.SID) {
		return fail(ErrProtocol, "rpcd did not return a session id; nothing was changed")
	}
	sid := jsonString(created.SID)
	destroy := func(c *owrtConn) {
		_, _ = c.ubus(ctx, "session", "destroy", `{"ubus_rpc_session":`+sid+`}`)
	}
	if _, err := a.ubus(ctx, "session", "grant", `{"ubus_rpc_session":`+sid+`,"scope":"uci","objects":[["*","read"],["*","write"]]}`); err != nil {
		destroy(a)
		return fail(ErrCommandFailed, "rpcd refused the uci access for the restore session (%s); nothing was changed", errMessage(err))
	}
	revert := func() {
		for _, p := range changed {
			_, _ = a.ubus(ctx, "uci", "revert", `{"config":`+jsonString(p.Name)+`,"ubus_rpc_session":`+sid+`}`)
		}
		destroy(a)
	}
	for _, p := range changed {
		if err := stagePackage(ctx, a, sid, p); err != nil {
			revert()
			return fail(ErrCommandFailed, "the device refused the configuration of package %s (%s); the staged changes were reverted and nothing was changed", p.Name, errMessage(err))
		}
	}
	names := make([]string, 0, len(changed))
	for _, p := range changed {
		names = append(names, p.Name)
	}
	res.Loaded = true
	res.step("staged in a ubus session: " + clip(strings.Join(names, ", "), 200))

	if _, err := a.ubus(ctx, "uci", "apply", `{"rollback":true,"timeout":`+itoa(minutes*60)+`,"ubus_rpc_session":`+sid+`}`); err != nil {
		now, rerr := a.export(ctx)
		if rerr == nil && sameUCI(now, before) {
			revert()
			return fail(ErrCommandFailed, "uci apply was refused (%s); the staged changes were reverted and nothing was changed", errMessage(err))
		}
		res.Committed = true
		return fail(ErrCommandFailed, "uci apply failed (%s); rpcd puts the previous configuration back by itself within %d minutes", errMessage(err), minutes)
	}
	res.Committed = true
	res.step("uci apply with rollback " + itoa(minutes*60) + " s: active, rpcd puts the previous configuration back unless confirmed")

	undo := func(via *owrtConn, why string) error {
		if _, err := via.ubus(ctx, "uci", "rollback", `{"ubus_rpc_session":`+sid+`}`); err != nil && via != a {
			_, err = a.ubus(ctx, "uci", "rollback", `{"ubus_rpc_session":`+sid+`}`)
			if err != nil {
				res.step("uci rollback failed: rpcd puts the previous configuration back when the timer ends")
				return fail(ErrCommandFailed, "%s; uci rollback failed, rpcd puts the previous configuration back by itself within %d minutes", why, minutes)
			}
		} else if err != nil {
			res.step("uci rollback failed: rpcd puts the previous configuration back when the timer ends")
			return fail(ErrCommandFailed, "%s; uci rollback failed, rpcd puts the previous configuration back by itself within %d minutes", why, minutes)
		}
		res.step("uci rollback: previous configuration committed again")
		sleepCtx(ctx, openwrtSettle)
		check, err := openwrtReadBack(ctx, addr, port, t, opts)
		if err != nil || !sameUCI(check, before) {
			res.step("the previous configuration was not read back over a new SSH session")
			return fail(ErrCommandFailed, "%s; uci rollback was accepted, but the previous configuration could not be read back to prove it", why)
		}
		res.RolledBack = true
		destroy(via)
		res.step("previous configuration read back over a new SSH session")
		return fail(ErrCommandFailed, "%s; the previous configuration was put back", why)
	}

	// ── connection B: a fresh login proves the device is still reachable and manageable ──
	sleepCtx(ctx, openwrtSettle)
	b, err := connectOpenWrt(ctx, addr, port, t, opts, &Result{})
	if err != nil {
		res.step("read back over a new SSH session failed: " + clip(errMessage(err), 160))
		return undo(a, "after uci apply the device could not be reached over a new SSH session ("+clip(errMessage(err), 120)+")")
	}
	defer b.client.Close()
	after, err := b.export(ctx)
	if err != nil {
		res.step("read back over a new SSH session failed: " + clip(errMessage(err), 160))
		return undo(b, "after uci apply the configuration could not be read over a new SSH session ("+clip(errMessage(err), 120)+")")
	}
	res.Config = after
	res.step("read back over a new SSH session")
	if !sameUCI(cfg, after) {
		return undo(b, "the configuration read back differs from the restored one")
	}
	if _, err := b.ubus(ctx, "uci", "confirm", `{"ubus_rpc_session":`+sid+`}`); err != nil {
		if _, err2 := a.ubus(ctx, "uci", "confirm", `{"ubus_rpc_session":`+sid+`}`); err2 != nil {
			return fail(ErrCommandFailed, "confirming the apply failed (%s); rpcd puts the previous configuration back by itself within %d minutes", errMessage(err), minutes)
		}
	}
	res.Confirmed = true
	res.step("uci confirm: rollback timer cancelled, the restored configuration stays")
	destroy(b)
	return nil
}

// stagePackage replaces one package in the session: delete every section, add the version's sections
// in order (named sections keep their names; anonymous ones get new ids, as uci import does).
func stagePackage(ctx context.Context, c *owrtConn, sid string, p *uciPackage) error {
	cfgArg := jsonString(p.Name)
	out, err := c.ubus(ctx, "uci", "get", `{"config":`+cfgArg+`,"ubus_rpc_session":`+sid+`}`)
	if err != nil {
		return err
	}
	var got struct {
		Values map[string]json.RawMessage `json:"values"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		return fail(ErrProtocol, "uci get returned no sections")
	}
	for name := range got.Values {
		if !validUCIName(name) {
			return fail(ErrProtocol, "uci get returned an invalid section name")
		}
		if _, err := c.ubus(ctx, "uci", "delete", `{"config":`+cfgArg+`,"section":`+jsonString(name)+`,"ubus_rpc_session":`+sid+`}`); err != nil {
			return err
		}
	}
	for _, s := range p.Sections {
		args := `{"config":` + cfgArg + `,"type":` + jsonString(s.Type)
		if s.Name != "" {
			args += `,"name":` + jsonString(s.Name)
		}
		if len(s.Options) > 0 {
			args += `,"values":` + sectionValues(s)
		}
		args += `,"ubus_rpc_session":` + sid + `}`
		if _, err := c.ubus(ctx, "uci", "add", args); err != nil {
			return err
		}
	}
	return nil
}

func validUCISession(s string) bool {
	if len(s) < 8 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

func errMessage(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Message
	}
	return err.Error()
}

func sleepCtx(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}

// openwrtReadBack logs in again and reads "uci export".
func openwrtReadBack(ctx context.Context, addr netip.Addr, port int, t Target, opts Options) (string, error) {
	c, err := connectOpenWrt(ctx, addr, port, t, opts, &Result{})
	if err != nil {
		return "", err
	}
	defer c.client.Close()
	return c.export(ctx)
}
