package rdstream

import (
	"context"
	"encoding/base64"
	"errors"
	"runtime"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/clipboard"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/sas"
	"github.com/nigafiy/agent/internal/userui"
)

// In-session tools on the stream socket. Every one is checked against the session's profile here
// (the server checked it first) and every one is visible to the person at the screen: the banner
// says when the privacy screen is on or their input is paused, chat and questions are windows they
// answer, annotations are drawn on their screen. Nothing here can hide the banner.
//
//	server → agent: privacy{on} block_input{on} sas chat{from,text} ask{id,from,text,kind,timeout_s}
//	                annotate{op} audio{on,mono} clipboard_get{req,format} clipboard_set{req,format,...}
//	agent → server: tool_state{...} tool_error{tool,code,error} sas_result{ok,code,error}
//	                chat{from:"user",text} answer{id,answer,text} audio packets (binary 'N',2)

// toolState is what the session has switched on (shown on the banner and to every viewer).
type toolState struct {
	mu        sync.Mutex
	privacy   bool
	blocked   bool
	audio     bool
	operators []string
	recording bool
	stream    *stream
}

// Features lists the tools this agent build supports on this OS (the viewer hides the rest and
// says why).
func Features() []string {
	f := []string{"chat", "ask", "clipboard_image", "clipboard_files", "keys_by_position", "key_combo", "cursor", "depth"}
	if runtime.GOOS == "windows" {
		f = append(f, "privacy_screen", "annotate", "block_input", "sas", "audio")
	}
	return f
}

func (l *live) bannerInfo() userui.BannerInfo {
	l.tools.mu.Lock()
	defer l.tools.mu.Unlock()
	perms := l.perms
	return userui.BannerInfo{
		SessionID: l.req.SessionID, Operator: l.req.Operator, Reason: l.req.Reason, Control: l.req.Control,
		Permissions: &perms, Profile: l.req.Profile, Operators: append([]string(nil), l.tools.operators...),
		Recording: l.tools.recording, PrivacyScreen: l.tools.privacy, InputBlocked: l.tools.blocked,
	}
}

// refreshBanner shows the banner again with what is on now (the old one is replaced).
func (l *live) refreshBanner() {
	d := l.m.cfg.Desktop
	sess := l.req.SessionID
	if err := d.ShowBanner(l.bannerInfo(), func() { l.m.endedByUser(sess) }); err != nil {
		l.m.cfg.Log.Warn("session banner could not be refreshed", "session", sess, "error", err.Error())
	}
}

func (l *live) stateMsg() map[string]any {
	l.tools.mu.Lock()
	defer l.tools.mu.Unlock()
	return map[string]any{"t": "tool_state", "privacy": l.tools.privacy, "input_blocked": l.tools.blocked, "audio": l.tools.audio,
		"operators": l.tools.operators, "recording": l.tools.recording}
}

func (l *live) setStream(s *stream) {
	l.tools.mu.Lock()
	l.tools.stream = s
	l.tools.mu.Unlock()
}

func (l *live) currentStream() *stream {
	l.tools.mu.Lock()
	defer l.tools.mu.Unlock()
	return l.tools.stream
}

// UpdateRequest is the payload of rd_session_update: who is in the session now and whether it is
// recorded. The banner shows both.
type UpdateRequest struct {
	SessionID string   `json:"session_id"`
	Operators []string `json:"operators"`
	Recording bool     `json:"recording"`
}

// Update changes the banner of the open session. false when that session is not open here.
func (m *Manager) Update(u UpdateRequest) bool {
	m.mu.Lock()
	l := m.active
	m.mu.Unlock()
	if l == nil || l.req.SessionID != u.SessionID {
		return false
	}
	l.tools.mu.Lock()
	l.tools.operators = userui.BannerInfo{Operators: u.Operators}.Normalize().Operators
	l.tools.recording = u.Recording
	s := l.tools.stream
	l.tools.mu.Unlock()
	l.refreshBanner()
	if s != nil {
		s.send(l.stateMsg())
	}
	return true
}

// toolEvent receives what the desktop reports on its own.
func (m *Manager) toolEvent(ev desktop.ToolEvent, data []byte) {
	if ev.Kind == "help_request" {
		// From the tray, with or without a session.
		if m.cfg.OnHelpRequest != nil && ev.Text != "" {
			m.cfg.OnHelpRequest(ev.Text, ev.User)
		}
		return
	}
	m.mu.Lock()
	l := m.active
	m.mu.Unlock()
	if l == nil || ev.Session != l.req.SessionID {
		return
	}
	switch ev.Kind {
	case "end_combo":
		// Ctrl+Alt+Shift+E while the local input was blocked: the session ends, as from the banner.
		go m.endedByUser(ev.Session)
	case "chat_reply":
		if s := l.currentStream(); s != nil && ev.Text != "" {
			s.send(map[string]any{"t": "chat", "from": "user", "text": ev.Text})
		}
	case "audio":
		s := l.currentStream()
		if s == nil || ev.Audio == nil {
			return
		}
		pkt := ev.Audio.Packet(data)
		s.wmu.Lock()
		_ = s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = s.conn.WriteBinary(pkt)
		s.wmu.Unlock()
	case "audio_error":
		if s := l.currentStream(); s != nil {
			s.send(map[string]any{"t": "tool_error", "tool": "audio", "error": ev.Text})
		}
	}
}

func (s *stream) toolErr(tool, code string, err error) {
	msg := map[string]any{"t": "tool_error", "tool": tool, "error": err.Error()}
	if code != "" {
		msg["code"] = code
	}
	var r *sas.Refusal
	if errors.As(err, &r) {
		msg["code"] = r.Code
	}
	if errors.Is(err, userui.ErrToolUnsupported) {
		msg["code"] = "unsupported_here"
	}
	s.send(msg)
}

func (s *stream) forbidden(tool, flag, what string) {
	s.send(map[string]any{"t": "tool_error", "tool": tool, "code": "profile_forbids_" + flag, "error": "the session profile does not allow " + what})
}

// handleTool applies one tool message; false when m.T is not a tool message.
func (s *stream) handleTool(ctx context.Context, m inMsg) bool {
	l := s.l
	d := l.m.cfg.Desktop
	sess := l.req.SessionID
	switch m.T {
	case "privacy":
		if !l.perms.PrivacyScreen {
			s.forbidden("privacy", "privacy_screen", "the privacy screen")
			return true
		}
		on := m.On
		l.tools.mu.Lock()
		l.tools.privacy = on
		l.tools.mu.Unlock()
		info := l.bannerInfo()
		go func() {
			op := desktop.ToolPrivacyOff
			if on {
				op = desktop.ToolPrivacyOn
			}
			res, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: op, Info: &info}, nil)
			if err != nil {
				l.tools.mu.Lock()
				l.tools.privacy = false
				l.tools.mu.Unlock()
				s.toolErr("privacy", "", err)
			}
			l.refreshBanner()
			st := l.stateMsg()
			if res.Privacy != nil {
				st["privacy_monitors"] = res.Privacy.Monitors
				st["privacy_excluded"] = res.Privacy.Excluded
				if res.Privacy.Note != "" {
					st["privacy_note"] = res.Privacy.Note
				}
			}
			s.send(st)
			s.signal()
		}()
	case "block_input":
		if !l.perms.BlockInput {
			s.forbidden("block_input", "block_input", "blocking the local keyboard and mouse")
			return true
		}
		on := m.On
		go func() {
			op := desktop.ToolBlockOff
			if on {
				op = desktop.ToolBlockOn
			}
			_, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: op}, nil)
			l.tools.mu.Lock()
			if err == nil {
				l.tools.blocked = on
			} else {
				l.tools.blocked = false
			}
			l.tools.mu.Unlock()
			if err != nil {
				s.toolErr("block_input", "", err)
			}
			l.refreshBanner()
			s.send(l.stateMsg())
		}()
	case "sas":
		if !l.req.Control || !l.perms.Control {
			s.forbidden("sas", "control", "sending Ctrl+Alt+Del (the session is view only)")
			return true
		}
		go func() {
			fn := l.m.cfg.SAS
			if fn == nil {
				fn = sas.Send
			}
			err := fn(d.Info().Mode == "session_helper" && runtime.GOOS == "windows")
			if err != nil {
				msg := map[string]any{"t": "sas_result", "ok": false, "error": err.Error()}
				var r *sas.Refusal
				if errors.As(err, &r) {
					msg["code"] = r.Code
				}
				s.send(msg)
				return
			}
			s.send(map[string]any{"t": "sas_result", "ok": true})
		}()
	case "chat":
		text := userui.CleanMultiline(m.Text, userui.MaxChatText)
		if text == "" {
			return true
		}
		from := m.From
		if from == "" {
			from = l.req.Operator
		}
		go func() {
			if _, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolChat, Chat: &userui.ChatLine{From: from, Text: text}}, nil); err != nil {
				s.toolErr("chat", "", err)
				return
			}
			s.send(map[string]any{"t": "chat_shown", "id": m.ID})
		}()
	case "ask":
		from := m.From
		if from == "" {
			from = l.req.Operator
		}
		req := userui.AskRequest{SessionID: sess, ID: m.ID, Operator: from, Text: m.Text, Kind: m.Kind, TimeoutSeconds: m.TimeoutS}.Normalize()
		if req.Text == "" {
			return true
		}
		go func() {
			a, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolAsk, Ask: &req}, nil)
			if err != nil {
				s.toolErr("ask", "", err)
				return
			}
			if a.Answer == nil {
				return
			}
			s.send(map[string]any{"t": "answer", "id": req.ID, "answer": a.Answer.Answer, "text": a.Answer.Text})
		}()
	case "annotate":
		if m.Op == nil {
			return true
		}
		op := *m.Op
		if op.Op == "clear" {
			go func() { _, _, _ = d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolOverlayClose}, nil) }()
			return true
		}
		if err := op.Validate(); err != nil {
			s.toolErr("annotate", "invalid", err)
			return true
		}
		go func() {
			if _, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolOverlay, Overlay: &op}, nil); err != nil {
				s.toolErr("annotate", "", err)
			}
		}()
	case "audio":
		if !l.perms.Audio {
			s.forbidden("audio", "audio", "listening to this computer's sound")
			return true
		}
		on, mono := m.On, m.Mono
		go func() {
			op := desktop.ToolAudioOff
			if on {
				op = desktop.ToolAudioOn
			}
			res, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: op, Mono: mono}, nil)
			l.tools.mu.Lock()
			l.tools.audio = on && err == nil
			l.tools.mu.Unlock()
			if err != nil {
				s.toolErr("audio", "", err)
			}
			st := l.stateMsg()
			if res.Audio != nil {
				st["audio_format"] = res.Audio
			}
			s.send(st)
		}()
	default:
		return false
	}
	return true
}

// richClipboard handles clipboard_get / clipboard_set for pictures and file lists; false when the
// format is text (the caller handles it).
func (s *stream) richClipboard(ctx context.Context, m inMsg, get bool) bool {
	if m.Format == "" || m.Format == "text" {
		return false
	}
	l := s.l
	d := l.m.cfg.Desktop
	sess := l.req.SessionID
	fail := func(code string, err error) {
		msg := map[string]any{"t": "clipboard_error", "req": m.Req, "format": m.Format, "error": err.Error()}
		if code != "" {
			msg["code"] = code
		}
		s.send(msg)
	}
	if get && !l.perms.ClipboardOut {
		fail("profile_forbids_clipboard_out", errors.New("the session profile does not allow taking the clipboard from this computer"))
		return true
	}
	if !get && !l.perms.ClipboardIn {
		fail("profile_forbids_clipboard_in", errors.New("the session profile does not allow sending the clipboard to this computer"))
		return true
	}
	if m.Format == "files" && !l.perms.Files {
		fail("profile_forbids_files", errors.New("the session profile does not allow file transfer"))
		return true
	}
	switch m.Format {
	case "image":
		go func() {
			if get {
				_, png, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolClipImageGet}, nil)
				if err != nil {
					fail("", err)
					return
				}
				s.send(map[string]any{"t": "clipboard", "req": m.Req, "format": "image", "mime": "image/png", "data": base64.StdEncoding.EncodeToString(png), "bytes": len(png)})
				return
			}
			png, err := base64.StdEncoding.DecodeString(m.Data)
			if err == nil {
				_, err = clipboard.CheckImagePNG(png)
			}
			if err == nil {
				_, _, err = d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolClipImageSet}, png)
			}
			if err != nil {
				fail("", err)
				return
			}
			s.send(map[string]any{"t": "clipboard_set_ok", "req": m.Req, "format": "image", "bytes": len(png)})
		}()
	case "files":
		go func() {
			if get {
				res, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolClipFilesGet}, nil)
				if err != nil {
					fail("", err)
					return
				}
				s.send(map[string]any{"t": "clipboard", "req": m.Req, "format": "files", "paths": res.Paths})
				return
			}
			if err := clipboard.CheckPaths(m.Paths); err != nil {
				fail("", err)
				return
			}
			if _, _, err := d.Tool(ctx, desktop.ToolRequest{Session: sess, Op: desktop.ToolClipFilesSet, Paths: m.Paths}, nil); err != nil {
				fail("", err)
				return
			}
			s.send(map[string]any{"t": "clipboard_set_ok", "req": m.Req, "format": "files", "count": len(m.Paths)})
		}()
	default:
		fail("invalid", errors.New("unknown clipboard format"))
	}
	return true
}
