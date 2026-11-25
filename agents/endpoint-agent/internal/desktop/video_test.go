package desktop

import (
	"image"
	"testing"

	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/videoenc"
)

type stubEnc struct{ cfg videoenc.Config }

func (s *stubEnc) Encode([]byte, int64, bool) ([]videoenc.Unit, error) {
	return []videoenc.Unit{{Data: []byte{0, 0, 0, 1, 0x65, 1}, Key: true}}, nil
}
func (s *stubEnc) SetBitrate(int) error { return nil }
func (s *stubEnc) Name() string         { return "stub" }
func (s *stubEnc) Close()               {}

// The real agent wraps its desktop in a BannerMux: the video source must pass through it, or the
// session manager would never offer WebRTC.
func TestBannerMuxPassesVideoThrough(t *testing.T) {
	l := NewLocalWith(nil, func(int) (*image.RGBA, []remotedesktop.DisplayInfo, int, string, error) {
		return image.NewRGBA(image.Rect(0, 0, 320, 200)), []remotedesktop.DisplayInfo{{Width: 320, Height: 200}}, 0, "test", nil
	})
	l.SetVideoOpener(func(cfg videoenc.Config) (videoenc.Encoder, error) { return &stubEnc{cfg: cfg}, nil })
	var d Desktop = NewBannerMux(l)
	v, ok := d.(Video)
	if !ok {
		t.Fatal("BannerMux does not implement Video")
	}
	if c := v.VideoCapability(); !c.Supported || c.Encoder != "stub" {
		t.Fatalf("capability %+v", c)
	}
	f, err := v.GrabVideo("s1", remotedesktop.VideoRequest{FPS: 30, Bitrate: 1_000_000})
	if err != nil || f == nil || f.Header.W != 320 || f.Header.Encoder != "stub" {
		t.Fatalf("grab %+v %v", f, err)
	}
	v.EndVideo("s1")

	// A desktop without a video source says so instead of failing.
	m := NewBannerMux(noVideo{l})
	if c := m.VideoCapability(); c.Supported || c.Reason == "" {
		t.Fatalf("capability without a source %+v", c)
	}
	if _, err := m.GrabVideo("s1", remotedesktop.VideoRequest{}); err == nil {
		t.Fatal("grab without a source succeeded")
	}
}

// noVideo hides Local's video methods (only Desktop's are promoted from the interface field).
type noVideo struct{ Desktop }
