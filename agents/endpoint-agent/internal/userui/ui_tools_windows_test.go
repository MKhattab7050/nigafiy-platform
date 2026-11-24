//go:build windows

package userui

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/jpeg"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/remotedesktop"
)

// Real windows on this desktop (opt-in, NIGAFIY_UI_TEST=1): the privacy screen covers the monitors
// for the person but the agent's own screen capture still sees the desktop; the question, the chat
// and the overlay open and close; the banner registers Ctrl+Alt+Shift+E.

func TestWindowsPrivacyScreenHiddenFromCapture(t *testing.T) {
	requireUITest(t)
	u := New().(*winUI)
	info := BannerInfo{SessionID: "p1", Operator: "tech@corp.example", Reason: "privacy test"}
	res, err := u.PrivacyScreen("p1", true, info)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = u.PrivacyScreen("p1", false, info) }()
	if res.Monitors < 1 {
		t.Fatalf("%+v", res)
	}
	t.Logf("privacy screen: %+v", res)
	time.Sleep(700 * time.Millisecond)
	frame, err := remotedesktop.CaptureFrame(remotedesktop.CaptureOptions{Quality: 90, Scale: 1, FullFrame: true})
	if err != nil {
		t.Fatal(err)
	}
	img, err := decodeJPEGBase64(frame.JPEGBase64)
	if err != nil {
		t.Fatal(err)
	}
	// The privacy page is uniformly #0f2a43 except its text; the captured desktop must not be.
	b := img.Bounds()
	same := 0
	samples := 0
	for y := b.Min.Y + 5; y < b.Max.Y; y += b.Dy() / 12 {
		for x := b.Min.X + 5; x < b.Max.X; x += b.Dx() / 12 {
			r, g, bl, _ := img.At(x, y).RGBA()
			samples++
			if near(r>>8, 0x0f) && near(g>>8, 0x2a) && near(bl>>8, 0x43) {
				same++
			}
		}
	}
	if same > samples*3/4 {
		t.Fatalf("the capture shows the privacy screen (%d of %d samples): the operator would not see the desktop", same, samples)
	}
}

func near(v uint32, want uint32) bool { return v+6 >= want && v <= want+6 }

func TestWindowsAskYesAndText(t *testing.T) {
	requireUITest(t)
	defer func() { testAskShown = nil }()
	u := New().(*winUI)
	testAskShown = func(hwnd uintptr) { go func() { time.Sleep(400 * time.Millisecond); pressButton(hwnd, idAskYes) }() }
	a, err := u.Ask(context.Background(), AskRequest{SessionID: "a1", Operator: "tech@corp.example", Text: "May I restart?", Kind: "yes_no"})
	if err != nil || a.Answer != "yes" {
		t.Fatalf("%+v %v", a, err)
	}
	testAskShown = nil
	a, err = u.Ask(context.Background(), AskRequest{SessionID: "a1", Operator: "tech@corp.example", Text: "Closes itself", TimeoutSeconds: 10})
	if err != nil || a.Answer != "timeout" {
		t.Fatalf("%+v %v", a, err)
	}
}

func TestWindowsChatAndOverlay(t *testing.T) {
	requireUITest(t)
	u := New().(*winUI)
	if err := u.Chat("c1", ChatLine{From: "tech@corp.example", Text: "Hello, I am looking at the printer settings."}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if err := u.Chat("c1", ChatLine{From: "tech@corp.example", Text: "Second message."}, nil); err != nil {
		t.Fatal(err)
	}
	disp := DisplayRect{X: 0, Y: 0, W: metric(smCxScreen), H: metric(smCyScreen)}
	if err := u.Overlay("c1", OverlayOp{Op: "stroke", Display: disp, Points: [][2]float64{{0.3, 0.3}, {0.6, 0.4}, {0.7, 0.7}}}); err != nil {
		t.Fatal(err)
	}
	if err := u.Overlay("c1", OverlayOp{Op: "pointer", Display: disp, X: 0.5, Y: 0.5}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	u.CloseOverlay("c1")
	u.CloseChat("c1")
	if u.tools.chat != nil || u.tools.overlay != nil {
		t.Fatal("tool windows still open after close")
	}
}

func TestWindowsBannerRegistersEndHotkey(t *testing.T) {
	requireUITest(t)
	u := New().(*winUI)
	ended := make(chan struct{}, 1)
	if err := u.ShowBanner(BannerInfo{SessionID: "h1", Operator: "tech@corp.example", Recording: true}, func() { ended <- struct{}{} }); err != nil {
		t.Fatal(err)
	}
	if got := u.EndHotkey(); got != "registered" {
		t.Fatalf("hotkey %s", got)
	}
	// What Windows sends when the person presses Ctrl+Alt+Shift+E.
	_, _, _ = pPostMessageW.Call(u.banner.hwnd, wmHotkey, hotkeyEnd, 0)
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("Ctrl+Alt+Shift+E did not end the session")
	}
	// Showing a new banner after that re-registers the combination (the old window released it).
	if err := u.ShowBanner(BannerInfo{SessionID: "h2", Operator: "tech@corp.example"}, nil); err != nil {
		t.Fatal(err)
	}
	defer u.HideBanner("h2")
	if got := u.EndHotkey(); got != "registered" {
		t.Fatalf("hotkey after a new banner: %s", got)
	}
}

func decodeJPEGBase64(s string) (image.Image, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	return jpeg.Decode(bytes.NewReader(raw))
}
