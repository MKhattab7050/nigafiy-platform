package remotedesktop

import (
	"errors"
	"image"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/videoenc"
)

type fakeEnc struct {
	cfg     videoenc.Config
	name    string
	fail    bool
	noRate  bool
	encodes int
	keys    int
	closed  bool
}

func (f *fakeEnc) Encode(nv12 []byte, frame int64, key bool) ([]videoenc.Unit, error) {
	if f.fail {
		return nil, errors.New("device lost")
	}
	f.encodes++
	if key {
		f.keys++
		return []videoenc.Unit{{Data: []byte{0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x65, 2}, Key: true}}, nil
	}
	return []videoenc.Unit{{Data: []byte{0, 0, 0, 1, 0x41, 3}}}, nil
}
func (f *fakeEnc) SetBitrate(bps int) error {
	if f.noRate {
		return errors.New("no live bitrate")
	}
	f.cfg.Bitrate = bps
	return nil
}
func (f *fakeEnc) Name() string { return f.name }
func (f *fakeEnc) Close()       { f.closed = true }

type opened struct{ encs []*fakeEnc }

func (o *opened) opener(hwFails bool) videoenc.Opener {
	return func(cfg videoenc.Config) (videoenc.Encoder, error) {
		e := &fakeEnc{cfg: cfg, name: "hardware"}
		if cfg.Software {
			e.name = "software"
		} else {
			e.fail = hwFails
		}
		o.encs = append(o.encs, e)
		return e, nil
	}
}

func screen(w, h int, shade *uint8) CaptureSource {
	return func(int) (*image.RGBA, []DisplayInfo, int, string, error) {
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		for i := range img.Pix {
			img.Pix[i] = *shade
		}
		return img, []DisplayInfo{{Index: 0, Width: w, Height: h, Primary: true}}, 0, "test", nil
	}
}

func TestVideoSize(t *testing.T) {
	cases := []struct {
		sw, sh, me, w, h int
		s                float64
	}{
		{1920, 1080, 0, 1920, 1080, 1},
		{3840, 2160, 0, 1920, 1080, 1},
		{1366, 768, 0, 1024, 576, 0.75},
		{1001, 601, 0, 1000, 600, 1},
		{2560, 1440, 1280, 1280, 720, 1},
	}
	for _, c := range cases {
		if w, h := VideoSize(c.sw, c.sh, c.s, c.me); w != c.w || h != c.h {
			t.Errorf("VideoSize(%d,%d,%.2f,%d) = %dx%d, want %dx%d", c.sw, c.sh, c.s, c.me, w, h, c.w, c.h)
		}
	}
}

// The grabber skips an unchanged screen, keys a new encoder, and replaces a failing hardware
// encoder with the software one (reported once as Fallback).
func TestVideoGrabberRules(t *testing.T) {
	shade := uint8(10)
	o := &opened{}
	g := NewVideoGrabber(screen(640, 360, &shade), o.opener(false))
	defer g.Close()
	f, err := g.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000})
	if err != nil || f == nil || !f.Header.Key || f.Header.W != 640 || f.Header.Encoder != "hardware" {
		t.Fatalf("first grab %+v %v", f, err)
	}
	if f, _ := g.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000}); f != nil {
		t.Fatal("an unchanged screen was encoded again at once")
	}
	if f, _ := g.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000, Key: true}); f == nil || !f.Header.Key {
		t.Fatal("a key frame request on an unchanged screen gave no key frame")
	}
	shade = 99
	if f, _ := g.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000}); f == nil || f.Header.Key {
		t.Fatalf("a changed screen: %+v", f)
	}
	// A new bitrate is applied live (no new encoder) when the encoder supports it.
	if _, err := g.Grab(VideoRequest{FPS: 30, Bitrate: 1_000_000, Key: true}); err != nil || len(o.encs) != 1 || o.encs[0].cfg.Bitrate != 1_000_000 {
		t.Fatalf("bitrate change: %d encoders, %v", len(o.encs), err)
	}
	// A smaller scale means a new encoder at the new size, starting with a key frame.
	f, _ = g.Grab(VideoRequest{FPS: 30, Bitrate: 1_000_000, Scale: 0.5})
	if f == nil || !f.Header.Key || f.Header.W != 320 || len(o.encs) != 2 || !o.encs[0].closed {
		t.Fatalf("resize: %+v, %d encoders", f, len(o.encs))
	}
	// Old frames fade out: an idle screen is encoded again after VideoIdleInterval.
	g.lastAt = time.Now().Add(-2 * VideoIdleInterval)
	if f, _ := g.Grab(VideoRequest{FPS: 30, Bitrate: 1_000_000, Scale: 0.5}); f == nil {
		t.Fatal("idle screen never re-encoded")
	}

	// Hardware that fails mid-stream: software takes over, a key frame, Fallback says why.
	o2 := &opened{}
	g2 := NewVideoGrabber(screen(640, 360, &shade), o2.opener(true))
	defer g2.Close()
	f, err = g2.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000})
	if err != nil || f == nil || f.Header.Encoder != "software" || f.Header.Fallback != "device lost" || !f.Header.Key {
		t.Fatalf("fallback grab %+v %v", f, err)
	}
	shade++
	if f, _ := g2.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000}); f == nil || f.Header.Fallback != "" || f.Header.Encoder != "software" {
		t.Fatalf("after fallback %+v", f)
	}

	// An encoder without live bitrate control is reopened at the new rate.
	o3 := &opened{}
	g3 := NewVideoGrabber(screen(64, 64, &shade), func(cfg videoenc.Config) (videoenc.Encoder, error) {
		e := &fakeEnc{cfg: cfg, name: "fixed", noRate: true}
		o3.encs = append(o3.encs, e)
		return e, nil
	})
	defer g3.Close()
	_, _ = g3.Grab(VideoRequest{FPS: 30, Bitrate: 2_000_000})
	shade++
	f, _ = g3.Grab(VideoRequest{FPS: 30, Bitrate: 500_000})
	if len(o3.encs) != 2 || o3.encs[1].cfg.Bitrate != 500_000 || f == nil || !f.Header.Key {
		t.Fatalf("no-live-bitrate encoder: %d encoders, frame %+v", len(o3.encs), f)
	}
}

func TestVideoFrameDataRoundTrip(t *testing.T) {
	f := &VideoFrame{Units: []videoenc.Unit{{Data: []byte{0, 0, 1, 0x65, 1}}, {Data: []byte{0, 0, 1, 0x41, 2, 3}}}}
	f.Header.Units = []int{5, 6}
	units, err := SplitVideoData(f.Header, f.Data())
	if err != nil || len(units) != 2 || !units[0].Key || units[1].Key {
		t.Fatalf("%v %v", units, err)
	}
	if _, err := SplitVideoData(VideoHeader{Units: []int{5, 7}}, f.Data()); err == nil {
		t.Fatal("lengths that do not match were accepted")
	}
	if _, err := SplitVideoData(VideoHeader{Units: []int{-1}}, f.Data()); err == nil {
		t.Fatal("a negative length was accepted")
	}
}

// TestVideoGrabRealScreen captures this computer's screen and encodes it with the real Media
// Foundation encoder (opt-in: NIGAFIY_MF_TEST=1; Windows; no elevation).
func TestVideoGrabRealScreen(t *testing.T) {
	if os.Getenv("NIGAFIY_MF_TEST") != "1" || runtime.GOOS != "windows" {
		t.Skip("set NIGAFIY_MF_TEST=1 on Windows to capture and encode the real screen")
	}
	g := NewVideoGrabber(nil, nil)
	defer g.Close()
	var got *VideoFrame
	for i := 0; i < 30 && (got == nil || len(got.Units) == 0); i++ {
		f, err := g.Grab(VideoRequest{FPS: 30, Bitrate: 4_000_000, Key: i == 0})
		if err != nil {
			t.Fatalf("grab: %v", err)
		}
		if f != nil && len(f.Units) > 0 {
			got = f
		}
		time.Sleep(33 * time.Millisecond)
	}
	if got == nil {
		t.Fatal("no encoded picture after 30 grabs")
	}
	t.Logf("encoder %q, screen %dx%d -> %dx%d, capture %d ms, encode %d ms, %d bytes, NAL types %v",
		got.Header.Encoder, got.Header.SW, got.Header.SH, got.Header.W, got.Header.H, got.Header.CapMs, got.Header.EncMs, len(got.Data()), videoenc.NALTypes(got.Data()))
	if !videoenc.IsKey(got.Data()) {
		t.Fatalf("first encoded picture is not a key frame: %v", videoenc.NALTypes(got.Data()))
	}
}

// With prefetch the next screen is read during the grab, so reads overlap the encoding; a
// prefetched screen that waited too long (the stream paused) is read again, never shown old.
func TestVideoGrabberPrefetch(t *testing.T) {
	var reads atomic.Int32
	var shade atomic.Int32
	src := func(int) (*image.RGBA, []DisplayInfo, int, string, error) {
		reads.Add(1)
		img := image.NewRGBA(image.Rect(0, 0, 64, 64))
		for i := range img.Pix {
			img.Pix[i] = uint8(shade.Load())
		}
		return img, []DisplayInfo{{Index: 0, Width: 64, Height: 64, Primary: true}}, 0, "test", nil
	}
	o := &opened{}
	g := NewVideoGrabber(src, o.opener(false))
	g.EnablePrefetch()
	defer g.Close()
	if f, err := g.Grab(VideoRequest{FPS: 30}); err != nil || f == nil {
		t.Fatalf("first grab %+v %v", f, err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for reads.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if reads.Load() != 2 {
		t.Fatalf("the next screen was not read ahead: %d reads", reads.Load())
	}
	// The read-ahead screen is old: this grab reads again and sees the new picture.
	shade.Store(200)
	time.Sleep(prefetchMaxAge + 30*time.Millisecond)
	f, err := g.Grab(VideoRequest{FPS: 30})
	if err != nil || f == nil {
		t.Fatalf("a changed screen after a pause was not encoded: %+v %v", f, err)
	}
	if n := reads.Load(); n < 3 {
		t.Fatalf("an old read-ahead screen was used: %d reads", n)
	}
}
