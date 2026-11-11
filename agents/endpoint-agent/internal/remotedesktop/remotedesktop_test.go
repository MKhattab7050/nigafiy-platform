package remotedesktop

import (
	"encoding/base64"
	"image"
	"testing"
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

func TestResizeNearest(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 640, 360))
	dst := resizeNearest(src, 320, 180)
	if dst.Bounds().Dx() != 320 || dst.Bounds().Dy() != 180 {
		t.Fatalf("unexpected resized dimensions: %v", dst.Bounds())
	}
}
