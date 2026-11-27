package rdstream

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/videoenc"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

// fakeH264 stands in for Media Foundation: it returns Annex B access units with the NAL types a
// real encoder produces (SPS, PPS, IDR for a key frame; a non-IDR slice otherwise).
type fakeH264 struct {
	cfg      videoenc.Config
	failNext *atomic.Int32 // > 0: that many Encode calls fail
	frames   *atomic.Int32
	name     string
}

var (
	sps = []byte{0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0x8c, 0x8d, 0x40}
	pps = []byte{0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80}
)

func (f *fakeH264) Encode(nv12 []byte, frame int64, key bool) ([]videoenc.Unit, error) {
	if f.failNext != nil && f.failNext.Load() > 0 {
		f.failNext.Add(-1)
		return nil, errors.New("fake encoder failure")
	}
	if len(nv12) != f.cfg.Width*f.cfg.Height*3/2 {
		return nil, errors.New("wrong picture size")
	}
	if f.frames != nil {
		f.frames.Add(1)
	}
	if key || frame == 0 {
		au := append(append(append([]byte{}, sps...), pps...), 0, 0, 0, 1, 0x65, 0x88, 0x84, byte(frame), 0x21)
		return []videoenc.Unit{{Data: au, Key: true}}, nil
	}
	return []videoenc.Unit{{Data: []byte{0, 0, 0, 1, 0x41, 0x9a, byte(frame), 0x02}}}, nil
}
func (f *fakeH264) SetBitrate(bps int) error { f.cfg.Bitrate = bps; return nil }
func (f *fakeH264) Name() string             { return f.name }
func (f *fakeH264) Close()                   {}

func fakeOpener(fail *atomic.Int32, frames *atomic.Int32) videoenc.Opener {
	return func(cfg videoenc.Config) (videoenc.Encoder, error) {
		return &fakeH264{cfg: cfg, failNext: fail, frames: frames, name: "fake H.264"}, nil
	}
}

// loopbackOnly keeps both peers on 127.0.0.1 (no LAN address is used by the test).
func loopbackOnly(se *webrtc.SettingEngine) {
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
}

type rtcHarness struct {
	t   *testing.T
	f   *fakeDesktop
	m   *Manager
	l   *live
	r   *rtcManager
	out chan map[string]any
}

func newRTCHarness(t *testing.T, cfg Config, perms userui.Permissions, control bool) *rtcHarness {
	t.Helper()
	f := newFakeDesktop(&fakeUI{answer: userui.Accepted})
	if cfg.Desktop == nil {
		cfg.Desktop = f
	}
	cfg.ServerURL, cfg.Credential = "http://127.0.0.1:1", func() string { return "x" }
	if cfg.RTCSettings == nil {
		cfg.RTCSettings = loopbackOnly
	}
	m := NewManager(cfg)
	l := &live{m: m, req: OpenRequest{SessionID: "rtc-1", Control: control, Stream: true}, perms: perms, done: make(chan struct{})}
	h := &rtcHarness{t: t, f: f, m: m, l: l, out: make(chan map[string]any, 256)}
	h.r = l.rtc()
	h.r.out = func(v map[string]any) {
		// Round-trip through JSON as the socket would.
		b, _ := json.Marshal(v)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		h.out <- m
	}
	t.Cleanup(func() { h.r.closeAll(true) })
	return h
}

// next waits for the next message of type typ (others are skipped, except those collected).
func (h *rtcHarness) next(typ string, skip func(map[string]any)) map[string]any {
	h.t.Helper()
	deadline := time.After(hangGuard)
	for {
		select {
		case m := <-h.out:
			if m["t"] == typ {
				return m
			}
			if skip != nil {
				skip(m)
			}
		case <-deadline:
			h.t.Fatalf("no %s message", typ)
			return nil
		}
	}
}

func browserPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	se := webrtc.SettingEngine{}
	loopbackOnly(&se)
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

func ptr[T any](v T) *T { return &v }

func containsByte(b []byte, v byte) bool {
	for _, x := range b {
		if x == v {
			return true
		}
	}
	return false
}

// TestRTCLoopbackVideoAndInput: a pion "browser" and the agent's answerer on 127.0.0.1. The
// browser receives H.264 RTP whose first access unit is a key frame with its parameter sets, and
// its data-channel input reaches the desktop only while the viewer may control, with the same
// validation as the socket path; the API hears of each input without keys or text.
func TestRTCLoopbackVideoAndInput(t *testing.T) {
	h := newRTCHarness(t, Config{VideoFPS: 30}, userui.Permissions{View: true, Control: true}, true)
	h.f.SetVideoOpener(fakeOpener(nil, nil))

	pc := browserPeer(t)
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	dc, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		t.Fatal(err)
	}
	dcOpen := make(chan struct{})
	dc.OnOpen(func() { close(dcOpen) })
	dcMsgs := make(chan map[string]any, 16)
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var m map[string]any
		_ = json.Unmarshal(msg.Data, &m)
		dcMsgs <- m
	})
	nals := make(chan []byte, 64)
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if !strings.EqualFold(tr.Codec().MimeType, webrtc.MimeTypeH264) {
			t.Errorf("codec %s, want H.264", tr.Codec().MimeType)
		}
		var dp codecs.H264Packet
		for {
			p, _, err := tr.ReadRTP()
			if err != nil {
				return
			}
			out, err := dp.Unmarshal(p.Payload)
			if err == nil && len(out) > 0 {
				select {
				case nals <- out:
				default:
				}
			}
		}
	})
	// Trickle both ways, as the browser and the API do.
	var browserCands []webrtc.ICECandidateInit
	var cmu sync.Mutex
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cmu.Lock()
		browserCands = append(browserCands, c.ToJSON())
		cmu.Unlock()
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	// Candidates sent before the offer is answered are kept and applied (early trickle).
	h.r.newOffer("v1.rtc")
	cmu.Lock()
	for _, c := range browserCands {
		h.r.ice(inMsg{T: "rtc_ice", Req: "v1.rtc", Candidate: &rtcCandidate{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex}})
	}
	cmu.Unlock()
	go h.r.offer(inMsg{T: "rtc_offer", Req: "v1.rtc", SDP: pc.LocalDescription().SDP, Control: ptr(true)})

	var agentCands []map[string]any
	ans := h.next("rtc_answer", func(m map[string]any) {
		if m["t"] == "rtc_ice" {
			agentCands = append(agentCands, m)
		}
	})
	if ans["req"] != "v1.rtc" || !strings.HasPrefix(ans["sdp"].(string), "v=0") {
		t.Fatalf("answer %v", ans)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: ans["sdp"].(string)}); err != nil {
		t.Fatal(err)
	}
	addAgentCand := func(m map[string]any) {
		c, _ := m["candidate"].(map[string]any)
		if c == nil {
			return
		}
		init := webrtc.ICECandidateInit{Candidate: c["candidate"].(string)}
		if mid, ok := c["sdpMid"].(string); ok {
			init.SDPMid = &mid
		}
		_ = pc.AddICECandidate(init)
	}
	for _, m := range agentCands {
		addAgentCand(m)
	}
	connected := h.next("rtc_state", func(m map[string]any) {
		if m["t"] == "rtc_ice" {
			addAgentCand(m)
		}
	})
	for connected["state"] != "connected" {
		if connected["state"] == "failed" {
			t.Fatalf("peer failed: %v", connected)
		}
		connected = h.next("rtc_state", nil)
	}
	if connected["encoder"] == nil {
		t.Log("connected before the first picture (encoder named in rtc_stats)")
	}

	// The browser gets the parameter sets (SPS, PPS; pion aggregates them in one STAP-A packet)
	// before the first IDR slice, so it can start decoding at once.
	var seen []byte
	for !containsByte(seen, 5) {
		select {
		case au := <-nals:
			seen = append(seen, videoenc.NALTypes(au)...)
		case <-time.After(hangGuard):
			t.Fatalf("no key frame reached the browser (NAL types so far %v)", seen)
		}
	}
	if len(seen) < 3 || seen[0] != 7 || seen[1] != 8 {
		t.Fatalf("NAL types %v, want SPS, PPS, then IDR", seen)
	}

	select {
	case <-dcOpen:
	case <-time.After(hangGuard):
		t.Fatal("data channel did not open")
	}
	send := func(ev map[string]any) {
		b, _ := json.Marshal(ev)
		if err := dc.SendText(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	// Allowed: a click and a key by position. The API hears kind/button, never the key.
	send(map[string]any{"kind": "mouse_click", "x": 0.5, "y": 0.25, "button": "left"})
	in := h.next("rtc_input", nil)
	if in["kind"] != "mouse_click" || in["req"] != "v1.rtc" || in["refused"] != nil {
		t.Fatalf("rtc_input %v", in)
	}
	send(map[string]any{"kind": "key_down", "code": "KeyA"})
	in = h.next("rtc_input", nil)
	if in["kind"] != "key_down" || in["code"] != nil || in["key"] != nil || in["text"] != nil {
		t.Fatalf("rtc_input carries a key: %v", in)
	}
	// Refused by validation: unknown kind, out-of-range pointer, a code outside the allow-list.
	for _, bad := range []map[string]any{{"kind": "exec"}, {"kind": "mouse_move", "x": 3.0}, {"kind": "key_down", "code": "Key A;"}} {
		send(bad)
		select {
		case m := <-dcMsgs:
			if m["t"] != "input_error" || m["code"] != "bad_input" {
				t.Fatalf("bad input %v answered %v", bad, m)
			}
		case <-time.After(hangGuard):
			t.Fatalf("no answer to bad input %v", bad)
		}
	}
	h.f.mu.Lock()
	n := len(h.f.inputs)
	h.f.mu.Unlock()
	if n != 2 {
		t.Fatalf("desktop got %d inputs, want 2", n)
	}

	// The API narrows this viewer to view only (hand-over): input stops at the agent.
	h.r.perms("v1.rtc", false)
	send(map[string]any{"kind": "mouse_click", "x": 0.5, "y": 0.5, "button": "left"})
	in = h.next("rtc_input", nil)
	if in["refused"] != "profile_forbids_control" {
		t.Fatalf("view-only input not refused: %v", in)
	}
	select {
	case m := <-dcMsgs:
		if m["code"] != "profile_forbids_control" {
			t.Fatalf("view-only answer %v", m)
		}
	case <-time.After(hangGuard):
		t.Fatal("no refusal on the data channel")
	}
	h.f.mu.Lock()
	n = len(h.f.inputs)
	h.f.mu.Unlock()
	if n != 2 {
		t.Fatalf("view-only input reached the desktop (%d inputs)", n)
	}

	// Stats name the encoder and measure fps/bitrate.
	st := h.next("rtc_stats", nil)
	if st["encoder"] != "fake H.264" {
		t.Fatalf("stats %v", st)
	}

	// The session ends: the peer connection closes and the pump stops.
	closed := make(chan struct{})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateDisconnected {
			select {
			case <-closed:
			default:
				close(closed)
			}
		}
	})
	h.r.closeAll(true)
	select {
	case <-closed:
	case <-time.After(hangGuard):
		t.Fatal("the browser's peer connection stayed up after the session ended")
	}
	if h.r.connected() != 0 {
		t.Fatal("peers left after closeAll")
	}
	// A late offer after the end is ignored (no answer).
	h.r.offer(inMsg{T: "rtc_offer", Req: "v2.rtc", SDP: pc.LocalDescription().SDP})
	select {
	case m := <-h.out:
		if m["t"] == "rtc_answer" {
			t.Fatalf("answered after the session ended: %v", m)
		}
	case <-time.After(300 * time.Millisecond):
	}
}

// TestRTCOfferRefusals: what the agent itself refuses before any peer connection exists.
func TestRTCOfferRefusals(t *testing.T) {
	sdp := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
	cases := []struct {
		name  string
		cfg   Config
		perms userui.Permissions
		msg   inMsg
		code  string
	}{
		{"switched off on the agent", Config{DisableWebRTC: true}, userui.Permissions{View: true}, inMsg{SDP: sdp}, "webrtc_unavailable"},
		{"profile without view", Config{}, userui.Permissions{}, inMsg{SDP: sdp}, "profile_forbids_view"},
		{"empty offer", Config{}, userui.Permissions{View: true}, inMsg{}, "bad_offer"},
		{"oversized offer", Config{}, userui.Permissions{View: true}, inMsg{SDP: strings.Repeat("a", maxSDPBytes+1)}, "bad_offer"},
		{"a TURN relay", Config{}, userui.Permissions{View: true}, inMsg{SDP: sdp, IceServers: []string{"turn:relay.example:3478"}}, "bad_offer"},
		{"not an SDP", Config{}, userui.Permissions{View: true}, inMsg{SDP: "hello"}, "bad_offer"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newRTCHarness(t, c.cfg, c.perms, true)
			h.f.SetVideoOpener(fakeOpener(nil, nil))
			c.msg.T, c.msg.Req = "rtc_offer", "v1.rtc"
			h.r.offer(c.msg)
			m := h.next("rtc_state", nil)
			if m["state"] != "failed" || m["code"] != c.code || m["req"] != "v1.rtc" {
				t.Fatalf("got %v, want failed %s", m, c.code)
			}
		})
	}
	t.Run("no encoder on this computer", func(t *testing.T) {
		h := newRTCHarness(t, Config{}, userui.Permissions{View: true}, true)
		h.f.SetVideoOpener(func(videoenc.Config) (videoenc.Encoder, error) {
			return nil, videoenc.ErrUnavailable
		})
		if c := h.m.rtcCapability(); c.Supported || c.Reason == "" {
			t.Fatalf("capability %+v", c)
		}
		h.r.offer(inMsg{T: "rtc_offer", Req: "v1.rtc", SDP: sdp})
		if m := h.next("rtc_state", nil); m["code"] != "webrtc_unavailable" {
			t.Fatalf("got %v", m)
		}
	})
	t.Run("only stun URLs", func(t *testing.T) {
		if _, err := validStun([]string{"stun:stun.example:3478", "stuns:stun.example:5349"}); err != nil {
			t.Fatal(err)
		}
		for _, bad := range [][]string{{"turns:x"}, {"http://x"}, {"stun:a", "stun:b", "stun:c", "stun:d", "stun:e"}} {
			if _, err := validStun(bad); err == nil {
				t.Fatalf("%v accepted", bad)
			}
		}
	})
}

// TestRTCEncoderFailureEndsPeers: an encoder that keeps failing sends every WebRTC viewer
// rtc_state failed (encoder_failed) and closes the peers, so the browsers go back to JPEG.
func TestRTCEncoderFailureEndsPeers(t *testing.T) {
	h := newRTCHarness(t, Config{VideoFPS: 30}, userui.Permissions{View: true}, false)
	var fail atomic.Int32
	fail.Store(1000)
	h.f.SetVideoOpener(fakeOpener(&fail, nil))
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &rtcPeer{req: "v9.rtc", pc: pc}
	p.up.Store(true)
	h.r.mu.Lock()
	h.r.peers[p.req] = p
	h.r.mu.Unlock()
	h.r.ensurePump()
	// The software encoder is tried after the first failure; then three failed grabs end it.
	m := h.next("rtc_state", nil)
	for m["state"] == "encoder_changed" {
		m = h.next("rtc_state", nil)
	}
	if m["state"] != "failed" || m["code"] != "encoder_failed" || m["req"] != "v9.rtc" {
		t.Fatalf("got %v", m)
	}
	deadline := time.Now().Add(hangGuard)
	for h.r.connected() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the peer stayed after the encoder failed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestNextBitrate(t *testing.T) {
	cases := []struct {
		cur  int
		loss float64
		want int
	}{
		{4_000_000, 0.20, 2_800_000},
		{4_000_000, 0.12, 3_200_000},
		{4_000_000, 0.05, 4_000_000},
		{4_000_000, 0.0, 4_400_000},
		{MaxVideoBitrate, 0.0, MaxVideoBitrate},
		{MinVideoBitrate, 0.5, MinVideoBitrate},
	}
	for _, c := range cases {
		if got := NextBitrate(c.cur, c.loss); got != c.want {
			t.Errorf("NextBitrate(%d, %.2f) = %d, want %d", c.cur, c.loss, got, c.want)
		}
	}
}

func TestNextBitrateForRelayedHighRTT(t *testing.T) {
	// Zero packet loss over a TCP relay (Tailscale DERP at 250 ms RTT) must cap & reduce bitrate
	// instead of climbing to 12 Mbit/s.
	got := NextBitrateFor(StartVideoBitrate, 0.0, 250, 10, false)
	if got > 1_200_000 {
		t.Fatalf("250 ms relay with 0%% loss must cap <= 1.2 Mbit/s, got %d", got)
	}
	// Moderate WAN (150 ms RTT, 0% loss) stays bounded <= 2.5 Mbit/s and does not climb.
	if got := NextBitrateFor(2_500_000, 0.0, 150, 10, false); got > 2_500_000 {
		t.Fatalf("150 ms RTT must not climb above 2.5 Mbit/s, got %d", got)
	}
	// PLI burst (stalled decoder) backs off even with 0% reported loss.
	if got := NextBitrateFor(2_500_000, 0.0, 30, 5, true); got != 2_000_000 {
		t.Fatalf("PLI burst must step down 20%%, got %d", got)
	}
	// Low-latency LAN climbs cleanly up to MaxVideoBitrate.
	if got := NextBitrateFor(2_500_000, 0.0, 10, 2, false); got != 2_750_000 {
		t.Fatalf("LAN should climb 10%%, got %d", got)
	}
}

func TestVideoFPSForAndInflightWindowFor(t *testing.T) {
	if got := VideoFPSFor(60, 4_000_000, 10); got != 60 {
		t.Errorf("LAN fps = %d, want 60", got)
	}
	if got := VideoFPSFor(60, 2_000_000, 80); got != 30 {
		t.Errorf("moderate WAN fps = %d, want 30", got)
	}
	if got := VideoFPSFor(60, 1_200_000, 240); got != 20 {
		t.Errorf("relay fps = %d, want 20", got)
	}
	if got := InflightWindowFor(20*time.Millisecond, false); got != InflightWindow {
		t.Errorf("LAN jpeg inflight = %d, want %d", got, InflightWindow)
	}
	if got := InflightWindowFor(220*time.Millisecond, false); got != 6 {
		t.Errorf("high-RTT jpeg inflight = %d, want 6", got)
	}
	if got := InflightWindowFor(220*time.Millisecond, true); got != 8 {
		t.Errorf("high-RTT h264 inflight = %d, want 8", got)
	}
}

// The data-channel validation mirrors the API's rd_input schema.
func TestValidateInputMirrorsTheAPI(t *testing.T) {
	ok := []remotedesktop.InputEvent{
		{Kind: "mouse_move", NormalizedX: 1, NormalizedY: 0},
		{Kind: "mouse_wheel", DeltaY: -2400},
		{Kind: "key_combo", Keys: []string{"Ctrl", "Alt", "Delete"}},
		{Kind: "text", Text: strings.Repeat("x", 240)},
		{Kind: "key_up", Code: "ShiftLeft"},
	}
	for _, ev := range ok {
		if err := remotedesktop.ValidateInput(ev); err != nil {
			t.Errorf("%+v refused: %v", ev, err)
		}
	}
	bad := []remotedesktop.InputEvent{
		{Kind: "launch"},
		{Kind: "mouse_move", NormalizedX: -0.1},
		{Kind: "mouse_click", Button: "x1"},
		{Kind: "mouse_wheel", DeltaY: 5000},
		{Kind: "text", Text: strings.Repeat("x", 241)},
		{Kind: "key_down"},
		{Kind: "key_combo", Keys: []string{"Ctrl"}},
		{Kind: "key_combo", Keys: []string{"Ctrl", "rm -rf"}},
		{Kind: "mouse_move", DisplayIndex: 9},
	}
	for _, ev := range bad {
		if err := remotedesktop.ValidateInput(ev); err == nil {
			t.Errorf("%+v accepted", ev)
		}
	}
}

func TestVideoScale(t *testing.T) {
	cases := []struct {
		chosen  float64
		bitrate int
		want    float64
	}{
		{0.75, StartVideoBitrate, 1},  // the JPEG default does not shrink video
		{1, 1_500_000, 0.75},          // loss pushed the bitrate down: smaller picture
		{1, 500_000, 0.5},             //
		{0.5, MaxVideoBitrate, 0.5},   // a deliberate 50 % is kept
		{0.25, MaxVideoBitrate, 0.25}, //
	}
	for _, c := range cases {
		if got := VideoScale(c.chosen, c.bitrate); got != c.want {
			t.Errorf("VideoScale(%.2f, %d) = %.2f, want %.2f", c.chosen, c.bitrate, got, c.want)
		}
	}
}
