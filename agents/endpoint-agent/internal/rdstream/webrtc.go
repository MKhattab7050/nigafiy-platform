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
	// Start at 2.5 Mbit/s: sharp on LAN and climbs to MaxVideoBitrate within seconds when RTT and
	// loss are low, without flooding WAN / Tailscale DERP / mobile uplinks on the first second.
	MinVideoBitrate   = 300_000
	MaxVideoBitrate   = 12_000_000
	StartVideoBitrate = 2_500_000
	// DefaultVideoFPS caps the video frame rate on a fast LAN link. Higher-latency links (WAN /
	// Tailscale relay) step down via VideoFPSFor so each frame gets more bits and queues stay empty.
	DefaultVideoFPS = 60
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
	req      string
	pc       *webrtc.PeerConnection
	control  atomic.Bool
	loss     atomic.Uint32 // last RTCP fraction lost (0..255)
	jitterMs atomic.Uint32 // last RTCP interarrival jitter in ms (90 kHz clock / 90)
	pli      atomic.Uint32 // PLI/FIR requests since the last adapt window
	up       atomic.Bool   // ICE + DTLS connected
}

type rtcManager struct {
	l *live

	mu    sync.Mutex
	peers map[string]*rtcPeer
	// pending: the browser's trickled candidates that arrive before its offer was answered (the
	// offer is answered on its own goroutine); applied once the peer exists.
	pending  map[string][]webrtc.ICECandidateInit
	track    *webrtc.TrackLocalStaticSample
	cancel   context.CancelFunc
	done     chan struct{}
	bitrate  int
	rttMs    int
	videoFPS int
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
	return &rtcManager{l: l, peers: map[string]*rtcPeer{}, pending: map[string][]webrtc.ICECandidateInit{}, bitrate: StartVideoBitrate, display: l.req.Display, scale: s, cursor: true}
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
	if old := r.peers[req]; old != nil {
		delete(r.peers, req)
		go old.pc.Close() //nolint:errcheck // replaced by the newer concurrent offer
	}
	if len(r.peers) >= MaxRTCPeers {
		r.mu.Unlock()
		_ = pc.Close()
		r.fail(req, "too_many_peers", "too many WebRTC viewers in this session")
		return
	}
	r.peers[req] = p
	early := r.pending[req]
	delete(r.pending, req)
	r.mu.Unlock()
	r.send(map[string]any{"t": "rtc_answer", "req": req, "sdp": pc.LocalDescription().SDP})
	for _, c := range early {
		_ = pc.AddICECandidate(c)
	}
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
				p.pli.Add(1)
				r.wantKey.Store(true)
			case *rtcp.ReceiverReport:
				for _, rep := range t.Reports {
					p.loss.Store(uint32(rep.FractionLost))
					p.jitterMs.Store(rep.Jitter / 90)
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

// maxPendingICE bounds the candidates kept for an offer that is still being answered.
const maxPendingICE = 32

// newOffer forgets candidates of an earlier offer from the same viewer (called in socket order,
// before the offer's goroutine starts, so the new offer's own candidates are kept).
func (r *rtcManager) newOffer(req string) {
	r.mu.Lock()
	delete(r.pending, req)
	r.mu.Unlock()
}

func (r *rtcManager) ice(m inMsg) {
	if m.Candidate == nil || len(m.Candidate.Candidate) > 1024 {
		return
	}
	c := webrtc.ICECandidateInit{Candidate: m.Candidate.Candidate, SDPMid: m.Candidate.SDPMid, SDPMLineIndex: m.Candidate.SDPMLineIndex}
	r.mu.Lock()
	p := r.peers[m.Req]
	if p == nil {
		if !r.closed && len(r.pending[m.Req]) < maxPendingICE && (len(r.pending) < MaxRTCPeers || r.pending[m.Req] != nil) {
			r.pending[m.Req] = append(r.pending[m.Req], c)
		}
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	_ = p.pc.AddICECandidate(c)
}

// closePeer ends one viewer's peer connection; reason non-empty tells the browser.
func (r *rtcManager) closePeer(req, reason string) {
	r.mu.Lock()
	p := r.peers[req]
	delete(r.peers, req)
	delete(r.pending, req)
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
	r.pending = map[string][]webrtc.ICECandidateInit{}
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

func (r *rtcManager) peerIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.peers))
	for k := range r.peers {
		out = append(out, k)
	}
	return out
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

// peerRTTMs returns the active ICE candidate pair's current RTT in milliseconds (0 when unknown).
func peerRTTMs(pc *webrtc.PeerConnection) int {
	if pc == nil {
		return 0
	}
	var best int
	for _, st := range pc.GetStats() {
		pair, ok := st.(webrtc.ICECandidatePairStats)
		if !ok || pair.CurrentRoundTripTime <= 0 {
			continue
		}
		ms := int(pair.CurrentRoundTripTime * 1000)
		if pair.Nominated || pair.State == webrtc.StatsICECandidatePairStateSucceeded {
			return ms
		}
		if best == 0 {
			best = ms
		}
	}
	return best
}

// adapt steps the bitrate and target FPS on the worst viewer's RTCP loss/jitter/PLI and ICE RTT.
// Over relayed TCP tunnels (such as Tailscale DERP), packet loss can stay 0 % while RTT rises to
// 200-400 ms; adapting on RTT as well prevents the encoder from ramping up to 12 Mbit/s into a
// congested relay.
func (r *rtcManager) adapt(now time.Time, maxFPS int) {
	r.mu.Lock()
	if now.Sub(r.lastAdap) < adaptEvery {
		r.mu.Unlock()
		return
	}
	r.lastAdap = now
	peers := make([]*rtcPeer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	r.mu.Unlock()

	var worstLoss, worstJitter, worstPLI uint32
	var worstRTT int
	for _, p := range peers {
		worstLoss = max(worstLoss, p.loss.Load())
		worstJitter = max(worstJitter, p.jitterMs.Load())
		worstPLI = max(worstPLI, p.pli.Swap(0))
		if p.up.Load() {
			if ms := peerRTTMs(p.pc); ms > worstRTT {
				worstRTT = ms
			}
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if worstRTT > 0 {
		if r.rttMs == 0 {
			r.rttMs = worstRTT
		} else {
			r.rttMs = (r.rttMs*7 + worstRTT*3) / 10
		}
	}
	r.bitrate = NextBitrateFor(r.bitrate, float64(worstLoss)/256, r.rttMs, int(worstJitter), worstPLI >= 3)
	r.videoFPS = VideoFPSFor(maxFPS, r.bitrate, r.rttMs)
}

// VideoScale is the video picture's scale. The console's 75 % default is there for JPEG pictures,
// where every pixel costs bandwidth; H.264 at 75 % only blurs text. So video is full size while the
// bitrate allows it, smaller only when packet loss or latency has pushed the bitrate down, and the
// console's 50 % (a deliberate choice for a weak link) is still honoured.
func VideoScale(chosen float64, bitrate int) float64 {
	s := 1.0
	switch {
	case bitrate < 900_000:
		s = 0.5
	case bitrate < 2_000_000:
		s = 0.75
	}
	if chosen > 0 && chosen <= 0.5 {
		s = min(s, chosen)
	}
	return s
}

// MaxBitrateForRTT caps H.264 bitrate on higher-latency WAN / relayed links (e.g. Tailscale DERP
// over mobile CGNAT) while leaving LAN links free up to MaxVideoBitrate.
func MaxBitrateForRTT(rttMs int) int {
	switch {
	case rttMs >= 220:
		return 1_200_000
	case rttMs >= 140:
		return 2_500_000
	case rttMs >= 80:
		return 5_000_000
	default:
		return MaxVideoBitrate
	}
}

// VideoFPSFor picks a frame-rate cap matching the link's latency and bitrate budget so relayed or
// mobile links spend their bits on crisp frames instead of overflowing buffers at 60 fps.
func VideoFPSFor(maxFPS, bitrate, rttMs int) int {
	if maxFPS <= 0 {
		maxFPS = DefaultVideoFPS
	}
	switch {
	case rttMs >= 160 || bitrate < 1_000_000:
		return min(maxFPS, 20)
	case rttMs >= 60 || bitrate < 2_500_000:
		return min(maxFPS, 30)
	default:
		return maxFPS
	}
}

// NextBitrate: more than 10 % loss steps the bitrate down by a fifth, less than 2 % lets it climb
// by a tenth, within MinVideoBitrate..MaxVideoBitrate.
func NextBitrate(cur int, loss float64) int {
	return NextBitrateFor(cur, loss, 0, 0, false)
}

// NextBitrateFor adapts video bitrate from RTCP loss, ICE RTT, jitter and PLI bursts.
func NextBitrateFor(cur int, loss float64, rttMs, jitterMs int, pliBurst bool) int {
	capRate := MaxBitrateForRTT(rttMs)
	switch {
	case loss > 0.15 || rttMs >= 260:
		cur = cur * 7 / 10
	case loss > 0.10 || (loss > 0.05 && rttMs >= 80) || rttMs >= 180 || jitterMs >= 50 || pliBurst:
		cur = cur * 4 / 5
	case loss < 0.02 && rttMs < 120 && jitterMs < 25 && !pliBurst:
		cur = cur * 11 / 10
	}
	return min(capRate, max(MinVideoBitrate, cur))
}

func (r *rtcManager) pump(ctx context.Context, done chan struct{}) {
	defer close(done)
	v, ok := r.video()
	if !ok {
		return
	}
	maxFPS := r.l.m.cfg.VideoFPS
	if maxFPS <= 0 {
		maxFPS = DefaultVideoFPS
	}
	r.mu.Lock()
	if r.videoFPS <= 0 {
		r.videoFPS = min(maxFPS, 30)
	}
	r.mu.Unlock()
	last := time.Now()
	failures := 0
	for ctx.Err() == nil {
		started := time.Now()
		if r.connected() == 0 {
			sleepCtx(ctx, 100*time.Millisecond)
			last = time.Now()
			continue
		}
		r.adapt(started, maxFPS)
		r.mu.Lock()
		fps := r.videoFPS
		if fps <= 0 {
			fps = min(maxFPS, 30)
		}
		req := remotedesktop.VideoRequest{Display: r.display, Scale: VideoScale(r.scale, r.bitrate), FPS: fps, Bitrate: r.bitrate, Cursor: r.cursor && remotedesktop.CursorSupported}
		track := r.track
		r.mu.Unlock()
		gap := time.Second / time.Duration(fps)
		req.Key = r.wantKey.Swap(false)
		frame, err := v.GrabVideo(r.l.req.SessionID, req)
		if err != nil {
			failures++
			if failures >= maxGrabFailures {
				// The encoder (or capture) is broken: every WebRTC viewer goes back to JPEG.
				for _, k := range r.peerIDs() {
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
				// The hardware encoder failed and the software one took over: every viewer is told.
				for _, k := range r.peerIDs() {
					r.send(map[string]any{"t": "rtc_state", "req": k, "state": "encoder_changed", "encoder": frame.Header.Encoder, "reason": frame.Header.Fallback})
				}
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
		"bitrate_kbps": r.bitrate / 1000, "rtt_ms": r.rttMs, "encoder": r.encoder, "enc_ms": r.stats.encMs, "width": r.stats.w, "height": r.stats.h,
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
