package shell

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/userui"
	"github.com/nigafiy/agent/internal/wsclient"
)

const shellID = "shellid-0123456789abcdef"

// ── A minimal server end of the shell socket ──

type srv struct {
	nc  net.Conn
	br  *bufio.Reader
	wmu sync.Mutex
}

func (s *srv) write(op int, p []byte) {
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

func (s *srv) read() (int, []byte, error) {
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

type frame struct {
	op   int
	data []byte
}

// hangGuard bounds every wait for something the code under test does in this process. Waits
// return as soon as it happens; the guard only turns a hang into a failure. It is long because
// a loaded machine (several test suites at once) can stall these goroutines for seconds, and
// nothing here asserts how fast anything is.
const hangGuard = 30 * time.Second

// waitFor polls a condition the code under test exposes no signal for.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(hangGuard)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func server(t *testing.T, conns chan<- *srv, frames chan<- frame) *httptest.Server {
	// Several agents may connect to one test server (TestServerCloseAndRefusals): the first socket
	// to end closes frames, once; what later sockets send is dropped (no send on a closed channel).
	var mu sync.Mutex
	closed := false
	deliver := func(f frame) {
		mu.Lock()
		defer mu.Unlock()
		if !closed {
			frames <- f
		}
	}
	end := func() {
		mu.Lock()
		defer mu.Unlock()
		if !closed {
			closed = true
			close(frames)
		}
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/shell" || r.URL.Query().Get("shell") != shellID || r.Header.Get("Authorization") != "Bearer cred" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		nc, brw, _ := w.(http.Hijacker).Hijack()
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsclient.AcceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n")
		_ = brw.Flush()
		c := &srv{nc: nc, br: brw.Reader}
		conns <- c
		for {
			op, p, err := c.read()
			if err != nil || op == wsclient.OpClose {
				end()
				return
			}
			deliver(frame{op, p})
		}
	}))
}

// ── A scripted terminal ──

type fakeTerm struct {
	out    chan []byte
	mu     sync.Mutex
	input  []byte
	sizes  [][2]int
	exit   chan int
	code   int
	closed chan struct{}
	once   sync.Once
}

func newFake() *fakeTerm {
	return &fakeTerm{out: make(chan []byte, 16), exit: make(chan int, 1), closed: make(chan struct{})}
}

func (f *fakeTerm) Read(p []byte) (int, error) {
	select {
	case b := <-f.out:
		return copy(p, b), nil
	case c := <-f.exit:
		f.code = c
		return 0, io.EOF
	case <-f.closed:
		return 0, io.EOF
	}
}
func (f *fakeTerm) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.input = append(f.input, p...)
	f.mu.Unlock()
	return len(p), nil
}
func (f *fakeTerm) Resize(c, r int) error {
	f.mu.Lock()
	f.sizes = append(f.sizes, [2]int{c, r})
	f.mu.Unlock()
	return nil
}
func (f *fakeTerm) Wait() (int, error) { return f.code, nil }
func (f *fakeTerm) Kill()              {}
func (f *fakeTerm) Close() error       { f.once.Do(func() { close(f.closed) }); return nil }
func (f *fakeTerm) Kind() string       { return "pty" }
func (f *fakeTerm) Name() string       { return "/bin/fake" }
func (f *fakeTerm) typed() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.input)
}

type ended struct {
	reason string
	code   *int
}

type rig struct {
	m      *Manager
	term   *fakeTerm
	conns  chan *srv
	frames chan frame
	ended  chan ended
	mux    *desktop.BannerMux
	ui     *recUI
}

// recUI records what the one banner shows.
type recUI struct {
	desktop.Desktop
	mu    sync.Mutex
	shown *userui.BannerInfo
	onEnd func()
}

func (u *recUI) ShowBanner(i userui.BannerInfo, onEnd func()) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.shown, u.onEnd = &i, onEnd
	return nil
}
func (u *recUI) HideBanner(id string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.shown != nil && (id == "" || u.shown.SessionID == id) {
		u.shown, u.onEnd = nil, nil
	}
}
func (u *recUI) banner() (*userui.BannerInfo, func()) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.shown, u.onEnd
}

func newRig(t *testing.T, ts *httptest.Server, conns chan *srv, frames chan frame) *rig {
	ui := &recUI{}
	mux := desktop.NewBannerMux(ui)
	r := &rig{term: newFake(), conns: conns, frames: frames, ended: make(chan ended, 4), mux: mux, ui: ui}
	r.m = NewManager(Config{
		ServerURL:  ts.URL,
		Credential: func() string { return "cred" },
		Banner:     mux.SetShells,
		NotifyEnded: func(_ context.Context, id, reason string, code *int) error {
			r.ended <- ended{reason, code}
			return nil
		},
		StartTerminal: func(int, int) (Terminal, error) { return r.term, nil },
		CheckEvery:    50 * time.Millisecond,
	})
	return r
}

func nextFrame(t *testing.T, frames <-chan frame, op int) frame {
	t.Helper()
	deadline := time.After(hangGuard)
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				t.Fatal("socket closed")
			}
			if f.op == op {
				return f
			}
		case <-deadline:
			t.Fatalf("no frame with op %d", op)
		}
	}
}

func waitEnded(t *testing.T, r *rig) ended {
	t.Helper()
	select {
	case e := <-r.ended:
		return e
	case <-time.After(hangGuard):
		t.Fatal("the shell did not end")
	}
	return ended{}
}

func TestShellRelaysBothWaysAndShowsTheOperatorOnTheBanner(t *testing.T) {
	conns, frames := make(chan *srv, 1), make(chan frame, 64)
	ts := server(t, conns, frames)
	defer ts.Close()
	r := newRig(t, ts, conns, frames)

	res, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID, Operator: "admin@corp.example", Reason: "Printer queue stuck", Cols: 100, Rows: 40, IdleTimeoutS: 60})
	if err != nil {
		t.Fatal(err)
	}
	if res.Banner != "shown" || res.PTY != "pty" || res.Shell != "/bin/fake" {
		t.Fatalf("%+v", res)
	}
	c := <-conns
	var hello map[string]any
	_ = json.Unmarshal(nextFrame(t, frames, wsclient.OpText).data, &hello)
	if hello["t"] != "hello" || hello["pty"] != "pty" || hello["cols"] != float64(100) {
		t.Fatalf("hello %v", hello)
	}

	// The banner names the operator and the reason: "Shell open by …".
	info, _ := r.ui.banner()
	if info == nil || !info.ShellOnly || len(info.Shells) != 1 {
		t.Fatalf("banner %+v", info)
	}
	text := userui.BannerText(*info)
	for _, want := range []string{"Shell open by admin@corp.example.", "Reason: Printer queue stuck.", "recorded in a transcript", "سطر أوامر مفتوح من admin@corp.example."} {
		if !strings.Contains(text, want) {
			t.Fatalf("banner lacks %q:\n%s", want, text)
		}
	}

	r.term.out <- []byte("PS C:\\> ")
	if f := nextFrame(t, frames, wsclient.OpBinary); string(f.data) != "PS C:\\> " {
		t.Fatalf("output %q", f.data)
	}
	c.write(wsclient.OpBinary, []byte("Get-Date\r"))
	c.write(wsclient.OpText, []byte(`{"t":"resize","cols":150,"rows":50}`))
	waitFor(t, "the typed input", func() bool { return len(r.term.typed()) >= len("Get-Date\r") })
	if r.term.typed() != "Get-Date\r" {
		t.Fatalf("input %q", r.term.typed())
	}
	// The resize follows the keystrokes on the socket, so it is applied a moment later: wait for
	// it before the shell exits (the exit closes the socket, and a resize still unread is dropped).
	waitFor(t, "the resize", func() bool {
		r.term.mu.Lock()
		defer r.term.mu.Unlock()
		return len(r.term.sizes) > 0
	})

	// The shell exits: the API hears the exit code on the socket, the banner line goes.
	r.term.exit <- 3
	var exit map[string]any
	_ = json.Unmarshal(nextFrame(t, frames, wsclient.OpText).data, &exit)
	if exit["t"] != "exit" || exit["code"] != float64(3) {
		t.Fatalf("exit %v", exit)
	}
	waitFor(t, "the shell to close", func() bool { info, _ := r.ui.banner(); return r.m.Count() == 0 && info == nil })
	if info, _ := r.ui.banner(); info != nil || r.m.Count() != 0 {
		t.Fatalf("banner still up: %+v", info)
	}
	if len(r.ended) != 0 {
		t.Fatal("the exit went over the socket, no HTTP notice needed")
	}
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	if len(r.term.sizes) != 1 || r.term.sizes[0] != [2]int{150, 50} {
		t.Fatalf("resize %v", r.term.sizes)
	}
}

// End session on the banner ends the shell, the API hears "user" before the socket closes.
func TestBannerEndEndsTheShellAndTellsTheServerFirst(t *testing.T) {
	conns, frames := make(chan *srv, 1), make(chan frame, 64)
	ts := server(t, conns, frames)
	defer ts.Close()
	r := newRig(t, ts, conns, frames)
	if _, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID, Operator: "a@b.c", Reason: "check"}); err != nil {
		t.Fatal(err)
	}
	<-conns
	nextFrame(t, frames, wsclient.OpText)

	// A remote desktop session opens too: one banner names both, End ends both.
	rdEnded := make(chan struct{}, 1)
	_ = r.mux.ShowBanner(userui.BannerInfo{SessionID: "rd-1", Operator: "tech@corp.example", Reason: "help"}, func() { rdEnded <- struct{}{} })
	info, onEnd := r.ui.banner()
	if info.SessionID != "rd-1" || info.ShellOnly || len(info.Shells) != 1 {
		t.Fatalf("merged banner %+v", info)
	}
	text := userui.BannerText(*info)
	if !strings.Contains(text, "tech@corp.example can see") || !strings.Contains(text, "Shell open by a@b.c.") {
		t.Fatalf("merged text:\n%s", text)
	}
	// The session ends: the shell keeps its banner.
	r.mux.HideBanner("rd-1")
	info, onEnd = r.ui.banner()
	if info == nil || !info.ShellOnly || info.SessionID != desktop.ShellBannerID {
		t.Fatalf("shell banner after the session %+v", info)
	}
	onEnd()
	if e := waitEnded(t, r); e.reason != "user" {
		t.Fatalf("reason %q", e.reason)
	}
	select {
	case <-rdEnded:
		t.Fatal("the session had already ended")
	default:
	}
	if info, _ := r.ui.banner(); info != nil {
		t.Fatalf("banner left: %+v", info)
	}
}

func TestIdleAndSizeLimitsEndTheShell(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  OpenRequest
		feed bool
		want string
	}{
		{"idle", OpenRequest{ShellID: shellID, IdleTimeoutS: 1}, false, "idle"},
		{"limit", OpenRequest{ShellID: shellID, IdleTimeoutS: 60, MaxTranscriptBytes: 10}, true, "limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conns, frames := make(chan *srv, 1), make(chan frame, 64)
			ts := server(t, conns, frames)
			defer ts.Close()
			r := newRig(t, ts, conns, frames)
			if _, err := r.m.Open(context.Background(), tc.req); err != nil {
				t.Fatal(err)
			}
			<-conns
			if tc.feed {
				r.term.out <- []byte("0123456789abcdef")
			}
			if e := waitEnded(t, r); e.reason != tc.want {
				t.Fatalf("reason %q", e.reason)
			}
		})
	}
}

func TestServerCloseAndRefusals(t *testing.T) {
	conns, frames := make(chan *srv, 1), make(chan frame, 64)
	ts := server(t, conns, frames)
	defer ts.Close()
	r := newRig(t, ts, conns, frames)
	if _, err := r.m.Open(context.Background(), OpenRequest{ShellID: "short"}); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID}); err != nil {
		t.Fatal(err)
	}
	c := <-conns
	if _, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID}); err == nil {
		t.Fatal("same shell twice")
	}
	// The API ends it (operator End, idle there, revoked): the close frame stops it here, no notice back.
	c.write(wsclient.OpText, []byte(`{"t":"end","reason":"operator"}`))
	waitFor(t, "the shell to close", func() bool { return r.m.Count() == 0 })
	if r.m.Count() != 0 || len(r.ended) != 0 {
		t.Fatalf("open %d, notices %d", r.m.Count(), len(r.ended))
	}

	// No server: the shell does not stay open and the banner goes.
	bad := newRig(t, ts, conns, frames)
	bad.m.cfg.ServerURL = "http://127.0.0.1:1"
	if _, err := bad.m.Open(context.Background(), OpenRequest{ShellID: shellID}); err == nil {
		t.Fatal("opened without a server")
	}
	if info, _ := bad.ui.banner(); info != nil || bad.m.Count() != 0 {
		t.Fatal("left open")
	}

	// No desktop: the shell opens, the result says the banner is unavailable.
	nb := newRig(t, ts, conns, frames)
	nb.m.cfg.Banner = nil
	res, err := nb.m.Open(context.Background(), OpenRequest{ShellID: shellID})
	if err != nil || res.Banner != "unavailable" {
		t.Fatalf("%v %+v", err, res)
	}
	nb.m.EndAll("agent_gone")
}

// The real terminal of this platform: a command typed into it runs, its exit code comes back.
func TestRealTerminal(t *testing.T) {
	// The shell is interactive: it would append the typed test commands to the developer's own
	// history (PSReadLine under the profile, ~/.bash_history). Give it a throw-away profile.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("HISTFILE", filepath.Join(home, ".sh_history"))
	term, err := Start(100, 30)
	if err != nil {
		if runtime.GOOS == "windows" && strings.Contains(err.Error(), "pseudo console") {
			t.Skip(err)
		}
		t.Fatal(err)
	}
	defer term.Close()
	out := make(chan string, 256)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				out <- string(buf[:n])
			}
			if err != nil {
				close(out)
				return
			}
		}
	}()
	cmd, exit := "echo nigafiy-$((40+2))\r", "exit 5\r"
	want := "nigafiy-42"
	if runtime.GOOS == "windows" {
		cmd = "Write-Output ('nigafiy-' + (40+2))\r"
	}
	if term.Kind() == "pipes" {
		cmd = strings.ReplaceAll(cmd, "\r", "\n")
	}
	if _, err := term.Write([]byte(cmd)); err != nil {
		t.Fatal(err)
	}
	if err := term.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	var seen strings.Builder
	deadline := time.After(30 * time.Second)
	for !strings.Contains(seen.String(), want) {
		select {
		case s, ok := <-out:
			if !ok {
				t.Fatalf("output ended:\n%s", seen.String())
			}
			seen.WriteString(s)
		case <-deadline:
			t.Fatalf("no %q in:\n%q", want, seen.String())
		}
	}
	if _, err := term.Write([]byte(exit)); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() { c, _ := term.Wait(); done <- c }()
	select {
	case c := <-done:
		if c != 5 {
			t.Fatalf("exit code %d", c)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the shell did not exit")
	}
	for range out {
	}
}

// A banner that cannot be shown on a computer with a desktop ends the shell before the server is
// joined: no terminal is left running and nobody can type into it (fail closed).
func TestBannerFailureRefusesTheShell(t *testing.T) {
	conns, frames := make(chan *srv, 1), make(chan frame, 64)
	ts := server(t, conns, frames)
	defer ts.Close()
	r := newRig(t, ts, conns, frames)
	r.m.cfg.Banner = func([]userui.ShellLine, func()) error { return errors.New("no user session") }

	res, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID, Operator: "admin@corp.example", Reason: "Test", Cols: 80, Rows: 24, IdleTimeoutS: 60})
	if err == nil || res.Banner != "failed" {
		t.Fatalf("shell opened without its banner: %+v, %v", res, err)
	}
	select {
	case <-r.term.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("the terminal was left running")
	}
	select {
	case <-conns:
		t.Fatal("the shell joined the server without a banner")
	case <-time.After(200 * time.Millisecond):
	}
	if r.m.Count() != 0 {
		t.Fatalf("%d shells still open", r.m.Count())
	}
}

// An unattended group with the banner off (company-managed computer): the shell opens with no
// banner line, still relays, and the server still ends it.
func TestSilentShellDrawsNoBannerAndStillCloses(t *testing.T) {
	conns, frames := make(chan *srv, 1), make(chan frame, 64)
	ts := server(t, conns, frames)
	defer ts.Close()
	r := newRig(t, ts, conns, frames)

	res, err := r.m.Open(context.Background(), OpenRequest{ShellID: shellID, Operator: "admin@corp.example", Reason: "Patch check", Cols: 80, Rows: 24, IdleTimeoutS: 60, BannerMode: "off"})
	if err != nil || res.Banner != "off" {
		t.Fatalf("%+v, %v", res, err)
	}
	<-conns
	_ = nextFrame(t, frames, wsclient.OpText) // hello
	if info, _ := r.ui.banner(); info != nil {
		t.Fatalf("banner drawn for a silent shell: %+v", info)
	}
	if len(r.m.Lines()) != 0 {
		t.Fatalf("silent shell listed on the banner: %+v", r.m.Lines())
	}
	if !r.m.Close(shellID, "operator") {
		t.Fatal("the server could not close a silent shell")
	}
	waitFor(t, "the shell to close", func() bool { return r.m.Count() == 0 })
}
