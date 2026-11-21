package remotedesktop

import (
	"encoding/base64"
	"image"
	"image/color"
	"testing"
	"time"
)

func TestEnumerateAndCaptureScreen(t *testing.T) {
	displays, err := EnumerateDisplays()
	if err != nil {
		t.Skipf("display enumeration unavailable in headless environment: %v", err)
	}
	if len(displays) == 0 {
		t.Fatal("expected at least one display")
	}

	frame, err := CaptureFrame(CaptureOptions{
		DisplayIndex: 0,
		Quality:      70,
		Scale:        0.5,
	})
	if err != nil {
		t.Skipf("screen capture unavailable in non-interactive session: %v", err)
	}
	if frame.Width <= 0 || frame.Height <= 0 || frame.ByteLength == 0 {
		t.Fatalf("expected valid captured frame, got %+v", frame)
	}
	raw, err := base64.StdEncoding.DecodeString(frame.JPEGBase64)
	if err != nil || len(raw) < 2 || raw[0] != 0xFF || raw[1] != 0xD8 {
		t.Fatalf("expected valid JPEG magic bytes 0xFFD8, got err=%v len=%d", err, len(raw))
	}
	t.Logf("Captured real screen frame: %dx%d (from %dx%d, mode=%s) in %d ms (%d bytes JPEG)",
		frame.Width, frame.Height, frame.SourceWidth, frame.SourceHeight, frame.CaptureMode, frame.CaptureMs, frame.ByteLength)
}

func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestAreaWeightsSumToOne(t *testing.T) {
	for _, c := range [][2]int{{640, 320}, {1920, 1440}, {1366, 1024}, {1000, 333}, {7, 3}, {5, 5}} {
		for d, spans := range areaWeights(c[0], c[1]) {
			var sum uint32
			for _, sp := range spans {
				if sp.index < 0 || sp.index >= c[0] {
					t.Fatalf("%v: dst %d uses source %d out of range", c, d, sp.index)
				}
				sum += sp.weight
			}
			if sum != 65536 {
				t.Fatalf("%v: weights of dst %d sum to %d, want 65536", c, d, sum)
			}
		}
	}
}

func TestResizeAreaDimensionsAndSolidColour(t *testing.T) {
	src := solid(1366, 768, color.RGBA{10, 200, 77, 255})
	dst := resizeArea(src, 1024, 576) // 0.75, fractional coverage
	if dst.Bounds().Dx() != 1024 || dst.Bounds().Dy() != 576 {
		t.Fatalf("unexpected resized dimensions: %v", dst.Bounds())
	}
	for _, p := range [][2]int{{0, 0}, {511, 300}, {1023, 575}} {
		if got := dst.RGBAAt(p[0], p[1]); got != (color.RGBA{10, 200, 77, 255}) {
			t.Fatalf("a solid colour must stay exact, got %v at %v", got, p)
		}
	}
}

func TestResizeAreaAveragesInsteadOfDropping(t *testing.T) {
	// One-pixel black/white vertical stripes: nearest-neighbour at 1/2 keeps only every other
	// column (all black or all white); area averaging gives the true mean grey.
	src := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < 360; y++ {
		for x := 0; x < 640; x++ {
			v := uint8(0)
			if x%2 == 1 {
				v = 255
			}
			src.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	dst := resizeArea(src, 320, 180)
	for _, x := range []int{0, 1, 160, 319} {
		got := dst.RGBAAt(x, 90)
		if got.R < 127 || got.R > 128 || got.R != got.G || got.G != got.B || got.A != 255 {
			t.Fatalf("expected mean grey 127/128 at x=%d, got %v", x, got)
		}
	}

	// A thin 1-pixel line at 1/3 scale contributes its share instead of disappearing.
	line := solid(900, 300, color.RGBA{0, 0, 0, 255})
	for y := 0; y < 300; y++ {
		line.SetRGBA(451, y, color.RGBA{255, 255, 255, 255})
	}
	small := resizeArea(line, 300, 100)
	if got := small.RGBAAt(150, 50).R; got < 80 || got > 90 {
		t.Fatalf("a 1-pixel white line should average to about 85 in its 3-pixel cell, got %d", got)
	}
}

func TestEncodeFrameSkipsUnchangedScreens(t *testing.T) {
	state := newFrameState()
	displays := []DisplayInfo{{Index: 0, Name: "test", Width: 800, Height: 600, Primary: true}}
	opts := normalizeOptions(CaptureOptions{Quality: 60, Scale: 0.5})
	img := solid(800, 600, color.RGBA{30, 60, 90, 255})
	t0 := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)

	first, err := encodeFrame(state, img, opts, displays, 0, "test", t0, t0)
	if err != nil || first.Unchanged || first.JPEGBase64 == "" || first.ByteLength == 0 || first.Width != 400 || first.Height != 300 {
		t.Fatalf("first frame must be a full image, got %+v err=%v", first, err)
	}
	raw, err := base64.StdEncoding.DecodeString(first.JPEGBase64)
	if err != nil || raw[0] != 0xFF || raw[1] != 0xD8 {
		t.Fatalf("expected JPEG magic bytes, err=%v", err)
	}

	same, _ := encodeFrame(state, img, opts, displays, 0, "test", t0, t0.Add(time.Second))
	if !same.Unchanged || same.JPEGBase64 != "" || same.ByteLength != 0 || same.Width != 400 {
		t.Fatalf("identical screen must be skipped, got unchanged=%v bytes=%d", same.Unchanged, same.ByteLength)
	}

	full := opts
	full.FullFrame = true
	forced, _ := encodeFrame(state, img, full, displays, 0, "test", t0, t0.Add(2*time.Second))
	if forced.Unchanged || forced.JPEGBase64 == "" {
		t.Fatal("full_frame must always send the image")
	}

	img.SetRGBA(10, 10, color.RGBA{255, 0, 0, 255})
	changed, _ := encodeFrame(state, img, opts, displays, 0, "test", t0, t0.Add(3*time.Second))
	if changed.Unchanged {
		t.Fatal("a changed pixel must send a new image")
	}

	other := opts
	other.Quality = 80
	if q, _ := encodeFrame(state, img, other, displays, 0, "test", t0, t0.Add(4*time.Second)); q.Unchanged {
		t.Fatal("a different quality must send a new image")
	}
	if d, _ := encodeFrame(state, img, other, displays, 1, "test", t0, t0.Add(5*time.Second)); d.Unchanged {
		t.Fatal("a different display must send a new image")
	}

	// Even an unchanged screen is resent after MaxUnchangedInterval.
	if s, _ := encodeFrame(state, img, other, displays, 1, "test", t0, t0.Add(6*time.Second)); !s.Unchanged {
		t.Fatal("expected a skip right after a full frame")
	}
	if s, _ := encodeFrame(state, img, other, displays, 1, "test", t0, t0.Add(5*time.Second+MaxUnchangedInterval)); s.Unchanged {
		t.Fatal("an unchanged screen must be resent after MaxUnchangedInterval")
	}
}

func BenchmarkResizeArea1080p(b *testing.B) {
	src := solid(1920, 1080, color.RGBA{1, 2, 3, 255})
	for i := 0; i < b.N; i++ {
		resizeArea(src, 1440, 810)
	}
}
