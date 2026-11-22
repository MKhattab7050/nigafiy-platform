//go:build windows

package userui

import (
	"context"
	"os"
	"testing"
	"time"
)

// These tests open real windows on this computer's desktop for a few seconds and press their
// buttons the way a person would (BM_CLICK). Opt in with NIGAFIY_UI_TEST=1.
func requireUITest(t *testing.T) {
	if os.Getenv("NIGAFIY_UI_TEST") != "1" {
		t.Skip("set NIGAFIY_UI_TEST=1 to open real consent/banner windows on this desktop")
	}
}

func TestWindowsConsentAllowDeclineTimeout(t *testing.T) {
	requireUITest(t)
	defer func() { testConsentShown = nil }()
	u := New()
	for _, c := range []struct {
		press int
		want  ConsentAnswer
	}{{idAllow, Accepted}, {idDecline, Denied}} {
		press := c.press
		testConsentShown = func(hwnd uintptr) {
			go func() { time.Sleep(500 * time.Millisecond); pressButton(hwnd, press) }()
		}
		got, err := u.Consent(context.Background(), ConsentRequest{SessionID: "s1", Operator: "tech@corp.example", Reason: "UI test", TimeoutSeconds: 30})
		if err != nil || got != c.want {
			t.Fatalf("press %d: %s %v", press, got, err)
		}
	}
	testConsentShown = nil
	start := time.Now()
	got, err := u.Consent(context.Background(), ConsentRequest{SessionID: "s2", Operator: "tech@corp.example", TimeoutSeconds: MinConsentTimeout})
	if err != nil || got != TimedOut || time.Since(start) < 9*time.Second {
		t.Fatalf("no answer must time out (= denied) after the timeout: %s %v after %v", got, err, time.Since(start))
	}
}

func TestWindowsBannerEndButtonAndHide(t *testing.T) {
	requireUITest(t)
	u := New().(*winUI)
	ended := make(chan struct{}, 1)
	if err := u.ShowBanner(BannerInfo{SessionID: "s1", Operator: "tech@corp.example", Reason: "UI test", Control: true}, func() { ended <- struct{}{} }); err != nil {
		t.Fatal(err)
	}
	first := u.banner
	// Alt+F4 / WM_CLOSE does not remove the banner.
	_, _, _ = pPostMessageW.Call(first.hwnd, wmClose, 0, 0)
	time.Sleep(300 * time.Millisecond)
	select {
	case <-first.done:
		t.Fatal("the banner closed on WM_CLOSE")
	default:
	}
	pressButton(first.hwnd, idEnd)
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("End session did not report")
	}
	select {
	case <-first.done:
	case <-time.After(2 * time.Second):
		t.Fatal("End session did not close the banner")
	}
	// A second banner is removed by HideBanner of its session only.
	if err := u.ShowBanner(BannerInfo{SessionID: "s2", Operator: "tech"}, nil); err != nil {
		t.Fatal(err)
	}
	b := u.banner
	u.HideBanner("other-session")
	if u.banner == nil {
		t.Fatal("HideBanner of another session removed this one")
	}
	u.HideBanner("s2")
	select {
	case <-b.done:
	case <-time.After(2 * time.Second):
		t.Fatal("HideBanner did not close the window")
	}
}
