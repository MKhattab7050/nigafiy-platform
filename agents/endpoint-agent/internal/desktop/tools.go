package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/audio"
	"github.com/nigafiy/agent/internal/clipboard"
	"github.com/nigafiy/agent/internal/inputblock"
	"github.com/nigafiy/agent/internal/userui"
)

// In-session tools that run on the interactive desktop (the privacy screen, the chat, questions,
// annotations, blocking the local input, rich clipboard, audio). They go through one method so the
// session helper protocol carries them without one wire method per tool.

// Tool operations.
const (
	ToolPrivacyOn     = "privacy_on"
	ToolPrivacyOff    = "privacy_off"
	ToolBlockOn       = "block_on"
	ToolBlockOff      = "block_off"
	ToolChat          = "chat"
	ToolChatClose     = "chat_close"
	ToolAsk           = "ask"
	ToolOverlay       = "overlay"
	ToolOverlayClose  = "overlay_close"
	ToolClipImageGet  = "clip_image_get"
	ToolClipImageSet  = "clip_image_set"
	ToolClipFilesGet  = "clip_files_get"
	ToolClipFilesSet  = "clip_files_set"
	ToolAudioOn       = "audio_on"
	ToolAudioOff      = "audio_off"
	ToolEndAllForSess = "end_all"
	// ToolTray shows (or updates) the Nigafiy tray icon: Request help, About with the Nigafiy ID.
	ToolTray = "tray"
	// ToolOpenURL opens a page of the Nigafiy server in the person's browser (a "Past recordings"
	// link). The agent builds the URL from its own server address; http(s) only.
	ToolOpenURL = "open_url"
)

type ToolRequest struct {
	Session string             `json:"session"`
	Op      string             `json:"op"`
	Info    *userui.BannerInfo `json:"info,omitempty"`
	Chat    *userui.ChatLine   `json:"chat,omitempty"`
	Ask     *userui.AskRequest `json:"ask,omitempty"`
	Overlay *userui.OverlayOp  `json:"overlay,omitempty"`
	Paths   []string           `json:"paths,omitempty"`
	Mono    bool               `json:"mono,omitempty"`
	Tray    *TrayInfo          `json:"tray,omitempty"`
	URL     string             `json:"url,omitempty"`
}

// TrayInfo is what the tray shows in "About".
type TrayInfo struct {
	NigafiyID string `json:"nigafiy_id"`
	Server    string `json:"server"`
	// Recordings: show "Past recordings…" (the group allows it). SessionOpen: enable "End current
	// session" (a remote session or shell is open).
	Recordings  bool `json:"recordings,omitempty"`
	SessionOpen bool `json:"session_open,omitempty"`
}

type ToolResult struct {
	Privacy *userui.PrivacyResult `json:"privacy,omitempty"`
	Answer  *userui.AskAnswer     `json:"answer,omitempty"`
	Paths   []string              `json:"paths,omitempty"`
	Audio   *audio.Format         `json:"audio,omitempty"`
}

// ToolEvent comes from the desktop on its own: a chat reply typed by the person, the end
// combination pressed while input is blocked, an audio packet (Data holds the ADPCM bytes).
type ToolEvent struct {
	Session string `json:"session"`
	Kind    string `json:"kind"` // chat_reply | end_combo | audio | audio_error | help_request | it_activity_request
	Text    string `json:"text,omitempty"`
	// User: the account that asked (help_request from the tray).
	User  string        `json:"user,omitempty"`
	Audio *audio.Header `json:"audio,omitempty"`
}

// ErrToolUnsupported: the tool cannot run on this desktop (the error says why).
var ErrToolUnsupported = userui.ErrToolUnsupported

// localTools is the in-process implementation used by Local.
type localTools struct {
	mu      sync.Mutex
	events  func(ToolEvent, []byte)
	blocker map[string]inputblock.Blocker
	capture map[string]audio.Capture
}

func (t *localTools) emit(ev ToolEvent, data []byte) {
	t.mu.Lock()
	fn := t.events
	t.mu.Unlock()
	if fn != nil {
		fn(ev, data)
	}
}

// SetToolEvents sets where chat replies, the end combination and audio packets go.
func (l *Local) SetToolEvents(fn func(ToolEvent, []byte)) {
	l.tools.mu.Lock()
	l.tools.events = fn
	l.tools.mu.Unlock()
}

func (l *Local) toolUI() (userui.ToolUI, error) {
	if tu, ok := l.ui.(userui.ToolUI); ok {
		return tu, nil
	}
	return nil, fmt.Errorf("this desktop has no session tool windows: %w", ErrToolUnsupported)
}

func (l *Local) Tool(ctx context.Context, req ToolRequest, data []byte) (ToolResult, []byte, error) {
	t := &l.tools
	switch req.Op {
	case ToolPrivacyOn, ToolPrivacyOff:
		tu, err := l.toolUI()
		if err != nil {
			return ToolResult{}, nil, err
		}
		info := userui.BannerInfo{SessionID: req.Session}
		if req.Info != nil {
			info = *req.Info
		}
		res, err := tu.PrivacyScreen(req.Session, req.Op == ToolPrivacyOn, info)
		return ToolResult{Privacy: &res}, nil, err
	case ToolBlockOn:
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.blocker == nil {
			t.blocker = map[string]inputblock.Blocker{}
		}
		if t.blocker[req.Session] != nil {
			return ToolResult{}, nil, nil
		}
		sess := req.Session
		b, err := inputblock.Start(func() { go t.emit(ToolEvent{Session: sess, Kind: "end_combo"}, nil) })
		if err != nil {
			return ToolResult{}, nil, err
		}
		t.blocker[sess] = b
		return ToolResult{}, nil, nil
	case ToolBlockOff:
		t.mu.Lock()
		b := t.blocker[req.Session]
		delete(t.blocker, req.Session)
		t.mu.Unlock()
		if b != nil {
			b.Stop()
		}
		return ToolResult{}, nil, nil
	case ToolChat:
		tu, err := l.toolUI()
		if err != nil {
			return ToolResult{}, nil, err
		}
		if req.Chat == nil {
			return ToolResult{}, nil, errors.New("chat line missing")
		}
		sess := req.Session
		return ToolResult{}, nil, tu.Chat(sess, *req.Chat, func(text string) {
			t.emit(ToolEvent{Session: sess, Kind: "chat_reply", Text: userui.CleanMultiline(text, userui.MaxChatText)}, nil)
		})
	case ToolChatClose:
		if tu, err := l.toolUI(); err == nil {
			tu.CloseChat(req.Session)
		}
		return ToolResult{}, nil, nil
	case ToolAsk:
		tu, err := l.toolUI()
		if err != nil {
			return ToolResult{}, nil, err
		}
		if req.Ask == nil {
			return ToolResult{}, nil, errors.New("question missing")
		}
		a, err := tu.Ask(ctx, *req.Ask)
		return ToolResult{Answer: &a}, nil, err
	case ToolOverlay:
		tu, err := l.toolUI()
		if err != nil {
			return ToolResult{}, nil, err
		}
		if req.Overlay == nil {
			return ToolResult{}, nil, errors.New("overlay operation missing")
		}
		return ToolResult{}, nil, tu.Overlay(req.Session, *req.Overlay)
	case ToolOverlayClose:
		if tu, err := l.toolUI(); err == nil {
			tu.CloseOverlay(req.Session)
		}
		return ToolResult{}, nil, nil
	case ToolClipImageGet:
		png, err := clipboard.ReadImagePNG()
		return ToolResult{}, png, err
	case ToolClipImageSet:
		return ToolResult{}, nil, clipboard.WriteImagePNG(data)
	case ToolClipFilesGet:
		paths, err := clipboard.ReadFiles()
		return ToolResult{Paths: paths}, nil, err
	case ToolClipFilesSet:
		return ToolResult{}, nil, clipboard.WriteFiles(req.Paths)
	case ToolAudioOn:
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.capture == nil {
			t.capture = map[string]audio.Capture{}
		}
		if c := t.capture[req.Session]; c != nil {
			f := c.Format()
			return ToolResult{Audio: &f}, nil, nil
		}
		sess := req.Session
		c, err := audio.Start(audio.Options{Mono: req.Mono}, func(h audio.Header, pkt []byte) {
			t.emit(ToolEvent{Session: sess, Kind: "audio", Audio: &h}, pkt)
		})
		if err != nil {
			return ToolResult{}, nil, err
		}
		t.capture[sess] = c
		f := c.Format()
		return ToolResult{Audio: &f}, nil, nil
	case ToolAudioOff:
		t.mu.Lock()
		c := t.capture[req.Session]
		delete(t.capture, req.Session)
		t.mu.Unlock()
		if c != nil {
			c.Stop()
		}
		return ToolResult{}, nil, nil
	case ToolTray:
		if req.Tray == nil {
			return ToolResult{}, nil, errors.New("tray: no info")
		}
		return ToolResult{}, nil, l.showTray(*req.Tray)
	case ToolEndAllForSess:
		l.endTools(req.Session)
		return ToolResult{}, nil, nil
	case ToolOpenURL:
		return ToolResult{}, nil, openURL(req.URL)
	}
	return ToolResult{}, nil, fmt.Errorf("unknown session tool %q", req.Op)
}

// endTools clears every tool of a session ("" = all): the privacy screen, blocked input, the
// chat, the overlay and audio. Called when the session ends however it ends.
func (l *Local) endTools(session string) {
	t := &l.tools
	t.mu.Lock()
	var blockers []inputblock.Blocker
	var caps []audio.Capture
	for s, b := range t.blocker {
		if session == "" || s == session {
			blockers = append(blockers, b)
			delete(t.blocker, s)
		}
	}
	for s, c := range t.capture {
		if session == "" || s == session {
			caps = append(caps, c)
			delete(t.capture, s)
		}
	}
	t.mu.Unlock()
	for _, b := range blockers {
		b.Stop()
	}
	for _, c := range caps {
		c.Stop()
	}
	if tu, err := l.toolUI(); err == nil && session != "" {
		_, _ = tu.PrivacyScreen(session, false, userui.BannerInfo{SessionID: session})
		tu.CloseOverlay(session)
		tu.CloseChat(session)
	}
}

// ---------------------------------------------------------------------------------------------
// Helper protocol: method "tool" with params ToolRequest (+ binary data), result ToolResult (+ data);
// events {"ev":"tool","r":ToolEvent} (+ audio data).

func toolTimeout(req ToolRequest) time.Duration {
	if req.Op == ToolAsk && req.Ask != nil {
		return time.Duration(req.Ask.Normalize().TimeoutSeconds+15) * time.Second
	}
	return helperTimeout
}

func (c *HelperClient) SetToolEvents(fn func(ToolEvent, []byte)) {
	c.mu.Lock()
	c.toolEvents = fn
	c.mu.Unlock()
}

func (c *HelperClient) Tool(ctx context.Context, req ToolRequest, data []byte) (ToolResult, []byte, error) {
	var res ToolResult
	out, err := c.callData(ctx, "tool", req, data, &res, toolTimeout(req))
	return res, out, err
}

func (c *HelperClient) handleToolEvent(m wireMsg, data []byte) {
	var ev ToolEvent
	if json.Unmarshal(m.Result, &ev) != nil {
		return
	}
	c.mu.Lock()
	fn := c.toolEvents
	c.mu.Unlock()
	if fn != nil {
		fn(ev, data)
	}
}

func (s *Supervisor) SetToolEvents(fn func(ToolEvent, []byte)) {
	s.mu.Lock()
	s.toolEvents = fn
	c := s.client
	s.mu.Unlock()
	if c != nil {
		c.SetToolEvents(fn)
	}
}

func (s *Supervisor) Tool(ctx context.Context, req ToolRequest, data []byte) (ToolResult, []byte, error) {
	c, err := s.get()
	if err != nil {
		return ToolResult{}, nil, err
	}
	return c.Tool(ctx, req, data)
}
