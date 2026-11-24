package remotedesktop

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"
)

func noisy(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = uint8(i*7), uint8(i*13>>3), uint8(i>>5), 255
	}
	return img
}

// Each colour depth is a real encoding difference the toolbar's kbit/s then shows: grey frames are
// one-component JPEGs and smaller than full colour.
func TestColourDepthChangesTheEncoding(t *testing.T) {
	sizes := map[int]int{}
	for _, d := range []int{Depth24, Depth16, Depth8} {
		e := NewEncoder(nil)
		f, err := e.encode(noisy(320, 256), GrabRequest{Quality: 80, Scale: 1, Depth: d}, testDisplays, 0, "test", 1, time.Now())
		if err != nil || f == nil {
			t.Fatal(err)
		}
		if f.Header.Depth != d {
			t.Fatalf("depth %d reported as %d", d, f.Header.Depth)
		}
		img, err := jpeg.Decode(bytes.NewReader(f.Data))
		if err != nil {
			t.Fatal(err)
		}
		if _, grey := img.(*image.Gray); grey != (d == Depth8) {
			t.Fatalf("depth %d decoded as %T", d, img)
		}
		sizes[d] = len(f.Data)
	}
	if sizes[Depth8] >= sizes[Depth24] {
		t.Fatalf("grey %d bytes is not smaller than full colour %d", sizes[Depth8], sizes[Depth24])
	}
	if NormalizeDepth(12) != Depth24 {
		t.Fatal("unknown depth not mapped to 24")
	}
}

// Changing the depth sends a full frame (a new picture key), never tiles of the old depth.
func TestDepthChangeSendsFullFrame(t *testing.T) {
	e := NewEncoder(nil)
	now := time.Now()
	img := noisy(320, 256)
	if f, _ := e.encode(img, GrabRequest{Quality: 70, Scale: 1}, testDisplays, 0, "t", 1, now); f == nil || !f.Header.Full {
		t.Fatal("first frame")
	}
	f, _ := e.encode(noisy(320, 256), GrabRequest{Quality: 70, Scale: 1, Depth: Depth8}, testDisplays, 0, "t", 1, now.Add(time.Second))
	if f == nil || !f.Header.Full {
		t.Fatal("depth change did not send a full frame")
	}
}

func TestBlendCursor(t *testing.T) {
	img := fill(10, 10, color.RGBA{0, 0, 0, 255})
	cur := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	cur.SetNRGBA(0, 0, color.NRGBA{255, 255, 255, 255})
	cur.SetNRGBA(1, 0, color.NRGBA{255, 255, 255, 128})
	BlendCursor(img, cur, 9, 0) // half outside: clipped, no panic
	BlendCursor(img, cur, 3, 4)
	if c := img.RGBAAt(3, 4); c.R != 255 {
		t.Fatalf("opaque pixel %v", c)
	}
	if c := img.RGBAAt(4, 4); c.R < 120 || c.R > 135 {
		t.Fatalf("half-transparent pixel %v", c)
	}
	if c := img.RGBAAt(3, 5); c.R != 0 {
		t.Fatalf("transparent pixel drew %v", c)
	}
}
