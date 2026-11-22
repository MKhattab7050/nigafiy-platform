package remotedesktop

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"testing"
	"time"
)

func fill(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{c}, image.Point{}, draw.Src)
	return img
}

var testDisplays = []DisplayInfo{{Index: 0, Name: "Primary", Width: 640, Height: 400, Primary: true}}

func TestEncoderSendsFullThenOnlyChangedTilesThenNothing(t *testing.T) {
	e := NewEncoder(nil)
	now := time.Now()
	req := GrabRequest{Quality: 70, Scale: 1}
	base := fill(640, 400, color.RGBA{20, 40, 60, 255})

	f, err := e.encode(base, req, testDisplays, 0, "test", 1, now)
	if err != nil || f == nil {
		t.Fatalf("first frame: %v %v", f, err)
	}
	if !f.Header.Full || len(f.Header.Tiles) != 1 || f.Header.Tiles[0].W != 640 || f.Header.Seq != 1 || len(f.Header.Displays) != 1 {
		t.Fatalf("first frame must be one full tile with displays: %+v", f.Header)
	}

	// Identical picture: nothing is sent.
	same := fill(640, 400, color.RGBA{20, 40, 60, 255})
	if f, err := e.encode(same, req, testDisplays, 0, "test", 1, now.Add(time.Second)); err != nil || f != nil {
		t.Fatalf("unchanged screen must send nothing, got %+v %v", f, err)
	}

	// Change two adjacent tiles in one row and one tile in another row.
	changed := fill(640, 400, color.RGBA{20, 40, 60, 255})
	draw.Draw(changed, image.Rect(70, 10, 180, 20), &image.Uniform{color.RGBA{255, 0, 0, 255}}, image.Point{}, draw.Src)
	draw.Draw(changed, image.Rect(600, 390, 610, 400), &image.Uniform{color.RGBA{0, 255, 0, 255}}, image.Point{}, draw.Src)
	f, err = e.encode(changed, req, testDisplays, 0, "test", 1, now.Add(2*time.Second))
	if err != nil || f == nil {
		t.Fatalf("changed frame: %v", err)
	}
	if f.Header.Full || f.Header.Seq != 2 || f.Header.Displays != nil {
		t.Fatalf("expected a delta without displays: %+v", f.Header)
	}
	want := []image.Rectangle{image.Rect(64, 0, 192, 64), image.Rect(576, 384, 640, 400)}
	if len(f.Header.Tiles) != len(want) {
		t.Fatalf("tiles %+v, want %v", f.Header.Tiles, want)
	}
	off := 0
	for i, tl := range f.Header.Tiles {
		if image.Rect(tl.X, tl.Y, tl.X+tl.W, tl.Y+tl.H) != want[i] {
			t.Fatalf("tile %d = %+v, want %v", i, tl, want[i])
		}
		img, err := jpeg.Decode(bytes.NewReader(f.Data[off : off+tl.N]))
		if err != nil || img.Bounds().Dx() != tl.W || img.Bounds().Dy() != tl.H {
			t.Fatalf("tile %d is not a %dx%d JPEG: %v", i, tl.W, tl.H, err)
		}
		off += tl.N
	}
	if f.Header.ChangedPct <= 0 || f.Header.ChangedPct >= 50 {
		t.Fatalf("changed_pct %v", f.Header.ChangedPct)
	}

	// The packet round-trips.
	h, data, err := ParsePacket(f.Packet())
	if err != nil || h.Seq != 2 || len(data) != len(f.Data) {
		t.Fatalf("packet round trip: %+v %v", h, err)
	}

	// A quality change is a new picture: full frame.
	f, _ = e.encode(changed, GrabRequest{Quality: 50, Scale: 1}, testDisplays, 0, "test", 1, now.Add(3*time.Second))
	if f == nil || !f.Header.Full {
		t.Fatal("a quality change must send a full frame")
	}
	// Most of the screen changed: one full frame instead of many tiles.
	f, _ = e.encode(fill(640, 400, color.RGBA{1, 2, 3, 255}), GrabRequest{Quality: 50, Scale: 1}, testDisplays, 0, "test", 1, now.Add(4*time.Second))
	if f == nil || !f.Header.Full || len(f.Header.Tiles) != 1 {
		t.Fatal("a mostly changed screen must send one full frame")
	}
	// An unchanged screen is still refreshed after MaxUnchangedInterval.
	f, _ = e.encode(fill(640, 400, color.RGBA{1, 2, 3, 255}), GrabRequest{Quality: 50, Scale: 1}, testDisplays, 0, "test", 1, now.Add(4*time.Second+MaxUnchangedInterval))
	if f == nil || !f.Header.Full {
		t.Fatal("unchanged screen must be refreshed after MaxUnchangedInterval")
	}
	// Full requested (viewer joined) and Reset.
	if f, _ := e.encode(fill(640, 400, color.RGBA{1, 2, 3, 255}), GrabRequest{Quality: 50, Scale: 1, Full: true}, testDisplays, 0, "test", 1, now.Add(5*time.Second+MaxUnchangedInterval)); f == nil || !f.Header.Full {
		t.Fatal("Full request ignored")
	}
	e.Reset()
	if f, _ := e.encode(fill(640, 400, color.RGBA{1, 2, 3, 255}), GrabRequest{Quality: 50, Scale: 1}, testDisplays, 0, "test", 1, now.Add(6*time.Second+MaxUnchangedInterval)); f == nil || !f.Header.Full {
		t.Fatal("Reset ignored")
	}
}

func TestEncoderScalesBeforeTiling(t *testing.T) {
	e := NewEncoder(nil)
	f, err := e.encode(fill(1920, 1080, color.RGBA{9, 9, 9, 255}), GrabRequest{Quality: 60, Scale: 0.5}, testDisplays, 0, "test", 1, time.Now())
	if err != nil || f.Header.W != 960 || f.Header.H != 540 || f.Header.SW != 1920 {
		t.Fatalf("scaled frame %+v %v", f.Header, err)
	}
}

func TestMergeTilesAndBadPackets(t *testing.T) {
	// cols = 4: indexes 1,2,3 (row 0) and 4 (row 1) must not merge across rows.
	got := mergeTiles([]int{1, 2, 3, 4, 6}, 4, 250, 130)
	want := []image.Rectangle{image.Rect(64, 0, 250, 64), image.Rect(0, 64, 64, 128), image.Rect(128, 64, 192, 128)}
	if len(got) != len(want) {
		t.Fatalf("mergeTiles = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mergeTiles[%d] = %v, want %v", i, got[i], want[i])
		}
	}
	for _, bad := range [][]byte{nil, []byte("xx"), {'N', 1, 0, 0, 0, 9, '{'}, append([]byte{'N', 1, 0, 0, 0, 2}, "{}x"...)} {
		if _, _, err := ParsePacket(bad); err == nil {
			t.Fatalf("bad packet %q accepted", bad)
		}
	}
}
