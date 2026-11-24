package rdstream

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/clipboard"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/wsclient"
)

// Socket messages. Binary messages from the agent are frame packets (remotedesktop.Packet); text
// messages are JSON objects with a "t" field:
//
//	server → agent: viewers{count} ack{seq} full settings{display,quality,scale,adaptive}
//	                input{ev} clipboard_get{req} clipboard_set{req,text} displays end{reason}
//	agent → server: hello stats displays clipboard{req,text} clipboard_error{req,error}
//	                clipboard_set_ok{req} input_error{error} error{where,error}
type inMsg struct {
	T        string                    `json:"t"`
	Count    int                       `json:"count"`
	Seq      uint64                    `json:"seq"`
	Display  *int                      `json:"display"`
	Quality  int                       `json:"quality"`
	Scale    float64                   `json:"scale"`
	Adaptive *bool                     `json:"adaptive"`
	Ev       *remotedesktop.InputEvent `json:"ev"`
	Req      string                    `json:"req"`
	Text     string                    `json:"text"`
	Reason   string                    `json:"reason"`
	// In-session tools (tools.go) and the extra stream settings.
	On       bool              `json:"on"`
	Mono     bool              `json:"mono"`
	From     string            `json:"from"`
	ID       string            `json:"id"`
	Kind     string            `json:"kind"`
	TimeoutS int               `json:"timeout_s"`
	Op       *userui.OverlayOp `json:"op"`
	Format   string            `json:"format"`
	Data     string            `json:"data"`
	Paths    []string          `json:"paths"`
	Cursor   *bool             `json:"cursor"`
	Depth    *int              `json:"depth"`
}

// CloseSessionEnded is the close code the server uses when the session is over.
const CloseSessionEnded = 4000

// InflightWindow: frames sent and not yet acknowledged by the viewer. A small window keeps the
// picture current instead of queueing old frames on a slow link.
const InflightWindow = 2

// AckTimeout: a frame not acknowledged within this is counted as a stall (quality goes down).
const AckTimeout = 2 * time.Second

type stream struct {
	l    *live
	conn *wsclient.Conn

	mu        sync.Mutex
	viewers   int
	display   int
	needFull  bool
	ctrl      *Controller
	inflight  map[uint64]sent
	lastAck   time.Time
	wake      chan struct{}
	over      bool
	sentBytes int
	sentCount int
	lastStats time.Time
	lastFrame remotedesktop.FrameHeader
	cursor    bool
	depth     int
	wmu       sync.Mutex
}

type sent struct {
	at    time.Time
	bytes int
}

func newStream(l *live, conn *wsclient.Conn) *stream {
	q, s := l.req.Quality, l.req.Scale
	if q <= 0 {
		q = 85
	}
	if s <= 0 {
		s = 1
	}
	return &stream{l: l, conn: conn, display: l.req.Display, ctrl: NewController(q, s, true, time.Now()), inflight: map[uint64]sent{}, wake: make(chan struct{}, 1), needFull: true, cursor: true, depth: remotedesktop.Depth24}
}

func (s *stream) send(v any) {
	b, _ := json.Marshal(v)
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = s.conn.WriteText(b)
}

func (s *stream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// serve runs one connection; it returns true when the server ended the session.
func (s *stream) serve(ctx context.Context) bool {
	cfg := s.l.m.cfg
	d := cfg.Desktop
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()

	displays, _ := d.Displays()
	s.send(map[string]any{"t": "hello", "session_id": s.l.req.SessionID, "displays": displays, "desktop": d.Info(),
		"encoder": "jpeg", "webp": false, "tile": remotedesktop.TileSize, "control": s.l.req.Control, "max_fps": cfg.MaxFPS,
		"features": Features(), "cursor_supported": remotedesktop.CursorSupported, "end_hotkey": "Ctrl+Alt+Shift+E"})
	s.send(s.l.stateMsg())
	s.l.setStream(s)
	defer s.l.setStream(nil)

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer cancel()
		for {
			op, data, err := s.conn.Read()
			if err != nil {
				var ce *wsclient.CloseError
				if errors.As(err, &ce) && ce.Code == CloseSessionEnded {
					s.mu.Lock()
					s.over = true
					s.mu.Unlock()
				}
				return
			}
			if op != wsclient.OpText {
				continue
			}
			var m inMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			if s.handle(cctx, m) {
				return
			}
		}
	}()

	pinger := time.NewTicker(15 * time.Second)
	defer pinger.Stop()
	minGap := time.Second / time.Duration(cfg.MaxFPS)
	idleGap := minGap
	for cctx.Err() == nil {
		s.mu.Lock()
		viewers := s.viewers
		full := s.needFull
		s.needFull = false
		display := s.display
		cursor, depth := s.cursor, s.depth
		step := s.ctrl.Current()
		s.expireInflight(time.Now())
		blocked := len(s.inflight) >= InflightWindow
		s.mu.Unlock()

		select {
		case <-pinger.C:
			s.wmu.Lock()
			_ = s.conn.Ping([]byte("k"))
			s.wmu.Unlock()
		default:
		}

		if viewers == 0 || blocked {
			s.waitWake(cctx, 250*time.Millisecond)
			continue
		}
		started := time.Now()
		frame, err := d.Grab(s.l.req.SessionID, remotedesktop.GrabRequest{Display: display, Quality: step.Quality, Scale: step.Scale, Full: full, Cursor: cursor, Depth: depth})
		if err != nil {
			s.send(map[string]any{"t": "error", "where": "capture", "error": err.Error()})
			s.waitWake(cctx, time.Second)
			continue
		}
		if frame == nil {
			// Unchanged screen: look again soon, a little less often while it stays still.
			idleGap = min(idleGap*2, 200*time.Millisecond)
			s.maybeStats(time.Now())
			s.waitWake(cctx, idleGap)
			continue
		}
		idleGap = minGap
		pkt := frame.Packet()
		s.mu.Lock()
		s.inflight[frame.Header.Seq] = sent{at: time.Now(), bytes: len(pkt)}
		s.ctrl.FrameSent(len(pkt))
		s.sentBytes += len(pkt)
		s.sentCount++
		s.lastFrame = frame.Header
		s.mu.Unlock()
		s.wmu.Lock()
		_ = s.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
		err = s.conn.WriteBinary(pkt)
		s.wmu.Unlock()
		if err != nil {
			break
		}
		s.maybeStats(time.Now())
		if wait := minGap - time.Since(started); wait > 0 {
			// The frame-rate cap holds even when acks arrive sooner (they only wake a blocked loop).
			t := time.NewTimer(wait)
			select {
			case <-cctx.Done():
			case <-t.C:
			}
			t.Stop()
		}
	}
	cancel()
	_ = s.conn.Close(wsclient.CloseNormal, "")
	<-readDone
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.over
}

func (s *stream) waitWake(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-s.wake:
	case <-t.C:
	}
}

// expireInflight drops frames never acknowledged (caller holds mu).
func (s *stream) expireInflight(now time.Time) {
	for seq, f := range s.inflight {
		if now.Sub(f.at) > AckTimeout {
			delete(s.inflight, seq)
			s.ctrl.Timeout(now)
			s.needFull = true // the viewer may have missed it
		}
	}
}

func (s *stream) maybeStats(now time.Time) {
	s.mu.Lock()
	if now.Sub(s.lastStats) < time.Second {
		s.mu.Unlock()
		return
	}
	elapsed := now.Sub(s.lastStats).Seconds()
	if s.lastStats.IsZero() || elapsed > 5 {
		elapsed = 1
	}
	step := s.ctrl.Current()
	st := map[string]any{
		"t": "stats", "fps": float64(int(float64(s.sentCount)/elapsed*10)) / 10, "kbps": int(float64(s.sentBytes) * 8 / 1000 / elapsed),
		"rtt_ms": s.ctrl.RTT().Milliseconds(), "throughput_kbps": int(s.ctrl.Throughput() * 8 / 1000),
		"quality": step.Quality, "scale": step.Scale, "display": s.display, "adaptive": s.ctrl.adaptive,
		"changed_pct": s.lastFrame.ChangedPct, "cap_ms": s.lastFrame.CapMs, "enc_ms": s.lastFrame.EncMs, "viewers": s.viewers,
		"width": s.lastFrame.W, "height": s.lastFrame.H,
	}
	s.sentBytes, s.sentCount, s.lastStats = 0, 0, now
	s.mu.Unlock()
	s.send(st)
}

// handle applies one server message; true means the session is over.
func (s *stream) handle(ctx context.Context, m inMsg) bool {
	d := s.l.m.cfg.Desktop
	switch m.T {
	case "viewers":
		s.mu.Lock()
		if m.Count > s.viewers {
			s.needFull = true // a viewer joined: it needs a whole picture
		}
		s.viewers = max(0, m.Count)
		s.mu.Unlock()
		s.signal()
	case "ack":
		now := time.Now()
		s.mu.Lock()
		if f, ok := s.inflight[m.Seq]; ok {
			interval := now.Sub(s.lastAck)
			if s.lastAck.IsZero() {
				interval = now.Sub(f.at)
			}
			s.ctrl.Ack(now.Sub(f.at), f.bytes, interval, now)
			s.lastAck = now
			for seq := range s.inflight {
				if seq <= m.Seq {
					delete(s.inflight, seq)
				}
			}
		}
		s.mu.Unlock()
		s.signal()
	case "full":
		s.mu.Lock()
		s.needFull = true
		s.mu.Unlock()
		d.ResetStream(s.l.req.SessionID)
		s.signal()
	case "settings":
		s.mu.Lock()
		if m.Display != nil && *m.Display >= 0 && *m.Display <= 16 {
			s.display = *m.Display
		}
		if m.Cursor != nil {
			s.cursor = *m.Cursor
		}
		if m.Depth != nil {
			s.depth = remotedesktop.NormalizeDepth(*m.Depth)
		}
		adaptive := s.ctrl.adaptive
		if m.Adaptive != nil {
			adaptive = *m.Adaptive
		}
		if m.Quality > 0 && m.Scale > 0 {
			s.ctrl.SetCeiling(m.Quality, m.Scale, adaptive)
		} else if m.Adaptive != nil {
			cur := s.ctrl.Current()
			s.ctrl.SetCeiling(cur.Quality, cur.Scale, adaptive)
		}
		s.needFull = true
		s.mu.Unlock()
		s.signal()
	case "displays":
		list, err := d.Displays()
		if err != nil {
			s.send(map[string]any{"t": "error", "where": "displays", "error": err.Error()})
		} else {
			s.send(map[string]any{"t": "displays", "displays": list})
		}
	case "input":
		if m.Ev == nil {
			return false
		}
		if !s.l.req.Control || !s.l.perms.Control {
			s.send(map[string]any{"t": "input_error", "code": "profile_forbids_control", "error": "this session is view only"})
			return false
		}
		if err := d.Input(*m.Ev); err != nil {
			s.send(map[string]any{"t": "input_error", "error": err.Error()})
		}
		s.signal()
	case "clipboard_get":
		if s.richClipboard(ctx, m, true) {
			return false
		}
		if !s.l.perms.ClipboardOut {
			s.send(map[string]any{"t": "clipboard_error", "req": m.Req, "code": "profile_forbids_clipboard_out", "error": "the session profile does not allow taking the clipboard from this computer"})
			return false
		}
		go func(req string) {
			text, err := d.ClipboardText()
			if err != nil {
				s.send(map[string]any{"t": "clipboard_error", "req": req, "error": err.Error()})
				return
			}
			s.send(map[string]any{"t": "clipboard", "req": req, "text": text})
		}(m.Req)
	case "clipboard_set":
		if s.richClipboard(ctx, m, false) {
			return false
		}
		if !s.l.perms.ClipboardIn {
			s.send(map[string]any{"t": "clipboard_error", "req": m.Req, "code": "profile_forbids_clipboard_in", "error": "the session profile does not allow sending the clipboard to this computer"})
			return false
		}
		go func(req, text string) {
			if err := clipboard.Check(text); err != nil {
				s.send(map[string]any{"t": "clipboard_error", "req": req, "error": err.Error()})
				return
			}
			if err := d.SetClipboardText(text); err != nil {
				s.send(map[string]any{"t": "clipboard_error", "req": req, "error": err.Error()})
				return
			}
			s.send(map[string]any{"t": "clipboard_set_ok", "req": req})
		}(m.Req, m.Text)
	case "privacy", "block_input", "sas", "chat", "ask", "annotate", "audio":
		s.handleTool(ctx, m)
	case "end":
		s.mu.Lock()
		s.over = true
		s.mu.Unlock()
		return true
	}
	_ = ctx
	return false
}
