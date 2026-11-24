// Package desktop is everything a remote support session does on the interactive desktop: screen
// capture and encoding, mouse/keyboard input, the consent dialog, the session banner and the
// clipboard. Two implementations:
//
//   - Local: in this process. Used when the agent itself runs in the user's desktop session.
//   - Helper (Supervisor + HelperClient): forwards every call to a session helper — the same agent
//     binary started as `nigafiy-agent session-helper` inside the user's desktop session — over the
//     helper's stdin/stdout. Used when the agent runs as a Windows service (session 0 has no
//     desktop) or as root outside the graphical session on Linux/macOS. The helper never holds the
//     agent's credential and has no network listener: it only answers its parent over an anonymous
//     pipe.
package desktop

import (
	"context"
	"errors"
	"sync"

	"github.com/nigafiy/agent/internal/clipboard"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
)

type Desktop interface {
	Displays() ([]remotedesktop.DisplayInfo, error)
	// CaptureFrame is the HTTP fallback path (one JPEG per rd_capture command).
	CaptureFrame(opts remotedesktop.CaptureOptions) (remotedesktop.Frame, error)
	// Grab encodes what changed on the stream's display since its previous Grab (nil: unchanged).
	Grab(stream string, req remotedesktop.GrabRequest) (*remotedesktop.EncodedFrame, error)
	ResetStream(stream string)
	EndStream(stream string)
	Input(ev remotedesktop.InputEvent) error
	Consent(ctx context.Context, req userui.ConsentRequest) (userui.ConsentAnswer, error)
	ShowBanner(info userui.BannerInfo, onEnd func()) error
	HideBanner(sessionID string)
	ClipboardText() (string, error)
	SetClipboardText(text string) error
	// Tool runs one in-session tool (privacy screen, chat, question, annotations, input block,
	// rich clipboard, audio); see tools.go.
	Tool(ctx context.Context, req ToolRequest, data []byte) (ToolResult, []byte, error)
	SetToolEvents(fn func(ToolEvent, []byte))
	Info() Info
	Close() error
}

// Info: where the desktop work happens and what the OS allows (macOS privacy permissions).
type Info struct {
	// Mode: "local" (this process) or "session_helper".
	Mode string `json:"mode"`
	// Permissions (macOS): screen_recording / accessibility = granted | denied | unknown.
	Permissions map[string]string `json:"permissions,omitempty"`
	// InputSupported: mouse/keyboard can be injected here.
	InputSupported bool `json:"input_supported"`
	// Backend: capture/input mechanism (e.g. gdi, x11, wayland-portal, screencapture).
	Backend string `json:"backend,omitempty"`
}

// ErrHelperGone: the session helper exited (the user signed out, switched, or it crashed).
var ErrHelperGone = errors.New("the session helper in the user's desktop is not running")

// Local runs everything in this process.
type Local struct {
	ui       userui.UI
	capture  remotedesktop.CaptureSource
	mu       sync.Mutex
	encoders map[string]*remotedesktop.Encoder
	tools    localTools
}

func NewLocal() *Local {
	return &Local{ui: userui.New(), capture: remotedesktop.SystemCapture, encoders: map[string]*remotedesktop.Encoder{}}
}

// NewLocalWith is for tests: a synthetic capture source and UI.
func NewLocalWith(ui userui.UI, src remotedesktop.CaptureSource) *Local {
	return &Local{ui: ui, capture: src, encoders: map[string]*remotedesktop.Encoder{}}
}

func (l *Local) Displays() ([]remotedesktop.DisplayInfo, error) {
	return remotedesktop.EnumerateDisplays()
}

func (l *Local) CaptureFrame(opts remotedesktop.CaptureOptions) (remotedesktop.Frame, error) {
	return remotedesktop.CaptureFrame(opts)
}

func (l *Local) encoder(stream string) *remotedesktop.Encoder {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.encoders[stream]
	if e == nil {
		if len(l.encoders) >= 8 { // streams are ended explicitly; this only bounds a leak
			clear(l.encoders)
		}
		e = remotedesktop.NewEncoder(l.capture)
		l.encoders[stream] = e
	}
	return e
}

func (l *Local) Grab(stream string, req remotedesktop.GrabRequest) (*remotedesktop.EncodedFrame, error) {
	return l.encoder(stream).Grab(req)
}

func (l *Local) ResetStream(stream string) { l.encoder(stream).Reset() }

func (l *Local) EndStream(stream string) {
	l.mu.Lock()
	delete(l.encoders, stream)
	l.mu.Unlock()
}

func (l *Local) Input(ev remotedesktop.InputEvent) error { return remotedesktop.InjectInput(ev) }

func (l *Local) Consent(ctx context.Context, req userui.ConsentRequest) (userui.ConsentAnswer, error) {
	return l.ui.Consent(ctx, req)
}

func (l *Local) ShowBanner(info userui.BannerInfo, onEnd func()) error {
	return l.ui.ShowBanner(info, onEnd)
}
func (l *Local) HideBanner(sessionID string)        { l.ui.HideBanner(sessionID) }
func (l *Local) ClipboardText() (string, error)     { return clipboard.ReadText() }
func (l *Local) SetClipboardText(text string) error { return clipboard.WriteText(text) }
func (l *Local) Close() error {
	l.endTools("")
	l.ui.HideBanner("")
	return nil
}

func (l *Local) Info() Info {
	info := Info{Mode: "local", InputSupported: true, Backend: remotedesktop.Backend()}
	if p := remotedesktop.Permissions(); len(p) > 0 {
		info.Permissions = p
		if p["accessibility"] == "denied" {
			info.InputSupported = false
		}
	}
	return info
}
