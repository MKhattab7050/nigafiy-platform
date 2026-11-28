// Package shell is the Fleet Pro remote shell on the managed computer: PowerShell in a pseudo
// console on Windows, the user's shell on a pseudo terminal on Linux (pipes on macOS), joined to
// the API over a WebSocket. An admin opens it (shell_open); the banner names the operator and the
// reason for as long as it is open, and End session on the banner (or Ctrl+Alt+Shift+E) ends it.
// The API keeps the encrypted transcript; the agent keeps nothing.
package shell

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/wsclient"
)

// Terminal is one running shell: Read is its output, Write its input.
type Terminal interface {
	io.Reader
	io.Writer
	Resize(cols, rows int) error
	// Wait returns the exit code once the shell has exited.
	Wait() (int, error)
	Kill()
	Close() error
	// Kind: conpty | pty | pipes.
	Kind() string
	// Name: the shell's program.
	Name() string
}

// Start opens this platform's terminal (ConPTY on Windows, /dev/ptmx on Linux, pipes elsewhere).
func Start(cols, rows int) (Terminal, error) { return startTerminal(cols, rows) }

// OpenRequest is the shell_open command's payload.
type OpenRequest struct {
	ShellID            string `json:"shell_id"`
	Operator           string `json:"operator"`
	Reason             string `json:"reason"`
	Cols               int    `json:"cols"`
	Rows               int    `json:"rows"`
	IdleTimeoutS       int    `json:"idle_timeout_s"`
	MaxTranscriptBytes int64  `json:"max_transcript_bytes"`
	// BannerMode "off": the group (unattended, company-managed computer) turned the banner off, so
	// this shell gets no banner line. Anything else: the banner names it, as before.
	BannerMode string `json:"banner_mode,omitempty"`
}

// Silent: the shell is not named on the banner (BannerMode "off").
func (r OpenRequest) Silent() bool { return r.BannerMode == "off" }

// OpenResult is the shell_open command's result data.
type OpenResult struct {
	Shell       string `json:"shell"`
	PTY         string `json:"pty"`
	Banner      string `json:"banner"`
	BannerError string `json:"banner_error,omitempty"`
}

const (
	// MaxOpen: shells open at once on this computer (the server allows three).
	MaxOpen          = 3
	defaultIdle      = 15 * time.Minute
	maxIdle          = 4 * time.Hour
	defaultMaxBytes  = 32 << 20
	checkEvery       = 5 * time.Second
	readBuffer       = 32 << 10
	maxInputMessage  = 1 << 20
	handshakeTimeout = 15 * time.Second
)

var shellIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// Config wires the manager to the agent.
type Config struct {
	ServerURL  string
	// ServerNow, when set, is the server's address now (the agent follows address changes); else ServerURL.
	ServerNow func() string
	TLS        *tls.Config
	Credential func() string
	UserAgent  string
	Log        *slog.Logger
	// Banner shows the open shells on the session banner (nil lines: none open). Nil: no banner
	// on this computer (no desktop); the result says so.
	Banner func(lines []userui.ShellLine, onEnd func()) error
	// NotifyEnded tells the API that a shell ended here (POST /agent/shell-end).
	NotifyEnded func(ctx context.Context, shellID, reason string, exitCode *int) error
	// Dialer and StartTerminal are for tests.
	Dialer        func(ctx context.Context, network, addr string) (net.Conn, error)
	StartTerminal func(cols, rows int) (Terminal, error)
	// CheckEvery overrides how often idle and size limits are checked (tests).
	CheckEvery time.Duration
}

// Manager holds the shells open on this computer.
type Manager struct {
	cfg    Config
	mu     sync.Mutex
	shells map[string]*session
	order  []string
}

func NewManager(cfg Config) *Manager {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.StartTerminal == nil {
		cfg.StartTerminal = Start
	}
	if cfg.CheckEvery <= 0 {
		cfg.CheckEvery = checkEvery
	}
	return &Manager{cfg: cfg, shells: map[string]*session{}}
}

type session struct {
	m        *Manager
	req      OpenRequest
	term     Terminal
	conn     *wsclient.Conn
	idle     time.Duration
	maxBytes int64
	bytes    atomic.Int64
	last     atomic.Int64
	once     sync.Once
	done     chan struct{}
}

// StreamURL is the agent's shell socket for one shell.
func StreamURL(server, shellID string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/") + "/api/v1/agent/shell")
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
	u.RawQuery = url.Values{"shell": {shellID}}.Encode()
	return u.String(), nil
}

// Open starts the shell, shows it on the banner and joins it to the API. It returns once the
// shell is live (or could not start).
func (m *Manager) Open(ctx context.Context, req OpenRequest) (OpenResult, error) {
	if !shellIDPattern.MatchString(req.ShellID) {
		return OpenResult{}, errors.New("invalid shell id")
	}
	req.Cols = clamp(req.Cols, 20, 400, 120)
	req.Rows = clamp(req.Rows, 5, 200, 30)
	idle := time.Duration(req.IdleTimeoutS) * time.Second
	if idle <= 0 {
		idle = defaultIdle
	}
	idle = min(idle, maxIdle)
	maxBytes := req.MaxTranscriptBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	m.mu.Lock()
	if _, open := m.shells[req.ShellID]; open {
		m.mu.Unlock()
		return OpenResult{}, errors.New("that shell is already open on this computer")
	}
	if len(m.shells) >= MaxOpen {
		m.mu.Unlock()
		return OpenResult{}, fmt.Errorf("%d shells are already open on this computer", MaxOpen)
	}
	m.mu.Unlock()

	server := m.cfg.ServerURL
	if m.cfg.ServerNow != nil {
		server = m.cfg.ServerNow()
	}
	target, err := StreamURL(server, req.ShellID)
	if err != nil {
		return OpenResult{}, err
	}
	term, err := m.cfg.StartTerminal(req.Cols, req.Rows)
	if err != nil {
		return OpenResult{}, err
	}
	s := &session{m: m, req: req, term: term, idle: idle, maxBytes: maxBytes, done: make(chan struct{})}
	s.last.Store(time.Now().UnixNano())

	m.mu.Lock()
	if len(m.shells) >= MaxOpen {
		m.mu.Unlock()
		_ = term.Close()
		return OpenResult{}, fmt.Errorf("%d shells are already open on this computer", MaxOpen)
	}
	m.shells[req.ShellID] = s
	m.order = append(m.order, req.ShellID)
	m.mu.Unlock()

	// The banner goes up before anyone can type: nothing can open a shell without it. On a computer
	// with a desktop (Banner set) a banner that cannot be shown ends the shell before the server is
	// ever joined (fail closed). Only a computer with no desktop at all (Banner nil: a headless
	// server, nobody to show it to) opens with "unavailable", which the operator sees.
	res := OpenResult{Shell: term.Name(), PTY: term.Kind(), Banner: "shown"}
	if req.Silent() {
		// Banner off for this group: nothing is drawn; the server keeps the transcript and the audit.
		res.Banner = "off"
	} else if err := m.showBanner(); err != nil {
		if m.cfg.Banner != nil {
			m.cfg.Log.Warn("shell refused: the banner could not be shown", "shell", req.ShellID, "error", err.Error())
			s.finish("open_failed", nil, false)
			return OpenResult{Shell: term.Name(), PTY: term.Kind(), Banner: "failed", BannerError: err.Error()}, fmt.Errorf("the shell was not opened because the Nigafiy banner could not be shown: %w", err)
		}
		res.Banner, res.BannerError = "unavailable", err.Error()
		m.cfg.Log.Warn("shell banner could not be shown", "shell", req.ShellID, "error", err.Error())
	}

	dctx, cancel := context.WithTimeout(ctx, handshakeTimeout+5*time.Second)
	defer cancel()
	conn, err := wsclient.Dial(dctx, target, wsclient.Options{
		Header:           http.Header{"Authorization": {"Bearer " + m.cfg.Credential()}, "User-Agent": {m.cfg.UserAgent}},
		TLS:              m.cfg.TLS,
		MaxMessage:       maxInputMessage,
		HandshakeTimeout: handshakeTimeout,
		Dialer:           m.cfg.Dialer,
	})
	if err != nil {
		s.finish("open_failed", nil, false)
		return res, fmt.Errorf("could not reach the server for the shell: %w", err)
	}
	s.conn = conn
	hello, _ := json.Marshal(map[string]any{"t": "hello", "shell": term.Name(), "pty": term.Kind(), "cols": req.Cols, "rows": req.Rows})
	if err := conn.WriteText(hello); err != nil {
		s.finish("agent_gone", nil, true)
		return res, err
	}
	m.cfg.Log.Info("remote shell open", "shell", req.ShellID, "operator", userui.Clean(req.Operator, 120), "pty", term.Kind())
	go s.pumpOutput()
	go s.pumpInput()
	go s.watch()
	return res, nil
}

// Close ends a shell the server ended (shell_close). False when it is not open here.
func (m *Manager) Close(shellID, reason string) bool {
	m.mu.Lock()
	s := m.shells[shellID]
	m.mu.Unlock()
	if s == nil {
		return false
	}
	s.finish("server:"+reason, nil, false)
	return true
}

// EndAll ends every shell here: End session on the banner ("user"), or the agent stopping
// ("agent_gone"). The API hears it first, so the shell's end has the right reason.
func (m *Manager) EndAll(reason string) int {
	m.mu.Lock()
	var list []*session
	for _, id := range m.order {
		list = append(list, m.shells[id])
	}
	m.mu.Unlock()
	for _, s := range list {
		s.finish(reason, nil, true)
	}
	return len(list)
}

// Count is how many shells are open here.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.order)
}

// Lines are the banner's lines for the open shells (oldest first).
func (m *Manager) Lines() []userui.ShellLine {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []userui.ShellLine
	for _, id := range m.order {
		s := m.shells[id]
		if s.req.Silent() {
			continue
		}
		out = append(out, userui.ShellLine{Operator: s.req.Operator, Reason: s.req.Reason})
	}
	return out
}

func (m *Manager) showBanner() error {
	if m.cfg.Banner == nil {
		return errors.New("no desktop to show the banner on")
	}
	lines := m.Lines()
	var end func()
	if len(lines) > 0 {
		end = func() { m.EndAll("user") }
	}
	return m.cfg.Banner(lines, end)
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.shells, id)
	for i, o := range m.order {
		if o == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
	if err := m.showBanner(); err != nil && m.cfg.Banner != nil {
		m.cfg.Log.Debug("shell banner update failed", "error", err.Error())
	}
}

func (s *session) touch() { s.last.Store(time.Now().UnixNano()) }

// count adds to the bytes that went through; past the limit the shell ends.
func (s *session) count(n int) {
	if s.bytes.Add(int64(n)) > s.maxBytes {
		go s.finish("limit", nil, true)
	}
}

// pumpOutput: the shell's output to the API, then its exit.
func (s *session) pumpOutput() {
	buf := make([]byte, readBuffer)
	for {
		n, err := s.term.Read(buf)
		if n > 0 {
			s.touch()
			s.count(n)
			if werr := s.conn.WriteBinary(buf[:n]); werr != nil {
				s.finish("agent_gone", nil, true)
				return
			}
		}
		if err != nil {
			break
		}
	}
	code, _ := s.term.Wait()
	msg, _ := json.Marshal(map[string]any{"t": "exit", "code": code})
	// The API ends the shell as "exited" when it gets this; otherwise tell it over HTTP.
	sent := s.conn.WriteText(msg) == nil
	s.finish("exited", &code, !sent)
}

// pumpInput: keystrokes and resizes from the operator; the API closing the socket ends the shell.
func (s *session) pumpInput() {
	for {
		op, data, err := s.conn.Read()
		if err != nil {
			var ce *wsclient.CloseError
			if errors.As(err, &ce) {
				s.finish("server", nil, false)
			} else {
				s.finish("agent_gone", nil, true)
			}
			return
		}
		switch op {
		case wsclient.OpBinary:
			s.touch()
			s.count(len(data))
			if _, err := s.term.Write(data); err != nil {
				s.m.cfg.Log.Debug("shell input failed", "error", err.Error())
			}
		case wsclient.OpText:
			var m struct {
				T    string `json:"t"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.T {
			case "resize":
				_ = s.term.Resize(clamp(m.Cols, 20, 400, 120), clamp(m.Rows, 5, 200, 30))
			case "end":
				s.finish("server", nil, false)
				return
			}
		}
	}
}

// watch ends the shell after the idle timeout (no input and no output).
func (s *session) watch() {
	t := time.NewTicker(s.m.cfg.CheckEvery)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			if time.Since(time.Unix(0, s.last.Load())) > s.idle {
				s.finish("idle", nil, true)
				return
			}
		}
	}
}

// finish ends the shell once: the API is told first (when notify), then the socket closes, the
// shell and everything it started stop, and its banner line goes.
func (s *session) finish(reason string, code *int, notify bool) {
	s.once.Do(func() {
		close(s.done)
		apiReason := reason
		if apiReason == "open_failed" {
			notify = false
		}
		if notify && s.m.cfg.NotifyEnded != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			if err := s.m.cfg.NotifyEnded(ctx, s.req.ShellID, apiReason, code); err != nil {
				s.m.cfg.Log.Warn("could not tell the server the shell ended", "shell", s.req.ShellID, "error", err.Error())
			}
			cancel()
		}
		if s.conn != nil {
			_ = s.conn.Close(wsclient.CloseNormal, "shell ended")
		}
		_ = s.term.Close()
		s.m.remove(s.req.ShellID)
		s.m.cfg.Log.Info("remote shell ended", "shell", s.req.ShellID, "reason", reason)
	})
}

func clamp(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	return max(lo, min(hi, v))
}
