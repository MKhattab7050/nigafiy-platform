package rdstream

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/endpoint-agent/internal/desktop"
	"github.com/lan-detective/endpoint-agent/internal/remotedesktop"
	"github.com/lan-detective/endpoint-agent/internal/userui"
	"github.com/lan-detective/endpoint-agent/internal/wsclient"
)

type fakeUI struct {
	mu     sync.Mutex
	answer userui.ConsentAnswer
	asked  int
	shown  []userui.BannerInfo
	hidden []string
	onEnd  func()
}

func (f *fakeUI) Consent(context.Context, userui.ConsentRequest) (userui.ConsentAnswer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked++
	return f.answer, nil
}
func (f *fakeUI) ShowBanner(i userui.BannerInfo, onEnd func()) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shown = append(f.shown, i)
	f.onEnd = onEnd
	return nil
}
func (f *fakeUI) HideBanner(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hidden = append(f.hidden, s)
}

// fakeDesktop: synthetic screen (changes when asked), recorded input and an in-memory clipboard.
type fakeDesktop struct {
	*desktop.Local
	mu     sync.Mutex
	inputs []remotedesktop.InputEvent
	clip   string
	shade  uint8
}

func newFakeDesktop(ui userui.UI) *fakeDesktop {
	f := &fakeDesktop{clip: "remote text"}
	f.Local = desktop.NewLocalWith(ui, func(int) (*image.RGBA, []remotedesktop.DisplayInfo, int, string, error) {
		f.mu.Lock()
		c := f.shade
		f.mu.Unlock()
		img := image.NewRGBA(image.Rect(0, 0, 640, 400))
		draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{c, 0, 0, 255}}, image.Point{}, draw.Src)
		return img, []remotedesktop.DisplayInfo{{Index: 0, Name: "Test", Width: 640, Height: 400, Primary: true}}, 0, "synthetic", nil
	})
	return f
}
func (f *fakeDesktop) Displays() ([]remotedesktop.DisplayInfo, error) {
	return []remotedesktop.DisplayInfo{{Index: 0, Name: "Test", Width: 640, Height: 400, Primary: true}}, nil
}
func (f *fakeDesktop) Input(ev remotedesktop.InputEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inputs = append(f.inputs, ev)
	f.shade += 40 // the screen reacts
	return nil
}
func (f *fakeDesktop) ClipboardText() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clip, nil
}
func (f *fakeDesktop) SetClipboardText(t string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clip = t
	return nil
}

// Minimal RFC 6455 server side for the test.
type srvConn struct {
	nc  net.Conn
	br  *bufio.Reader
	wmu sync.Mutex
}

func (s *srvConn) write(op int, p []byte) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	hdr := []byte{0x80 | byte(op)}
	switch n := len(p); {
	case n <= 125:
		hdr = append(hdr, byte(n))
	case n <= 0xffff:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	_, _ = s.nc.Write(append(hdr, p...))
}

func (s *srvConn) json(v any) { b, _ := json.Marshal(v); s.write(wsclient.OpText, b) }

func (s *srvConn) read() (int, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(s.br, h[:]); err != nil {
		return 0, nil, err
	}
	n := uint64(h[1] & 0x7f)
	if n == 126 {
		var e [2]byte
		_, _ = io.ReadFull(s.br, e[:])
		n = uint64(binary.BigEndian.Uint16(e[:]))
	} else if n == 127 {
		var e [8]byte
		_, _ = io.ReadFull(s.br, e[:])
		n = binary.BigEndian.Uint64(e[:])
	}
	var mask [4]byte
	_, _ = io.ReadFull(s.br, mask[:])
	p := make([]byte, n)
	if _, err := io.ReadFull(s.br, p); err != nil {
		return 0, nil, err
	}
	for i := range p {
		p[i] ^= mask[i&3]
	}
	return int(h[0] & 0x0f), p, nil
}

type msgIn struct {
	text map[string]any
	pkt  *remotedesktop.FrameHeader
}

func wsServer(t *testing.T, onConn func(c *srvConn, in <-chan msgIn, r *http.Request)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/stream" || r.Header.Get("Authorization") != "Bearer lda_e.s" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		nc, brw, _ := w.(http.Hijacker).Hijack()
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsclient.AcceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n")
		_ = brw.Flush()
		c := &srvConn{nc: nc, br: brw.Reader}
		in := make(chan msgIn, 64)
		go func() {
			defer close(in)
			for {
				op, p, err := c.read()
				if err != nil || op == wsclient.OpClose {
					return
				}
				switch op {
				case wsclient.OpText:
					var m map[string]any
					_ = json.Unmarshal(p, &m)
					in <- msgIn{text: m}
				case wsclient.OpBinary:
					h, _, err := remotedesktop.ParsePacket(p)
					if err == nil {
						in <- msgIn{pkt: &h}
					}
				case wsclient.OpPing:
					c.write(wsclient.OpPong, p)
				}
			}
		}()
		onConn(c, in, r)
	}))
}

func next(t *testing.T, in <-chan msgIn, want string) msgIn {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m, ok := <-in:
			if !ok {
				t.Fatalf("socket closed while waiting for %s", want)
			}
			if want == "frame" && m.pkt != nil {
				return m
			}
			if m.text != nil && m.text["t"] == want {
				return m
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", want)
		}
	}
}

func TestSessionConsentBannerStreamInputClipboardAndServerEnd(t *testing.T) {
	ui := &fakeUI{answer: userui.Accepted}
	d := newFakeDesktop(ui)
	finished := make(chan struct{})
	srv := wsServer(t, func(c *srvConn, in <-chan msgIn, r *http.Request) {
		defer close(finished)
		if r.URL.Query().Get("session") != "sess-1" {
			t.Errorf("session query %q", r.URL.RawQuery)
		}
		hello := next(t, in, "hello")
		if hello.text["encoder"] != "jpeg" || hello.text["webp"] != false || hello.text["control"] != true {
			t.Errorf("hello %v", hello.text)
		}
		// No viewer yet: no frames. One viewer: a full frame.
		c.json(map[string]any{"t": "viewers", "count": 1})
		f := next(t, in, "frame")
		if !f.pkt.Full || f.pkt.W != 640 {
			t.Errorf("first frame %+v", f.pkt)
		}
		c.json(map[string]any{"t": "ack", "seq": f.pkt.Seq})
		// Input reaches the desktop; the screen changes; a delta frame follows.
		c.json(map[string]any{"t": "input", "ev": map[string]any{"kind": "mouse_click", "x": 0.5, "y": 0.5, "button": "left"}})
		f2 := next(t, in, "frame")
		if f2.pkt.Seq <= f.pkt.Seq {
			t.Errorf("seq did not advance: %d", f2.pkt.Seq)
		}
		c.json(map[string]any{"t": "ack", "seq": f2.pkt.Seq})
		// Clipboard both ways.
		c.json(map[string]any{"t": "clipboard_set", "req": "r1", "text": "from operator"})
		next(t, in, "clipboard_set_ok")
		c.json(map[string]any{"t": "clipboard_get", "req": "r2"})
		got := next(t, in, "clipboard")
		if got.text["text"] != "from operator" || got.text["req"] != "r2" {
			t.Errorf("clipboard %v", got.text)
		}
		// Stats are measured and sent.
		st := next(t, in, "stats")
		if _, ok := st.text["rtt_ms"]; !ok {
			t.Errorf("stats %v", st.text)
		}
		// The server ends the session (close code 4000).
		c.write(wsclient.OpClose, append(binary.BigEndian.AppendUint16(nil, CloseSessionEnded), "session_ended"...))
		for range in {
		}
	})
	defer srv.Close()

	m := NewManager(Config{ServerURL: srv.URL, Credential: func() string { return "lda_e.s" }, UserAgent: "test", Desktop: d, MaxFPS: 30})
	res := m.Open(context.Background(), OpenRequest{SessionID: "sess-1", Operator: "tech@corp.example", Reason: "printer", ConsentRequired: true, ConsentTimeoutSeconds: 30, Control: true, Stream: true, Quality: 70, Scale: 1})
	if res.Consent != "accepted" || res.Banner != "shown" || res.Stream != "connecting" {
		t.Fatalf("open result %+v", res)
	}
	if ui.asked != 1 || len(ui.shown) != 1 || ui.shown[0].Operator != "tech@corp.example" || !ui.shown[0].Control {
		t.Fatalf("consent/banner not shown: %+v", ui)
	}
	select {
	case <-finished:
	case <-time.After(15 * time.Second):
		t.Fatal("stream test did not finish")
	}
	// The server's end closes the session here: banner removed.
	deadline := time.Now().Add(3 * time.Second)
	for m.Active() != "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if m.Active() != "" {
		t.Fatal("session still open after the server ended it")
	}
	ui.mu.Lock()
	defer ui.mu.Unlock()
	if len(ui.hidden) == 0 || ui.hidden[len(ui.hidden)-1] != "sess-1" {
		t.Fatalf("banner not hidden: %v", ui.hidden)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.inputs) != 1 || d.inputs[0].Kind != "mouse_click" {
		t.Fatalf("inputs %+v", d.inputs)
	}
}

func TestSessionConsentDeniedShowsNothingAndStreamsNothing(t *testing.T) {
	for _, a := range []userui.ConsentAnswer{userui.Denied, userui.TimedOut} {
		ui := &fakeUI{answer: a}
		m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
		res := m.Open(context.Background(), OpenRequest{SessionID: "s", ConsentRequired: true, Stream: true})
		if res.Consent != string(a) || res.Banner != "not_shown" || res.Stream != "not_started" || m.Active() != "" || len(ui.shown) != 0 {
			t.Fatalf("%s: %+v active=%q banners=%d", a, res, m.Active(), len(ui.shown))
		}
	}
}

func TestEndSessionButtonNotifiesTheServerAndClosesLocally(t *testing.T) {
	ui := &fakeUI{}
	notified := make(chan string, 1)
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui),
		NotifyEnded: func(_ context.Context, s string) error { notified <- s; return nil }})
	res := m.Open(context.Background(), OpenRequest{SessionID: "s7", Operator: "tech"})
	if res.Consent != "not_required" || res.Banner != "shown" || res.Stream != "not_requested" {
		t.Fatalf("%+v", res)
	}
	ui.mu.Lock()
	press := ui.onEnd
	ui.mu.Unlock()
	press()
	select {
	case s := <-notified:
		if s != "s7" {
			t.Fatalf("notified %s", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("End session was not reported to the server")
	}
	if m.Active() != "" {
		t.Fatal("session still open after End session")
	}
	// A view-only session refuses input on the socket (checked in handle).
	s := &stream{l: &live{m: m, req: OpenRequest{SessionID: "v", Control: false}}, ctrl: NewController(70, 1, true, time.Now()), inflight: map[uint64]sent{}, wake: make(chan struct{}, 1)}
	_ = s
	if u, _ := StreamURL("https://srv.example:8443/", "a b"); u != "wss://srv.example:8443/api/v1/agent/stream?session=a+b" {
		t.Fatalf("StreamURL %s", u)
	}
}

// waitingUI keeps the consent dialog up until its context ends (the person has not answered).
type waitingUI struct {
	fakeUI
	up chan struct{}
}

func (w *waitingUI) Consent(ctx context.Context, _ userui.ConsentRequest) (userui.ConsentAnswer, error) {
	close(w.up)
	<-ctx.Done()
	return "", ctx.Err()
}

func TestClosingWhileTheConsentDialogIsUpWithdrawsIt(t *testing.T) {
	ui := &waitingUI{up: make(chan struct{})}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
	done := make(chan OpenResult, 1)
	go func() { done <- m.Open(context.Background(), OpenRequest{SessionID: "c1", ConsentRequired: true, Stream: true}) }()
	<-ui.up
	if m.Close("other", "operator") {
		t.Fatal("closed a session that is not the one asking")
	}
	if !m.Close("c1", "operator") {
		t.Fatal("pending consent not withdrawn")
	}
	select {
	case res := <-done:
		if res.Consent != "unavailable" || res.Banner != "not_shown" || res.Stream != "not_started" || m.Active() != "" {
			t.Fatalf("%+v active=%q", res, m.Active())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Open did not return after the session was closed")
	}
}
