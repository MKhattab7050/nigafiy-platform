// Package rdstream runs the agent side of a live remote support session: it asks the person at the
// screen for consent when the policy requires it, shows the session banner for the whole session
// (always; no setting turns it off), and streams the screen over a WebSocket to the API, which
// relays it to the operator's browser. Frames never touch a disk or a database; input, clipboard
// and quality settings come back on the same socket.
//
// The HTTP path (one rd_capture command per frame) stays the automatic fallback: when the socket
// cannot be opened the operator's viewer keeps polling frames through commands.
package rdstream

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/wsclient"
	"github.com/pion/webrtc/v4"
)

// OpenRequest is the payload of the server's rd_session_open command.
type OpenRequest struct {
	SessionID             string  `json:"session_id"`
	Operator              string  `json:"operator"`
	Reason                string  `json:"reason"`
	ConsentRequired       bool    `json:"consent_required"`
	ConsentTimeoutSeconds int     `json:"consent_timeout_s"`
	Control               bool    `json:"control"`
	Stream                bool    `json:"stream"`
	Display               int     `json:"display_index"`
	Quality               int     `json:"quality"`
	Scale                 float64 `json:"scale"`
	// Unattended sessions: the person may refuse within this many seconds (0 = no dialog); no
	// answer lets the session start.
	RefuseWindowSeconds int `json:"refuse_window_s"`
	// Permissions of the session's profile (Fleet Pro). The agent enforces them as well as the
	// server (defence in depth) and lists them on the banner. Absent from servers before profiles:
	// then Control alone decides, as before.
	Permissions *userui.Permissions `json:"permissions,omitempty"`
	Profile     string              `json:"profile,omitempty"`
	// Operators: everyone in the session (Fleet Pro multi-operator); Recording: the session is
	// recorded. Both are shown on the banner; rd_session_update changes them later.
	Operators []string `json:"operators,omitempty"`
	Recording bool     `json:"recording,omitempty"`
	// UserSession: the Windows session the helper attaches to (a session id, or "winlogon" for the
	// sign-in screen). Empty: the console's session. Needs the LocalSystem service.
	UserSession string `json:"user_session,omitempty"`
}

// SessionTargeter is a Desktop that can move its session helper to another Windows session or to
// the sign-in screen (the service's helper supervisor; nothing else can).
type SessionTargeter interface {
	TargetSession(session string) error
}

// ErrNeedsService: another Windows session or the sign-in screen without the LocalSystem service.
const ErrNeedsService = "user_session_needs_service: another Windows session or the sign-in screen needs the Nigafiy agent installed as a service"

// Effective returns the permissions this agent enforces for the request: the server's profile
// flags (mouse and keyboard only when both Control and the profile allow it), or for an older
// server without profiles, view + Control + clipboard both ways (what sessions did before).
func (r OpenRequest) Effective() userui.Permissions {
	if r.Permissions == nil {
		return userui.Permissions{View: true, Control: r.Control, ClipboardIn: true, ClipboardOut: true}
	}
	p := *r.Permissions
	p.Control = p.Control && r.Control
	return p
}

// OpenResult goes back as the command's result data.
type OpenResult struct {
	Consent      string       `json:"consent"` // accepted | denied | timeout | not_required | unavailable | not_refused
	ConsentError string       `json:"consent_error,omitempty"`
	Banner       string       `json:"banner"` // shown | unavailable | not_shown
	BannerError  string       `json:"banner_error,omitempty"`
	Stream       string       `json:"stream"` // connecting | not_requested | not_started
	Desktop      desktop.Info `json:"desktop"`
}

type Config struct {
	ServerURL  string
	TLS        *tls.Config
	Credential func() string
	UserAgent  string
	Desktop    desktop.Desktop
	Log        *slog.Logger
	// NotifyEnded tells the API the person pressed End session (POST /agent/rd-session/end).
	NotifyEnded func(ctx context.Context, sessionID string) error
	// Dialer overrides the WebSocket TCP dial (tests).
	Dialer func(ctx context.Context, network, addr string) (net.Conn, error)
	// MaxFPS caps the frame rate (default 15).
	MaxFPS int
	// SAS sends Ctrl+Alt+Del (default sas.Send; asService: this agent is the Windows service).
	SAS func(asService bool) error
	// OnHelpRequest gets "Request help" from the tray (the person's note and account name).
	OnHelpRequest func(note, user string)
	// OnITActivity gets "IT activity…" from the tray (the agent shows the list).
	OnITActivity func()
	// OnRecordings gets "Past recordings…" from the tray.
	OnRecordings func(user string)
	// OnEndSession gets "End current session" from the tray (after the remote session, if any,
	// was ended here as from the banner): the agent ends the remote shells.
	OnEndSession func()
	// DisableWebRTC: the hello says WebRTC is not available (the JPEG stream only).
	DisableWebRTC bool
	// VideoFPS caps the WebRTC video frame rate (default 30).
	VideoFPS int
	// RTCSettings adjusts pion's setting engine (tests: loopback candidates).
	RTCSettings func(*webrtc.SettingEngine)
}

// Manager holds at most one live session (a new one replaces the old).
type Manager struct {
	cfg    Config
	mu     sync.Mutex
	active *live
	// asking: the consent dialog on screen (closed when the session is closed meanwhile).
	asking       string
	cancelAsking context.CancelFunc
}

func NewManager(cfg Config) *Manager {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.MaxFPS <= 0 {
		cfg.MaxFPS = 15
	}
	m := &Manager{cfg: cfg}
	if cfg.Desktop != nil {
		cfg.Desktop.SetToolEvents(m.toolEvent)
	}
	return m
}

// Active returns the open session's id ("" when none).
func (m *Manager) Active() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil {
		return ""
	}
	return m.active.req.SessionID
}

// Open runs consent (if required), shows the banner and starts the stream.
func (m *Manager) Open(ctx context.Context, req OpenRequest) OpenResult {
	d := m.cfg.Desktop
	res := OpenResult{Consent: "not_required", Banner: "not_shown", Stream: "not_started", Desktop: d.Info()}
	if req.SessionID == "" {
		res.Consent = "unavailable"
		res.ConsentError = "no session id"
		return res
	}
	m.Close("", "replaced")
	if err := m.target(req.UserSession); err != nil {
		res.Consent = "unavailable"
		res.ConsentError = err.Error()
		return res
	}
	perms := req.Effective()
	req.Control = perms.Control

	if !req.ConsentRequired && req.RefuseWindowSeconds > 0 {
		// Unattended with a refuse window: the person sees who connects, why and what is allowed,
		// and may refuse; no answer lets the session start. Nobody to ask (no desktop) also starts
		// it: unattended policies are for computers nobody uses.
		cctx, cancel := context.WithCancel(ctx)
		m.mu.Lock()
		m.asking, m.cancelAsking = req.SessionID, cancel
		m.mu.Unlock()
		answer, err := d.Consent(cctx, userui.ConsentRequest{SessionID: req.SessionID, Operator: req.Operator, Reason: req.Reason, TimeoutSeconds: req.RefuseWindowSeconds, Mode: userui.ModeRefuse, Permissions: &perms})
		closed := cctx.Err() != nil && ctx.Err() == nil
		m.mu.Lock()
		if m.asking == req.SessionID {
			m.asking, m.cancelAsking = "", nil
		}
		m.mu.Unlock()
		cancel()
		switch {
		case closed:
			res.Consent = "unavailable"
			res.ConsentError = "the session was closed before the refuse window ended"
			return res
		case err != nil:
			res.Consent = "unavailable"
			res.ConsentError = err.Error()
		case answer == userui.Denied:
			res.Consent = "denied"
			return res
		case answer == userui.Accepted:
			res.Consent = "accepted"
		default:
			res.Consent = "not_refused"
		}
	}

	if req.ConsentRequired {
		cctx, cancel := context.WithCancel(ctx)
		m.mu.Lock()
		m.asking, m.cancelAsking = req.SessionID, cancel
		m.mu.Unlock()
		answer, err := d.Consent(cctx, userui.ConsentRequest{SessionID: req.SessionID, Operator: req.Operator, Reason: req.Reason, TimeoutSeconds: req.ConsentTimeoutSeconds})
		closed := cctx.Err() != nil && ctx.Err() == nil
		m.mu.Lock()
		if m.asking == req.SessionID {
			m.asking, m.cancelAsking = "", nil
		}
		m.mu.Unlock()
		cancel()
		if closed {
			// The operator stopped (or replaced) the session while the dialog was up: the dialog is
			// gone and nothing starts.
			res.Consent = "unavailable"
			res.ConsentError = "the session was closed before the user answered"
			return res
		}
		if err != nil {
			res.Consent = "unavailable"
			res.ConsentError = err.Error()
			return res
		}
		res.Consent = string(answer)
		if answer != userui.Accepted {
			return res
		}
	}

	l := &live{m: m, req: req, perms: perms, done: make(chan struct{})}
	l.tools.operators = userui.BannerInfo{Operators: req.Operators}.Normalize().Operators
	l.tools.recording = req.Recording
	// The banner shows for every session, whatever the profile allows (nothing can turn it off).
	if err := d.ShowBanner(l.bannerInfo(), func() { m.endedByUser(req.SessionID) }); err != nil {
		res.Banner = "unavailable"
		res.BannerError = err.Error()
		m.cfg.Log.Warn("session banner could not be shown", "session", req.SessionID, "error", err.Error())
	} else {
		res.Banner = "shown"
	}
	m.mu.Lock()
	m.active = l
	m.mu.Unlock()
	if req.Stream {
		sctx, cancel := context.WithCancel(context.Background())
		l.cancel = cancel
		go l.run(sctx)
		res.Stream = "connecting"
	} else {
		res.Stream = "not_requested"
		close(l.done)
	}
	return res
}

// Allows reports what the open session permits, for commands that arrive outside the stream (the
// HTTP fallback). ok is false when no session is open here.
func (m *Manager) Allows() (perms userui.Permissions, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil {
		return userui.Permissions{}, false
	}
	return m.active.perms, true
}

// Close ends the session with that id ("" = whichever is open): stream, banner, encoder state.
func (m *Manager) Close(sessionID, reason string) bool {
	m.mu.Lock()
	if m.cancelAsking != nil && (sessionID == "" || m.asking == sessionID) {
		m.cancelAsking()
		m.asking, m.cancelAsking = "", nil
		if m.active == nil {
			m.mu.Unlock()
			m.cfg.Log.Info("consent request withdrawn", "session", sessionID, "reason", reason)
			return true
		}
	}
	l := m.active
	if l == nil || (sessionID != "" && l.req.SessionID != sessionID) {
		m.mu.Unlock()
		return false
	}
	m.active = nil
	m.mu.Unlock()
	if l.cancel != nil {
		l.cancel()
		select {
		case <-l.done:
		case <-time.After(3 * time.Second):
		}
	}
	// Every WebRTC peer connection of the session closes first (no picture after the end).
	if r := l.existingRTC(); r != nil {
		r.closeAll(true)
	}
	// Every tool of the session goes with it: privacy screen, blocked input, chat, overlay, audio.
	_, _, _ = m.cfg.Desktop.Tool(context.Background(), desktop.ToolRequest{Session: l.req.SessionID, Op: desktop.ToolEndAllForSess}, nil)
	m.cfg.Desktop.HideBanner(l.req.SessionID)
	m.cfg.Desktop.EndStream(l.req.SessionID)
	if l.req.UserSession != "" {
		// Back to the console's session (where the tray and the next session belong).
		_ = m.target("")
	}
	m.cfg.Log.Info("remote support session closed", "session", l.req.SessionID, "reason", reason)
	return true
}

// target moves the session helper to the requested Windows session ("" = back to the console).
func (m *Manager) target(session string) error {
	t, ok := m.cfg.Desktop.(SessionTargeter)
	if !ok {
		if session == "" {
			return nil
		}
		return errors.New(ErrNeedsService)
	}
	return t.TargetSession(session)
}

func (m *Manager) endedByUser(sessionID string) {
	m.cfg.Log.Info("the user ended the remote support session", "session", sessionID)
	if m.cfg.NotifyEnded != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.cfg.NotifyEnded(ctx, sessionID)
		cancel()
		if err != nil {
			m.cfg.Log.Warn("could not report the end of the session; closing it here anyway", "error", err.Error())
		}
	}
	m.Close(sessionID, "ended_by_user")
}

// ---------------------------------------------------------------------------------------------

type live struct {
	m      *Manager
	req    OpenRequest
	perms  userui.Permissions
	cancel context.CancelFunc
	done   chan struct{}
	tools  toolState
	// rtcm: the WebRTC peers of this session (webrtc.go), guarded by tools.mu.
	rtcm *rtcManager
}

// StreamURL is where the agent's socket goes: <server>/api/v1/agent/stream?session=<id>.
func StreamURL(server, sessionID string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/") + "/api/v1/agent/stream")
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported server scheme %q", u.Scheme)
	}
	u.RawQuery = url.Values{"session": {sessionID}}.Encode()
	return u.String(), nil
}

// run keeps the socket open (reconnecting with backoff) until the session closes or the server
// says it is over.
func (l *live) run(ctx context.Context) {
	defer close(l.done)
	cfg := l.m.cfg
	target, err := StreamURL(cfg.ServerURL, l.req.SessionID)
	if err != nil {
		cfg.Log.Warn("live stream disabled", "error", err.Error())
		return
	}
	failures := 0
	for ctx.Err() == nil {
		opts := wsclient.Options{
			Header:     http.Header{"Authorization": {"Bearer " + cfg.Credential()}, "User-Agent": {cfg.UserAgent}},
			TLS:        cfg.TLS,
			MaxMessage: 8 << 20, // a clipboard picture (4 MiB PNG, base64) from the operator
		}
		opts.Dialer = cfg.Dialer
		conn, err := wsclient.Dial(ctx, target, opts)
		if err != nil {
			var he *wsclient.HandshakeError
			if errors.As(err, &he) && (he.Status == http.StatusNotFound || he.Status == http.StatusConflict || he.Status == http.StatusGone || he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden) {
				cfg.Log.Info("live stream refused by the server; frames use the HTTP path", "status", he.Status)
				return
			}
			failures++
			wait := min(10*time.Second, time.Duration(1<<min(failures-1, 4))*time.Second)
			cfg.Log.Debug("live stream connect failed", "error", err.Error(), "retry_in", wait.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			continue
		}
		failures = 0
		over := newStream(l, conn).serve(ctx)
		_ = conn.Close(wsclient.CloseNormal, "")
		if over {
			// The server ended the session: close it here too (banner off).
			go l.m.Close(l.req.SessionID, "ended_by_server")
			return
		}
	}
}
