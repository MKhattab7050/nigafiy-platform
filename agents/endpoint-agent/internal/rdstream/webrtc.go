package rdstream

// WebRTC video (Fleet Pro, 2026-11-25). The operator's browser offers one receive-only H.264
// video transceiver and one data channel "input"; the agent answers with one send-only H.264
// track. Signalling travels on the existing stream socket (rtc_offer / rtc_answer / rtc_ice /
// rtc_state / rtc_close), each message tagged with the viewer's routing id (req), which the API
// set and checked. The picture is the same capture as the JPEG stream; one encoder per session
// feeds every WebRTC viewer of that session.
//
// LAN only: no TURN, no STUN unless the API passes administrator-configured stun: URLs. Input on
// the data channel passes the same checks as the socket path (profile control, the session's
// control, the viewer's own permissions from the API, remotedesktop.ValidateInput) and every
// event except pointer moves is reported on the socket (rtc_input) for the API's audit. Closing
// the session closes every peer connection.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/videoenc"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	// MaxRTCPeers: WebRTC viewers of one session (each is a colleague's browser).
	MaxRTCPeers = 4
	// Bitrate range and start (bits per second).
	MinVideoBitrate   = 300_000
	MaxVideoBitrate   = 8_000_000
	StartVideoBitrate = 4_000_000
	// DefaultVideoFPS caps the video frame rate.
	DefaultVideoFPS = 30
	maxSDPBytes     = 64 << 10
	adaptEvery      = 2 * time.Second
	// The pump gives up after this many failed grabs in a row (the encoder or capture is broken).
	maxGrabFailures = 3
)

// h264Fmtp: packetization mode 1 (what browsers send and receive), constrained baseline.
const h264Fmtp = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"

type rtcCandidate struct {
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

type rtcPeer struct {
	req     string
	pc      *webrtc.PeerConnection
	control atomic.Bool
	loss    atomic.Uint32 // last RTCP fraction lost (0..255)
	up      atomic.Bool   // ICE + DTLS connected
}

type rtcManager struct {
	l *live

	mu       sync.Mutex
	peers    map[string]*rtcPeer
	track    *webrtc.TrackLocalStaticSample
	cancel   context.CancelFunc
	done     chan struct{}
	bitrate  int
	encoder  string
	closed   bool
	wantKey  atomic.Bool
	display  int
	scale    float64
	cursor   bool
	stats    rtcCounters
	lastAdap time.Time
	// out replaces the stream socket (tests).
	out func(map[string]any)
}

type rtcCounters struct {
	frames, bytes int
	since         time.Time
	encMs         int64
	w, h          int
}

func newRTCManager(l *live) *rtcManager {
	s := l.req.Scale
	if s <= 0 || s > 1 {
		s = 1
	}
	return &rtcManager{l: l, peers: map[string]*rtcPeer{}, bitrate: StartVideoBitrate, display: l.req.Display, scale: s, cursor: true}
}

// rtc returns the session's manager (created on first use).
func (l *live) rtc() *rtcManager {
	l.tools.mu.Lock()
	defer l.tools.mu.Unlock()
	if l.rtcm == nil {
		l.rtcm = newRTCManager(l)
	}
	return l.rtcm
}

// existingRTC returns the manager when one was created.
func (l *live) existingRTC() *rtcManager {
	l.tools.mu.Lock()
	defer l.tools.mu.Unlock()
	return l.rtcm
}

func (r *rtcManager) send(v map[string]any) {
	if r.out != nil {
		r.out(v)
		return
	}
	if s := r.l.currentStream(); s != nil {
		s.send(v)
	}
}

func (r *rtcManager) video() (desktop.Video, bool) {
	v, ok := r.l.m.cfg.Desktop.(desktop.Video)
	return v, ok
}

// Capability is what the hello says about WebRTC on this agent.
func (m *Manager) rtcCapability() videoenc.Capability {
	if m.cfg.DisableWebRTC {
		return videoenc.Capability{Reason: "WebRTC is switched off on this agent"}
	}
	v, ok := m.cfg.Desktop.(desktop.Video)
	if !ok {
		return videoenc.Capability{Reason: "this desktop has no video source"}
	}
	return v.VideoCapability()
}

// settings follows the stream's display, scale and pointer choices.
func (r *rtcManager) settings(display *int, scale float64, cursor *bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if display != nil && *display != r.display {
		r.display = *display
		r.wantKey.Store(true)
	}
	if scale > 0 && scale <= 1 {
		r.scale = scale
	}
	if cursor != nil {
		r.cursor = *cursor
	}
}

func validStun(urls []string) ([]webrtc.ICEServer, error) {
	if len(urls) > 4 {
		return nil, errors.New("at most 4 STUN servers")
	}
	var out []webrtc.ICEServer
	for _, u := range urls {
		if len(u) > 200 || !(strings.HasPrefix(u, "stun:") || strings.HasPrefix(u, "stuns:")) {
			return nil, errors.New("only stun: and stuns: servers are allowed (no relay)")
		}
		out = append(out, webrtc.ICEServer{URLs: []string{u}})
	}
	return out, nil
}

func (r *rtcManager) fail(req, code, reason string) {
	r.send(map[string]any{"t": "rtc_state", "req": req, "state": "failed", "code": code, "reason": reason})
}

// offer answers one browser's offer.
func (r *rtcManager) offer(m inMsg) {
	req := m.Req
	vc := r.l.m.rtcCapability()
	switch {
	case !vc.Supported:
		r.fail(req, "webrtc_unavailable", vc.Reason)
		return
	case !r.l.perms.View:
		r.fail(req, "profile_forbids_view", "the session profile does not allow viewing")
		return
	case len(m.SDP) == 0 || len(m.SDP) > maxSDPBytes:
		r.fail(req, "bad_offer", "the offer is empty or too large")
		return
	}
	ice, err := validStun(m.IceServers)
	if err != nil {
		r.fail(req, "bad_offer", err.Error())
		return
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	if old := r.peers[req]; old != nil {
		delete(r.peers, req)
		go old.pc.Close() //nolint:errcheck // replaced by the new offer
	}
	if len(r.peers) >= MaxRTCPeers {
		r.mu.Unlock()
		r.fail(req, "too_many_peers", "too many WebRTC viewers in this session")
		return
	}
	if r.track == nil {
		t, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264Fmtp}, "video", "nigafiy-screen")
		if err != nil {
			r.mu.Unlock()
			r.fail(req, "webrtc_error", err.Error())
			return
		}
		r.track = t
	}
	track := r.track
	r.mu.Unlock()

	pc, err := r.newPeerConnection(ice)
	if err != nil {
		r.fail(req, "webrtc_error", err.Error())
		return
	}
	p := &rtcPeer{req: req, pc: pc}
	p.control.Store(m.Control != nil && *m.Control)
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
		_ = pc.Close()
		r.fail(req, "bad_offer", err.Error())
		return
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		r.fail(req, "webrtc_error", err.Error())
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err == nil {
		err = pc.SetLocalDescription(answer)
	}
	if err != nil {
		_ = pc.Close()
		r.fail(req, "webrtc_error", err.Error())
		return
	}
	if len(sender.GetParameters().Codecs) == 0 {
		_ = pc.Close()
		r.fail(req, "browser_no_h264", "the browser did not offer H.264")
		return
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			r.send(map[string]any{"t": "rtc_ice", "req": req, "candidate": nil})
			return
		}
		init := c.ToJSON()
		r.send(map[string]any{"t": "rtc_ice", "req": req, "candidate": rtcCandidate{Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex}})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) { r.onState(p, st) })
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "input" {
			_ = dc.Close()
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) { r.input(p, dc, msg.Data) })
	})
	go r.readRTCP(p, sender)

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		_ = pc.Close()
		return
	}
	r.peers[req] = p
	r.mu.Unlock()
	r.send(map[string]any{"t": "rtc_answer", "req": req, "sdp": pc.LocalDescription().SDP})
}

func (r *rtcManager) newPeerConnection(ice []webrtc.ICEServer) (*webrtc.PeerConnection, error) {
	me := &webrtc.MediaEngine{}
	fb := []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264Fmtp, RTCPFeedback: fb},
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	if f := r.l.m.cfg.RTCSettings; f != nil {
		f(&se)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se))
	return api.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
}

func (r *rtcManager) onState(p *rtcPeer, st webrtc.PeerConnectionState) {
	switch st {
	case webrtc.PeerConnectionStateConnected:
		p.up.Store(true)
		r.wantKey.Store(true)
		r.ensurePump()
		r.mu.Lock()
		enc := r.encoder
		r.mu.Unlock()
		r.send(map[string]any{"t": "rtc_state", "req": p.req, "state": "connected", "encoder": enc})
	case webrtc.PeerConnectionStateFailed:
		r.send(map[string]any{"t": "rtc_state", "req": p.req, "state": "failed", "code": "ice_failed", "reason": "no direct network path to the viewer"})
		go r.closePeer(p.req, "") // not inside pion's callback
	case webrtc.PeerConnectionStateClosed:
		p.up.Store(false)
	}
}

func (r *rtcManager) readRTCP(p *rtcPeer, sender *webrtc.RTPSender) {
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, pkt := range pkts {
			switch t := pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				r.wantKey.Store(true)
			case *rtcp.ReceiverReport:
				for _, rep := range t.Reports {
					p.loss.Store(uint32(rep.FractionLost))
				}
			}
		}
	}
}

// input applies one data-channel input event with the same checks as the socket path.
func (r *rtcManager) input(p *rtcPeer, dc *webrtc.DataChannel, data []byte) {
	l := r.l
	var ev remotedesktop.InputEvent
	if len(data) > 4096 || json.Unmarshal(data, &ev) != nil {
		return
	}
	reply := func(code, msg string) {
		b, _ := json.Marshal(map[string]any{"t": "input_error", "code": code, "error": msg})
		_ = dc.SendText(string(b))
	}
	if !l.req.Control || !l.perms.Control || !p.control.Load() {
		reply("profile_forbids_control", "this session is view only")
		if ev.Kind != "mouse_move" {
			r.send(map[string]any{"t": "rtc_input", "req": p.req, "kind": ev.Kind, "refused": "profile_forbids_control"})
		}
		return
	}
	if err := remotedesktop.ValidateInput(ev); err != nil {
		reply("bad_input", err.Error())
		return
	}
	if err := l.m.cfg.Desktop.Input(ev); err != nil {
		reply("", err.Error())
		return
	}
	if ev.Kind != "mouse_move" {
		// For the API's audit: what happened, never which key or what text.
		r.send(map[string]any{"t": "rtc_input", "req": p.req, "kind": ev.Kind, "button": ev.Button, "display_index": ev.DisplayIndex, "double": ev.Double})
	}
	if s := l.currentStream(); s != nil {
		s.signal()
	}
}

// perms changes what one viewer may do (the API sends it when participants change).
func (r *rtcManager) perms(req string, control bool) {
	r.mu.Lock()
	p := r.peers[req]
	r.mu.Unlock()
	if p != nil {
		p.control.Store(control)
	}
}

func (r *rtcManager) ice(m inMsg) {
	r.mu.Lock()
	p := r.peers[m.Req]
	r.mu.Unlock()
	if p == nil || m.Candidate == nil || len(m.Candidate.Candidate) > 1024 {
		return
	}
	_ = p.pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: m.Candidate.Candidate, SDPMid: m.Candidate.SDPMid, SDPMLineIndex: m.Candidate.SDPMLineIndex})
}

// closePeer ends one viewer's peer connection; reason non-empty tells the browser.
func (r *rtcManager) closePeer(req, reason string) {
	r.mu.Lock()
	p := r.peers[req]
	delete(r.peers, req)
	last := len(r.peers) == 0
	r.mu.Unlock()
	if p == nil {
		return
	}
	_ = p.pc.Close()
	if reason != "" {
		r.send(map[string]any{"t": "rtc_state", "req": req, "state": "closed", "code": reason})
	}
	if last {
		r.stopPump()
	}
}

// closeAll ends every peer (the session is over, or the encoder failed).
func (r *rtcManager) closeAll(final bool) {
	r.mu.Lock()
	peers := r.peers
	r.peers = map[string]*rtcPeer{}
	if final {
		r.closed = true
	}
	r.mu.Unlock()
	for _, p := range peers {
		_ = p.pc.Close()
	}
	r.stopPump()
}

func (r *rtcManager) ensurePump() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil || r.closed {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.done = make(chan struct{})
	go r.pump(ctx, r.done)
}

func (r *rtcManager) stopPump() {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.cancel, r.done = nil, nil
	r.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	if v, ok := r.video(); ok {
		v.EndVideo(r.l.req.SessionID)
	}
}

func (r *rtcManager) connected() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, p := range r.peers {
		if p.up.Load() {
			n++
		}
	}
	return n
}

// adapt steps the bitrate on the worst viewer's loss (RTCP receiver reports).
func (r *rtcManager) adapt(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.lastAdap) < adaptEvery {
		return
	}
	r.lastAdap = now
	var worst uint32
	for _, p := range r.peers {
		worst = max(worst, p.loss.Load())
	}
	r.bitrate = NextBitrate(r.bitrate, float64(worst)/256)
}

// NextBitrate: more than 10 % loss steps the bitrate down by a fifth, less than 2 % lets it climb
// by a tenth, within MinVideoBitrate..MaxVideoBitrate.
func NextBitrate(cur int, loss float64) int {
	switch {
	case loss > 0.10:
		cur = cur * 4 / 5
	case loss < 0.02:
		cur = cur * 11 / 10
	}
	return min(MaxVideoBitrate, max(MinVideoBitrate, cur))
}

func (r *rtcManager) pump(ctx context.Context, done chan struct{}) {
	defer close(done)
	v, ok := r.video()
	if !ok {
		return
	}
	fps := r.l.m.cfg.VideoFPS
	if fps <= 0 {
		fps = DefaultVideoFPS
	}
	gap := time.Second / time.Duration(fps)
	last := time.Now()
	failures := 0
	for ctx.Err() == nil {
		started := time.Now()
		if r.connected() == 0 {
			sleepCtx(ctx, 100*time.Millisecond)
			last = time.Now()
			continue
		}
		r.adapt(started)
		r.mu.Lock()
		req := remotedesktop.VideoRequest{Display: r.display, Scale: r.scale, FPS: fps, Bitrate: r.bitrate, Cursor: r.cursor && remotedesktop.CursorSupported}
		track := r.track
		r.mu.Unlock()
		req.Key = r.wantKey.Swap(false)
		frame, err := v.GrabVideo(r.l.req.SessionID, req)
		if err != nil {
			failures++
			if failures >= maxGrabFailures {
				// The encoder (or capture) is broken: every WebRTC viewer goes back to JPEG.
				r.mu.Lock()
				reqs := make([]string, 0, len(r.peers))
				for k := range r.peers {
					reqs = append(reqs, k)
				}
				r.mu.Unlock()
				for _, k := range reqs {
					r.fail(k, "encoder_failed", err.Error())
				}
				go r.closeAll(false)
				return
			}
			sleepCtx(ctx, 200*time.Millisecond)
			continue
		}
		failures = 0
		if frame != nil {
			now := time.Now()
			for _, u := range frame.Units {
				_ = track.WriteSample(media.Sample{Data: u.Data, Duration: now.Sub(last)})
				last = now
			}
			r.mu.Lock()
			if frame.Header.Encoder != r.encoder {
				r.encoder = frame.Header.Encoder
			}
			r.stats.frames += len(frame.Units)
			for _, u := range frame.Units {
				r.stats.bytes += len(u.Data)
			}
			r.stats.encMs, r.stats.w, r.stats.h = frame.Header.EncMs, frame.Header.W, frame.Header.H
			r.mu.Unlock()
			if frame.Header.Fallback != "" {
				r.send(map[string]any{"t": "rtc_state", "state": "encoder_changed", "encoder": frame.Header.Encoder, "reason": frame.Header.Fallback})
			}
		}
		r.maybeStats(time.Now())
		if wait := gap - time.Since(started); wait > 0 {
			sleepCtx(ctx, wait)
		}
	}
}

func (r *rtcManager) maybeStats(now time.Time) {
	r.mu.Lock()
	if r.stats.since.IsZero() {
		r.stats.since = now
		r.mu.Unlock()
		return
	}
	el := now.Sub(r.stats.since).Seconds()
	if el < 1 {
		r.mu.Unlock()
		return
	}
	var worst uint32
	for _, p := range r.peers {
		worst = max(worst, p.loss.Load())
	}
	m := map[string]any{"t": "rtc_stats", "fps": float64(int(float64(r.stats.frames)/el*10)) / 10, "kbps": int(float64(r.stats.bytes) * 8 / 1000 / el),
		"bitrate_kbps": r.bitrate / 1000, "encoder": r.encoder, "enc_ms": r.stats.encMs, "width": r.stats.w, "height": r.stats.h,
		"loss_pct": float64(int(float64(worst)/256*1000)) / 10, "peers": len(r.peers)}
	r.stats = rtcCounters{since: now}
	r.mu.Unlock()
	r.send(m)
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
