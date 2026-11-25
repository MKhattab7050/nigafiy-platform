package videoenc

import (
	"image"
	"os"
	"testing"
)

// TestMediaFoundationEncodes runs the real Media Foundation encoder on this computer (opt-in:
// NIGAFIY_MF_TEST=1). It needs no elevation. The real captured screen is covered by
// remotedesktop's TestVideoGrabRealScreen.
func TestMediaFoundationEncodes(t *testing.T) {
	if os.Getenv("NIGAFIY_MF_TEST") != "1" {
		t.Skip("set NIGAFIY_MF_TEST=1 to run the real Media Foundation encoder")
	}
	t.Run("first choice", func(t *testing.T) { encodeSome(t, false) })
	t.Run("software", func(t *testing.T) { encodeSome(t, true) })
}

func encodeSome(t *testing.T, software bool) {
	enc, err := Open(Config{Width: 640, Height: 360, FPS: 30, Bitrate: 1_500_000, Software: software})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer enc.Close()
	t.Logf("encoder: %s", enc.Name())
	img := image.NewRGBA(image.Rect(0, 0, 640, 360))
	var got []Unit
	for f := int64(0); f < 30 && len(got) < 3; f++ {
		for i := range img.Pix {
			img.Pix[i] = byte(int(f)*7 + i%251)
		}
		u, err := enc.Encode(ToNV12(img, 640, 360, nil), f, f == 0)
		if err != nil {
			t.Fatalf("encode frame %d: %v", f, err)
		}
		got = append(got, u...)
	}
	if len(got) == 0 {
		t.Fatal("no output after 30 frames")
	}
	if !got[0].Key {
		t.Fatalf("first unit is not a key frame: NAL types %v", NALTypes(got[0].Data))
	}
	t.Logf("first unit %d bytes, NAL types %v; %d units", len(got[0].Data), NALTypes(got[0].Data), len(got))
	if err := enc.SetBitrate(800_000); err != nil {
		t.Logf("SetBitrate: %v (the caller reopens the encoder instead)", err)
	}
}
