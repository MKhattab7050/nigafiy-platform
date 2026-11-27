package rdstream

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/clipboard"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/wsclient"
)

// Socket messages. Binary messages from the agent are frame packets (remotedesktop.Packet); text
// messages are JSON objects with a "t" field:
//
//	server → agent: viewers{count} ack{seq} full settings{display,quality,scale,adaptive}
//	                input{ev} clipboard_get{req} clipboard_set{req,text} displays end{reason}
//	                rtc_offer{req,sdp,ice_servers,control} rtc_ice{req,candidate}
//	                rtc_perms{req,control} rtc_close{req}
//	agent → server: hello stats displays clipboard{req,text} clipboard_error{req,error}
//	                clipboard_set_ok{req} input_error{error} error{where,error}
//	                rtc_answer{req,sdp} rtc_ice{req,candidate} rtc_state{req,state,code,reason,encoder}
//	                rtc_input{req,kind,…} rtc_stats
type inMsg struct {
	T        string                    `json:"t"`
	Count    int                       `json:"count"`
	Seq      uint64                    `json:"seq"`
	Display  *int                      `json:"display"`
	Quality  int                       `json:"quality"`
	Scale    float64                   `json:"scale"`
	Adaptive *bool                     `json:"adaptive"`
	Codecs   []string                  `json:"codecs"`
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
	// WebRTC signalling (webrtc.go); Req carries the viewer's routing id.
	SDP        string        `json:"sdp"`
	IceServers []string      `json:"ice_servers"`
	Control    *bool         `json:"control"`
	Candidate  *rtcCandidate `json:"candidate"`
}

// CloseSessionEnded is the close code the server uses when the session is over.
const CloseSessionEnded = 4000

// InflightWindow: frames sent and not yet acknowledged on a low-latency LAN link. Higher-latency
// links (WAN / Tailscale relay) scale up via InflightWindowFor so RTT does not cap FPS to 3-4 fps.
const InflightWindow = 2

// InflightWindowFor scales the unacknowledged frame pipeline with link RTT so a 200-300 ms relay
// can still deliver smooth frame rates without letting queues grow unbounded.
func InflightWindowFor(rtt time.Duration, video bool) int {
	if video {
		if rtt >= 150*time.Millisecond {
			return 8
		}
		return 6
	}
	switch {
	case rtt >= 150*time.Millisecond:
		return 6
	case rtt >= 60*time.Millisecond:
		return 4
	default:
		return InflightWindow
	}
}

// WSVideoBitrate returns the bitrate ceiling for H.264-over-WebSocket matching the chosen quality.
func WSVideoBitrate(quality int) int {
	if quality < 25 {
		quality = 25
	}
	return min(MaxVideoBitrate, 800_000+(quality-25)*60_000)
}

// AckTimeout: a frame not acknowledged within this is counted as a stall (quality goes down).
const AckTimeout = 2 * time.Second

type stream struct {
	l    *live
	conn *wsclient.Conn

	mu            sync.Mutex
	viewers       int
	display       int
	needFull      bool
	ctrl          *Controller
	inflight      map[uint64]sent
	lastAck       time.Time
	wake          chan struct{}
	over          bool
	sentBytes     int
	sentCount     int
	lastStats     time.Time
	lastFrame     remotedesktop.FrameHeader
	cursor        bool
	depth         int
	wantH264      bool
	wsVideoFailed bool
	wsVideoOn     bool
	wsVideoSeq    uint64
	wsBitrate     int
	wsLastAdapt   time.Time
	wsVideoFails  int
	chosenScale   float64
	chosenQuality int
	wmu           sync.Mutex
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
	return &stream{
		l: l, conn: conn, display: l.req.Display,
		ctrl:          NewController(q, s, true, time.Now()),
		inflight:      map[uint64]sent{},
		wake:          make(chan struct{}, 1),
		needFull:      true,
		cursor:        true,
		depth:         remotedesktop.Depth24,
		wsBitrate:     min(1_800_000, WSVideoBitrate(q)),
		chosenScale:   s,
		chosenQuality: q,
	}
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
	rtcCap := s.l.m.rtcCapability()
	hello := map[string]any{"t": "hello", "session_id": s.l.req.SessionID, "displays": displays, "desktop": d.Info(),
		"encoder": "jpeg", "webp": false, "tile": remotedesktop.TileSize, "control": s.l.req.Control, "max_fps": cfg.MaxFPS,
		"features": Features(), "cursor_supported": remotedesktop.CursorSupported, "end_hotkey": "Ctrl+Alt+Shift+E",
		"webrtc": rtcCap}
	if rtcCap.Supported {
		// Hardware H.264 over the existing WebSocket when WebRTC UDP cannot form (e.g. Tailscale
		// DERP / strict NAT), decoded by the console's WebCodecs H264Player instead of JPEG tiles.
		hello["video"] = []string{"h264"}
	}
	s.send(hello)
	s.send(s.l.stateMsg())
	s.l.setStream(s)
	defer s.l.setStream(nil)
	defer s.stopWSVideo(d)

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

	vid, hasVid := d.(desktop.Video)
	pinger := time.NewTicker(15 * time.Second)
	defer pinger.Stop()
	minGap := time.Second / time.Duration(cfg.MaxFPS)
	idleGap := minGap
	for cctx.Err() == nil {
		now := time.Now()
		rtcBusy := false
		if rm := s.l.existingRTC(); rm != nil && rm.connected() > 0 {
			rtcBusy = true
		}
		s.mu.Lock()
		viewers := s.viewers
		full := s.needFull
		s.needFull = false
		display := s.display
		cursor, depth := s.cursor, s.depth
		step := s.ctrl.Current()
		rtt := s.ctrl.RTT()
		s.expireInflight(now)
		useH264 := hasVid && s.wantH264 && !s.wsVideoFailed && !rtcBusy && s.l.m.rtcCapability().Supported
		if useH264 {
			s.adaptWSVideo(now)
		}
		wsBitrate := s.wsBitrate
		chosenScale := s.chosenScale
		wsVideoOn := s.wsVideoOn
		blocked := len(s.inflight) >= InflightWindowFor(rtt, useH264)
		s.mu.Unlock()

		select {
		case <-pinger.C:
			s.wmu.Lock()
			_ = s.conn.Ping([]byte("k"))
			s.wmu.Unlock()
		default:
		}

		if viewers == 0 || blocked {
			if full {
				s.mu.Lock()
				s.needFull = true
				s.mu.Unlock()
			}
			if viewers == 0 {
				s.stopWSVideo(d)
			}
			s.waitWake(cctx, 250*time.Millisecond)
			continue
		}
		if useH264 {
			started := time.Now()
			fps := VideoFPSFor(30, wsBitrate, int(rtt.Milliseconds()))
			h264Gap := time.Second / time.Duration(fps)
			vf, err := vid.GrabVideo(s.l.req.SessionID, remotedesktop.VideoRequest{
				Display: display,
				Scale:   VideoScale(chosenScale, wsBitrate),
				FPS:     fps,
				Bitrate: wsBitrate,
				Key:     full || !wsVideoOn,
				Cursor:  cursor && remotedesktop.CursorSupported,
			})
			if err != nil {
				s.mu.Lock()
				s.wsVideoFails++
				if s.wsVideoFails >= maxGrabFailures {
					s.wsVideoFailed = true
					s.needFull = true
				}
				s.mu.Unlock()
				s.stopWSVideo(d)
				s.waitWake(cctx, 200*time.Millisecond)
				continue
			}
			s.mu.Lock()
			s.wsVideoFails = 0
			s.wsVideoOn = true
			s.mu.Unlock()
			if vf == nil {
				idleGap = min(idleGap*2, 120*time.Millisecond)
				s.maybeStats(time.Now())
				s.waitWake(cctx, idleGap)
				continue
			}
			idleGap = h264Gap
			writeFailed := false
			for _, u := range vf.Units {
				s.mu.Lock()
				s.wsVideoSeq++
				seq := s.wsVideoSeq
				hdr := remotedesktop.FrameHeader{
					T: "frame", Seq: seq, Full: u.Key, Display: vf.Header.Display,
					W: vf.Header.W, H: vf.Header.H, SW: vf.Header.SW, SH: vf.Header.SH,
					Q: s.chosenQuality, S: float64(vf.Header.W) / float64(max(1, vf.Header.SW)),
					Fmt: "h264", Tiles: []remotedesktop.Tile{{X: 0, Y: 0, W: vf.Header.W, H: vf.Header.H, N: len(u.Data)}},
					CapMs: vf.Header.CapMs, EncMs: vf.Header.EncMs, ChangedPct: 100, Mode: "h264",
				}
				if u.Key && len(vf.Header.Displays) > 0 {
					hdr.Displays = vf.Header.Displays
				}
				pkt := (&remotedesktop.EncodedFrame{Header: hdr, Data: u.Data}).Packet()
				s.inflight[seq] = sent{at: time.Now(), bytes: len(pkt)}
				s.ctrl.FrameSent(len(pkt))
				s.sentBytes += len(pkt)
				s.sentCount++
				s.lastFrame = hdr
				s.mu.Unlock()
				s.wmu.Lock()
				_ = s.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
				err = s.conn.WriteBinary(pkt)
				s.wmu.Unlock()
				if err != nil {
					writeFailed = true
					break
				}
			}
			if writeFailed {
				break
			}
			s.maybeStats(time.Now())
			if wait := h264Gap - time.Since(started); wait > 0 {
				t := time.NewTimer(wait)
				select {
				case <-cctx.Done():
				case <-t.C:
				}
				t.Stop()
			}
			continue
		}
		s.stopWSVideo(d)
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

// stopWSVideo releases the video encoder used by the WebSocket stream (only when WebRTC is not using it).
func (s *stream) stopWSVideo(d desktop.Desktop) {
	s.mu.Lock()
	wasOn := s.wsVideoOn
	s.wsVideoOn = false
	s.mu.Unlock()
	if !wasOn {
		return
	}
	if rm := s.l.existingRTC(); rm != nil && rm.connected() > 0 {
		return
	}
	if vid, ok := d.(desktop.Video); ok {
		vid.EndVideo(s.l.req.SessionID)
	}
}

// adaptWSVideo adjusts the H.264-over-WebSocket bitrate from measured ack RTT (caller holds mu).
func (s *stream) adaptWSVideo(now time.Time) {
	if now.Sub(s.wsLastAdapt) < 1500*time.Millisecond {
		return
	}
	s.wsLastAdapt = now
	target := WSVideoBitrate(s.chosenQuality)
	if !s.ctrl.adaptive {
		s.wsBitrate = target
		return
	}
	rttMs := int(s.ctrl.RTT().Milliseconds())
	capRate := min(target, MaxBitrateForRTT(rttMs))
	cur := s.wsBitrate
	if cur <= 0 {
		cur = min(1_800_000, capRate)
	}
	switch {
	case rttMs > 220:
		cur = cur * 3 / 4
	case rttMs > 0 && rttMs < 130:
		cur = cur*105/100 + 50_000
	}
	s.wsBitrate = min(capRate, max(MinVideoBitrate, cur))
}

// expireInflight drops frames never acknowledged (caller holds mu).
func (s *stream) expireInflight(now time.Time) {
	for seq, f := range s.inflight {
		if now.Sub(f.at) > AckTimeout {
			delete(s.inflight, seq)
			s.ctrl.Timeout(now)
			if s.wsVideoOn && s.ctrl.adaptive {
				s.wsBitrate = max(MinVideoBitrate, s.wsBitrate*3/4)
			}
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
	if s.wsVideoOn {
		st["encoder"] = "h264"
		st["bitrate_kbps"] = s.wsBitrate / 1000
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
			s.chosenQuality = m.Quality
			s.chosenScale = m.Scale
			s.wsBitrate = min(s.wsBitrate, WSVideoBitrate(m.Quality))
		} else if m.Adaptive != nil {
			cur := s.ctrl.Current()
			s.ctrl.SetCeiling(cur.Quality, cur.Scale, adaptive)
		}
		if m.Codecs != nil {
			s.wantH264 = slices.Contains(m.Codecs, "h264")
		} else if m.Quality > 0 && m.Scale > 0 {
			// A full settings update without codecs (e.g. recording enabled) switches back to JPEG;
			// partial cursor/depth settings messages keep the current codec choice.
			s.wantH264 = false
		}
		s.needFull = true
		s.mu.Unlock()
		s.l.rtc().settings(m.Display, m.Scale, m.Cursor)
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
	case "rtc_offer":
		s.l.rtc().newOffer(m.Req)
		go s.l.rtc().offer(m)
	case "rtc_ice":
		s.l.rtc().ice(m)
	case "rtc_perms":
		s.l.rtc().perms(m.Req, m.Control != nil && *m.Control)
	case "rtc_close":
		s.l.rtc().closePeer(m.Req, "")
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
