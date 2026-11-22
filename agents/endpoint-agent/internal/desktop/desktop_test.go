package desktop

import (
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"io"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/endpoint-agent/internal/remotedesktop"
	"github.com/lan-detective/endpoint-agent/internal/userui"
)

// The test binary doubles as a session helper process: with NIGAFIY_TEST_HELPER=1 it serves the
// real Local desktop of this computer on stdin/stdout (what `endpoint-agent session-helper` does).
func TestMain(m *testing.M) {
	if os.Getenv("NIGAFIY_TEST_HELPER") == "1" {
		_ = Serve(context.Background(), os.Stdin, os.Stdout, NewLocal())
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fakeUI struct {
	mu      sync.Mutex
	answer  userui.ConsentAnswer
	asked   []userui.ConsentRequest
	banners []userui.BannerInfo
	onEnd   func()
	hidden  []string
}

func (f *fakeUI) Consent(_ context.Context, r userui.ConsentRequest) (userui.ConsentAnswer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, r)
	return f.answer, nil
}

func (f *fakeUI) ShowBanner(i userui.BannerInfo, onEnd func()) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.banners = append(f.banners, i)
	f.onEnd = onEnd
	return nil
}

func (f *fakeUI) HideBanner(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hidden = append(f.hidden, s)
}

func (f *fakeUI) pressEnd() {
	f.mu.Lock()
	fn := f.onEnd
	f.mu.Unlock()
	fn()
}

func synthetic(c color.RGBA) remotedesktop.CaptureSource {
	return func(int) (*image.RGBA, []remotedesktop.DisplayInfo, int, string, error) {
		img := image.NewRGBA(image.Rect(0, 0, 640, 400))
		draw.Draw(img, img.Bounds(), &image.Uniform{c}, image.Point{}, draw.Src)
		return img, []remotedesktop.DisplayInfo{{Index: 0, Name: "Test", Width: 640, Height: 400, Primary: true}}, 0, "synthetic", nil
	}
}

// pipePair connects a helper Serve loop to a HelperClient in memory.
func pipePair(t *testing.T, d Desktop) *HelperClient {
	cr, hw := io.Pipe() // helper writes -> client reads
	hr, cw := io.Pipe() // client writes -> helper reads
	go func() { _ = Serve(context.Background(), hr, hw, d); _ = hw.Close() }()
	c := NewHelperClient(pipeRWC{Reader: cr, WriteCloser: cw, closeR: cr.Close})
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestHelperProtocolForwardsEveryCall(t *testing.T) {
	ui := &fakeUI{answer: userui.Accepted}
	c := pipePair(t, NewLocalWith(ui, synthetic(color.RGBA{10, 20, 30, 255})))
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}
	// Frames: full first, nothing when unchanged, full again after reset.
	f, err := c.Grab("s1", remotedesktop.GrabRequest{Quality: 60, Scale: 1})
	if err != nil || f == nil || !f.Header.Full || len(f.Data) != f.Header.Tiles[0].N {
		t.Fatalf("grab via helper: %+v %v", f, err)
	}
	if f2, err := c.Grab("s1", remotedesktop.GrabRequest{Quality: 60, Scale: 1}); err != nil || f2 != nil {
		t.Fatalf("unchanged must be nil, got %+v %v", f2, err)
	}
	c.ResetStream("s1")
	if f3, _ := c.Grab("s1", remotedesktop.GrabRequest{Quality: 60, Scale: 1}); f3 == nil || !f3.Header.Full {
		t.Fatal("reset ignored")
	}
	// Consent and banner, with the End button reaching the parent.
	a, err := c.Consent(context.Background(), userui.ConsentRequest{SessionID: "s1", Operator: "tech@corp.example", TimeoutSeconds: 30})
	if err != nil || a != userui.Accepted || ui.asked[0].Operator != "tech@corp.example" {
		t.Fatalf("consent via helper: %s %v", a, err)
	}
	ended := make(chan struct{})
	if err := c.ShowBanner(userui.BannerInfo{SessionID: "s1", Operator: "tech"}, func() { close(ended) }); err != nil {
		t.Fatal(err)
	}
	ui.pressEnd()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("banner End press did not reach the parent")
	}
	c.HideBanner("s1")
	if len(ui.hidden) != 1 || ui.hidden[0] != "s1" {
		t.Fatalf("hide: %v", ui.hidden)
	}
	if info := c.Info(); info.Mode != "session_helper" {
		t.Fatalf("info %+v", info)
	}
	// Errors cross the pipe as errors.
	if err := c.SetClipboardText(string(make([]byte, 0))); err != nil && err.Error() == "" {
		t.Fatal("empty error text")
	}
}

type countingLauncher struct {
	mu       sync.Mutex
	launches int
	ui       *fakeUI
	clients  []*HelperClient
	kills    []func()
}

func (l *countingLauncher) Describe() string { return "test" }

func (l *countingLauncher) Launch(context.Context) (io.ReadWriteCloser, func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.launches++
	cr, hw := io.Pipe()
	hr, cw := io.Pipe()
	go func() {
		_ = Serve(context.Background(), hr, hw, NewLocalWith(l.ui, synthetic(color.RGBA{1, 1, 1, 255})))
		_ = hw.Close()
	}()
	stop := func() { _ = cw.Close(); _ = hr.Close(); _ = hw.Close() }
	l.kills = append(l.kills, stop)
	return pipeRWC{Reader: cr, WriteCloser: cw, closeR: cr.Close}, stop, nil
}

func TestSupervisorRelaunchesAndShowsTheBannerAgain(t *testing.T) {
	ui := &fakeUI{}
	l := &countingLauncher{ui: ui}
	s := NewSupervisor(l, nil)
	defer s.Close()
	if err := s.ShowBanner(userui.BannerInfo{SessionID: "s9", Operator: "tech"}, func() {}); err != nil {
		t.Fatal(err)
	}
	if l.launches != 1 || len(ui.banners) != 1 {
		t.Fatalf("launches %d banners %d", l.launches, len(ui.banners))
	}
	// The user switched sessions: the service restarts the helper; the banner comes back by itself.
	s.Restart()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ui.mu.Lock()
		n := len(ui.banners)
		ui.mu.Unlock()
		if n == 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	ui.mu.Lock()
	n := len(ui.banners)
	ui.mu.Unlock()
	if n != 2 || l.launches != 2 {
		t.Fatalf("after restart: launches %d banners %d", l.launches, n)
	}
	// The helper died: the next call starts a new one (after the relaunch gap).
	l.mu.Lock()
	kill := l.kills[len(l.kills)-1]
	l.mu.Unlock()
	kill()
	time.Sleep(relaunchGap + 100*time.Millisecond)
	if _, err := s.Grab("s9", remotedesktop.GrabRequest{Quality: 60, Scale: 1}); err != nil {
		t.Fatalf("grab after helper death: %v", err)
	}
	if l.launches != 3 {
		t.Fatalf("launches %d, want 3", l.launches)
	}
	s.HideBanner("s9")
}

type failingLauncher struct{ n int }

func (f *failingLauncher) Describe() string { return "nowhere" }
func (f *failingLauncher) Launch(context.Context) (io.ReadWriteCloser, func(), error) {
	f.n++
	return nil, nil, errors.New("no user is signed in at the console")
}

func TestSupervisorReportsLaunchFailureWithoutHammering(t *testing.T) {
	f := &failingLauncher{}
	s := NewSupervisor(f, nil)
	for i := 0; i < 5; i++ {
		if _, err := s.Displays(); err == nil || err.Error() != "no user is signed in at the console" {
			t.Fatalf("expected the launch error, got %v", err)
		}
	}
	if f.n != 1 {
		t.Fatalf("launched %d times within the relaunch gap", f.n)
	}
	if info := s.Info(); info.Mode != "session_helper" || info.Backend == "" {
		t.Fatalf("info %+v", info)
	}
}

// A real helper process (this test binary) capturing this computer's real screen, on Windows with
// an interactive desktop. This is the same pipe protocol the agent service uses with the helper it
// starts in the user's session.
func TestRealHelperProcessCapturesTheScreen(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("real capture test runs on Windows")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	l := ExecLauncher{Path: exe, Env: append(os.Environ(), "NIGAFIY_TEST_HELPER=1")}
	s := NewSupervisor(l, nil)
	defer s.Close()
	displays, err := s.Displays()
	if err != nil || len(displays) == 0 {
		t.Fatalf("displays through the helper: %v %v", displays, err)
	}
	f, err := s.Grab("real", remotedesktop.GrabRequest{Quality: 50, Scale: 0.5})
	if err != nil {
		t.Skipf("this desktop cannot be captured (%v)", err)
	}
	if f == nil || !f.Header.Full || f.Header.W <= 0 || len(f.Data) < 100 {
		t.Fatalf("real frame via helper: %+v", f)
	}
	t.Logf("helper captured %dx%d (%d bytes) of display %d, mode %s", f.Header.W, f.Header.H, len(f.Data), f.Header.Display, f.Header.Mode)
}
