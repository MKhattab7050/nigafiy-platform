// Package configbackup reads the running configuration of network devices (routers, switches,
// firewalls, access points) over SSH, read-only.
//
// Safety properties:
//   - the device address is re-checked against this collector's authorized scopes before dialling;
//   - the SSH host key is pinned on first use; a different key aborts the connection during key
//     exchange, before any credential is sent;
//   - only the closed per-vendor command lists in drivers.go are sent; there is no code path that
//     sends configuration, a restore, or an arbitrary command;
//   - output is bounded in size and time; credentials are never logged or returned.
package configbackup

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Error kinds (mirrored by the API's protocol schema).
const (
	ErrOutOfScope       = "out_of_scope"
	ErrUnreachable      = "unreachable"
	ErrTimeout          = "timeout"
	ErrAuthFailed       = "auth_failed"
	ErrHostKeyChanged   = "host_key_changed"
	ErrPrivilege        = "privilege"
	ErrUnsupported      = "unsupported_vendor"
	ErrCommandFailed    = "command_failed"
	ErrOutputTooLarge   = "output_too_large"
	ErrProtocol         = "protocol"
	ErrInvalidArgument  = "invalid_argument"
	ErrEmptyConfig      = "empty_config"
	defaultPort         = 22
	defaultDialTimeout  = 10 * time.Second
	defaultHandshake    = 20 * time.Second
	defaultBudget       = 3 * time.Minute
	defaultIdle         = 30 * time.Second
	defaultMaxOutput    = 1 << 20 // 1 MiB per command
	maxBannerBytes      = 4096
	maxInteractiveRound = 3
)

// Error is a failed backup. Messages never contain credentials.
type Error struct {
	Kind    string
	Message string
}

func (e *Error) Error() string { return e.Kind + ": " + e.Message }

func fail(kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// KindOf returns the error kind of err ("internal" for unexpected errors).
func KindOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return "internal"
}

// Hints are what LAN Detective already knows about the device (from the server's database).
type Hints struct {
	Driver    string // detected on an earlier backup
	OUIVendor string // IEEE OUI vendor of the device's MAC
	SysDescr  string // SNMP sysDescr, when the device is also read over SNMP
}

// Target is one device. Secrets live only in memory for the duration of a backup.
type Target struct {
	Address      string
	Port         int
	Username     string
	Password     string
	PrivateKey   string // PEM (OpenSSH or PKCS#1/#8)
	Passphrase   string
	EnableSecret string
	// HostKeySHA256 is the pinned host key fingerprint ("SHA256:…"); empty = trust on first use.
	HostKeySHA256 string
	HostKeyType   string
	// Driver is the administrator's explicit choice; empty = auto-detect.
	Driver string
	Hints  Hints
}

// Options bound and authorize a backup.
type Options struct {
	Authorized    []netip.Prefix
	AllowLoopback bool
	DialTimeout   time.Duration
	Handshake     time.Duration
	Budget        time.Duration
	Idle          time.Duration
	MaxOutput     int
	// Dial is for tests; nil uses net.Dialer.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

func (o Options) withDefaults() Options {
	if o.DialTimeout <= 0 {
		o.DialTimeout = defaultDialTimeout
	}
	if o.Handshake <= 0 {
		o.Handshake = defaultHandshake
	}
	if o.Budget <= 0 {
		o.Budget = defaultBudget
	}
	if o.Idle <= 0 {
		o.Idle = defaultIdle
	}
	if o.MaxOutput <= 0 {
		o.MaxOutput = defaultMaxOutput
	}
	return o
}

// HostKey is the key the device presented.
type HostKey struct {
	SHA256 string `json:"sha256"`
	Type   string `json:"type"`
}

// Result of a backup attempt. HostKey and ServerVersion are set whenever the handshake got that far,
// also on failure, so the server can pin a key on first use or report a changed key.
type Result struct {
	HostKey       *HostKey
	HostKeyStatus string // first_use | matched | changed
	ServerVersion string
	Detection     *Detection
	Config        string
	Commands      []string
}

// Run performs one read-only backup.
func Run(ctx context.Context, t Target, opts Options) (*Result, error) {
	opts = opts.withDefaults()
	res := &Result{}
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
	if t.Driver != "" && DriverByID(t.Driver) == nil {
		return res, fail(ErrInvalidArgument, "unknown driver %q", t.Driver)
	}
	port := t.Port
	if port <= 0 || port > 65535 {
		port = defaultPort
	}
	ctx, cancel := context.WithTimeout(ctx, opts.Budget)
	defer cancel()

	client, banner, err := connect(ctx, addr, port, t, opts, res)
	if err != nil {
		return res, err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stop()
	res.ServerVersion = clip(string(client.ServerVersion()), 120)

	det := &detector{}
	if t.Driver != "" {
		det.add("override", t.Driver, "chosen by an administrator", 0)
	} else {
		det.serverVersion(res.ServerVersion)
		if banner != "" {
			det.text("banner", banner, wBanner)
		}
		det.hints(t.Hints)
	}

	// MikroTik (vendor-unique SSH identification, or chosen) uses exec channels: its interactive
	// console probes the terminal, which a plain session cannot answer.
	if id := chosenOrDecided(t, det, ""); id != "" && DriverByID(id).Exec {
		res.Detection = finalDetection(t, det, "", "")
		return res, runExec(ctx, client, DriverByID(id), opts, res)
	}

	sh, err := openShell(ctx, client, opts)
	if err != nil {
		return res, err
	}
	defer sh.close()
	prompt, login, err := sh.learnPrompt(ctx)
	if err != nil {
		return res, ctxErr(ctx, err)
	}
	family := promptFamily(prompt)
	if t.Driver == "" {
		det.text("banner", login, wBanner)
		det.family(prompt, family)
		if family == familyMik {
			det.add("prompt", "mikrotik_routeros", prompt, wServerVersion)
		}
	}
	id := chosenOrDecided(t, det, family)
	if id == "" {
		for _, p := range probes {
			if !contains(p.families, family) {
				continue
			}
			out, err := sh.run(ctx, p.cmd, prompt)
			if err != nil {
				return res, ctxErr(ctx, err)
			}
			det.text("probe", out, wProbe)
			if id = chosenOrDecided(t, det, family); id != "" {
				break
			}
		}
	}
	res.Detection = finalDetection(t, det, prompt, family)
	if res.Detection.Driver == "" {
		return res, fail(ErrUnsupported, "could not identify the device (prompt %q); choose the vendor by hand", clip(prompt, 60))
	}
	d := DriverByID(res.Detection.Driver)
	if d.Exec {
		sh.close()
		return res, runExec(ctx, client, d, opts, res)
	}
	return res, runShell(ctx, sh, d, prompt, t, res)
}

func chosenOrDecided(t Target, det *detector, family string) string {
	if t.Driver != "" {
		return t.Driver
	}
	id, _ := det.decided(family)
	return id
}

func finalDetection(t Target, det *detector, prompt, family string) *Detection {
	if t.Driver != "" {
		return &Detection{Driver: t.Driver, Confidence: "manual", Evidence: det.evidence, Prompt: clip(prompt, 120), Family: family}
	}
	d, ok := det.result(prompt, family)
	if !ok {
		d.Driver, d.Confidence = "", ""
	}
	return &d
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func ctxErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fail(ErrTimeout, "the backup did not finish within its time budget")
	}
	return err
}

var loopback = netip.MustParsePrefix("127.0.0.0/8")
var privateRanges = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.168.0.0/16")}

// authorize re-checks the device against this collector's own policy: a private address inside a
// scope both delivered by the server and accepted locally.
func authorize(addr netip.Addr, authorized []netip.Prefix, allowLoopback bool) error {
	private := false
	for _, p := range privateRanges {
		private = private || p.Contains(addr)
	}
	if !private && !(allowLoopback && loopback.Contains(addr)) {
		return fail(ErrOutOfScope, "%s is not a private (RFC 1918) address", addr)
	}
	for _, p := range authorized {
		if p.Addr().Is4() && p.Contains(addr) {
			return nil
		}
	}
	return fail(ErrOutOfScope, "%s is not inside an authorized scope of this collector", addr)
}

// ── connection ────────────────────────────────────────────────────────────

var errHostKeyChanged = errors.New("host key changed")

func connect(ctx context.Context, addr netip.Addr, port int, t Target, opts Options, res *Result) (*ssh.Client, string, error) {
	auth, err := authMethods(t)
	if err != nil {
		return nil, "", err
	}
	hostPort := net.JoinHostPort(addr.String(), strconv.Itoa(port))
	dial := opts.Dial
	if dial == nil {
		d := &net.Dialer{Timeout: opts.DialTimeout}
		dial = d.DialContext
	}
	dctx, dcancel := context.WithTimeout(ctx, opts.DialTimeout)
	conn, err := dial(dctx, "tcp", hostPort)
	dcancel()
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", fail(ErrTimeout, "connecting to %s timed out", hostPort)
		}
		return nil, "", fail(ErrUnreachable, "cannot connect to %s: %s", hostPort, shortNetErr(err))
	}
	_ = conn.SetDeadline(time.Now().Add(opts.Handshake))

	var bannerMu sync.Mutex
	var banner strings.Builder
	algs := ssh.SupportedAlgorithms()
	legacy := ssh.InsecureAlgorithms()
	cfg := &ssh.ClientConfig{
		User: t.Username,
		Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			fp := ssh.FingerprintSHA256(key)
			res.HostKey = &HostKey{SHA256: fp, Type: key.Type()}
			if t.HostKeySHA256 == "" {
				res.HostKeyStatus = "first_use"
				return nil
			}
			if subtle.ConstantTimeCompare([]byte(fp), []byte(t.HostKeySHA256)) == 1 {
				res.HostKeyStatus = "matched"
				return nil
			}
			res.HostKeyStatus = "changed"
			return errHostKeyChanged
		},
		BannerCallback: func(message string) error {
			bannerMu.Lock()
			defer bannerMu.Unlock()
			if banner.Len() < maxBannerBytes {
				banner.WriteString(clip(message, maxBannerBytes-banner.Len()))
			}
			return nil
		},
		// Modern algorithms first; the legacy ones many installed switches and routers still need
		// come last and are used only when the device offers nothing better.
		Config: ssh.Config{
			KeyExchanges: append(algs.KeyExchanges, legacy.KeyExchanges...),
			Ciphers:      append(algs.Ciphers, legacy.Ciphers...),
			MACs:         append(algs.MACs, legacy.MACs...),
		},
		HostKeyAlgorithms: hostKeyAlgorithms(t, append(algs.HostKeys, legacy.HostKeys...)),
		ClientVersion:     "SSH-2.0-LANDetective_ConfigBackup",
		Timeout:           opts.Handshake,
	}
	type out struct {
		c     ssh.Conn
		chans <-chan ssh.NewChannel
		reqs  <-chan *ssh.Request
		err   error
	}
	done := make(chan out, 1)
	go func() {
		c, chans, reqs, err := ssh.NewClientConn(conn, hostPort, cfg)
		done <- out{c, chans, reqs, err}
	}()
	var o out
	select {
	case o = <-done:
	case <-ctx.Done():
		_ = conn.Close()
		<-done
		return nil, "", fail(ErrTimeout, "the SSH handshake with %s timed out", hostPort)
	}
	if o.err != nil {
		_ = conn.Close()
		msg := o.err.Error()
		switch {
		case errors.Is(o.err, errHostKeyChanged) || res.HostKeyStatus == "changed":
			return nil, "", fail(ErrHostKeyChanged, "the device presented a different SSH host key (%s) than the one pinned; no credentials were sent", res.HostKey.SHA256)
		case t.HostKeySHA256 != "" && strings.Contains(msg, "no common algorithm for host key"):
			res.HostKeyStatus = "changed"
			return nil, "", fail(ErrHostKeyChanged, "the device no longer offers the pinned %s host key; no credentials were sent", t.HostKeyType)
		case strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "no supported methods remain"):
			return nil, "", fail(ErrAuthFailed, "the device rejected the user name or credentials")
		case isTimeout(o.err):
			return nil, "", fail(ErrTimeout, "the SSH handshake with %s timed out", hostPort)
		default:
			return nil, "", fail(ErrProtocol, "SSH handshake failed: %s", clip(msg, 200))
		}
	}
	_ = conn.SetDeadline(time.Time{})
	bannerMu.Lock()
	b := banner.String()
	bannerMu.Unlock()
	return ssh.NewClient(o.c, o.chans, o.reqs), b, nil
}

// hostKeyAlgorithms: with a pinned key, negotiate only that key's algorithms so a device holding
// several host keys always presents the pinned one.
func hostKeyAlgorithms(t Target, all []string) []string {
	switch t.HostKeyType {
	case "":
		return all
	case ssh.KeyAlgoRSA:
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	default:
		return []string{t.HostKeyType}
	}
}

func authMethods(t Target) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	if t.PrivateKey != "" {
		var signer ssh.Signer
		var err error
		if t.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(t.PrivateKey), []byte(t.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(t.PrivateKey))
		}
		if err != nil {
			var missing *ssh.PassphraseMissingError
			if errors.As(err, &missing) {
				return nil, fail(ErrInvalidArgument, "the private key is encrypted; add its passphrase")
			}
			return nil, fail(ErrInvalidArgument, "the private key could not be read (OpenSSH, PKCS#1 or PKCS#8 PEM expected)")
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if t.Password != "" {
		pw := t.Password
		rounds := 0
		methods = append(methods,
			ssh.Password(pw),
			// Many network devices only offer keyboard-interactive; answer the password prompt(s).
			ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
				rounds++
				if rounds > maxInteractiveRound {
					return nil, errors.New("too many keyboard-interactive rounds")
				}
				answers := make([]string, len(questions))
				for i := range questions {
					if i < len(echos) && echos[i] {
						answers[i] = t.Username
					} else {
						answers[i] = pw
					}
				}
				return answers, nil
			}),
		)
	}
	return methods, nil
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func shortNetErr(err error) string {
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Err != nil {
		return clip(oe.Err.Error(), 160)
	}
	return clip(err.Error(), 160)
}

// ── exec channel (MikroTik) ───────────────────────────────────────────────

type limitedBuffer struct {
	mu    sync.Mutex
	b     []byte
	limit int
	over  bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.b)+len(p) > l.limit {
		l.over = true
		return 0, errors.New("output limit reached")
	}
	l.b = append(l.b, p...)
	return len(p), nil
}

func runExec(ctx context.Context, client *ssh.Client, d *Driver, opts Options, res *Result) error {
	var parts []string
	for _, cmd := range d.Commands {
		session, err := client.NewSession()
		if err != nil {
			return ctxErr(ctx, fail(ErrProtocol, "the device refused a session: %s", clip(err.Error(), 160)))
		}
		buf := &limitedBuffer{limit: opts.MaxOutput}
		session.Stdout = buf
		session.Stderr = buf
		done := make(chan error, 1)
		go func() { done <- session.Run(cmd) }()
		select {
		case err = <-done:
		case <-ctx.Done():
			_ = session.Close()
			return fail(ErrTimeout, "%q did not finish within the time budget", cmd)
		}
		_ = session.Close()
		if buf.over {
			return fail(ErrOutputTooLarge, "the output of %q exceeds %d bytes", cmd, opts.MaxOutput)
		}
		out := strings.Trim(cleanTerminal(string(buf.b)), "\n")
		if msg, bad := looksLikeCommandError(out); bad {
			return fail(ErrCommandFailed, "%q was refused: %s", cmd, msg)
		}
		var exitErr *ssh.ExitError
		if err != nil && !errors.As(err, &exitErr) {
			return ctxErr(ctx, fail(ErrProtocol, "%q failed: %s", cmd, clip(err.Error(), 160)))
		}
		if err != nil && strings.TrimSpace(out) == "" {
			return fail(ErrCommandFailed, "%q failed with exit status %d", cmd, exitErr.ExitStatus())
		}
		parts = append(parts, out)
		res.Commands = append(res.Commands, cmd)
	}
	return finish(res, parts)
}

func finish(res *Result, parts []string) error {
	cfg := strings.TrimSpace(strings.Join(parts, "\n"))
	if cfg == "" {
		return fail(ErrEmptyConfig, "the device returned an empty configuration")
	}
	res.Config = cfg + "\n"
	return nil
}

// ── interactive shell ─────────────────────────────────────────────────────

func runShell(ctx context.Context, sh *shell, d *Driver, prompt string, t Target, res *Result) error {
	if d.Enable && strings.HasSuffix(prompt, ">") {
		if t.EnableSecret == "" {
			return fail(ErrPrivilege, "the device is in unprivileged mode (prompt ends with '>'); add the enable secret")
		}
		p, err := sh.enable(ctx, t.EnableSecret)
		if err != nil {
			return ctxErr(ctx, err)
		}
		prompt = p
	}
	for _, cmd := range d.Session {
		if _, err := sh.run(ctx, cmd, prompt); err != nil {
			return ctxErr(ctx, err)
		}
	}
	var parts []string
	for _, cmd := range d.Commands {
		out, err := sh.run(ctx, cmd, prompt)
		if err != nil {
			return ctxErr(ctx, err)
		}
		if msg, bad := looksLikeCommandError(out); bad {
			kind := ErrCommandFailed
			if strings.Contains(strings.ToLower(msg), "authorization") || strings.Contains(strings.ToLower(msg), "permission") {
				kind = ErrPrivilege
			}
			return fail(kind, "%q was refused: %s", cmd, msg)
		}
		parts = append(parts, out)
		res.Commands = append(res.Commands, cmd)
	}
	return finish(res, parts)
}
