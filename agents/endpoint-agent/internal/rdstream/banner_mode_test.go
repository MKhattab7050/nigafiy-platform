package rdstream

import (
	"context"
	"strings"
	"testing"

	"github.com/nigafiy/agent/internal/userui"
)

// The fleet group's banner_mode (migration 051): an unattended session on a company-managed
// computer may draw a minimized banner or none. Fleet still ends it (rd_session_close).
func TestBannerOffDrawsNothingAndFleetStillEndsTheSession(t *testing.T) {
	ui := &fakeUI{}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
	res := m.Open(context.Background(), OpenRequest{SessionID: "off1", Operator: "tech@example.com", BannerMode: BannerOff})
	if res.Consent != "not_required" || res.Banner != BannerOff || m.Active() != "off1" {
		t.Fatalf("%+v active=%q", res, m.Active())
	}
	// An update (another operator joins, recording starts) redraws nothing either.
	if !m.Update(UpdateRequest{SessionID: "off1", Operators: []string{"tech@example.com", "second@example.com"}, Recording: true}) {
		t.Fatal("update refused")
	}
	ui.mu.Lock()
	shown := len(ui.shown)
	ui.mu.Unlock()
	if shown != 0 {
		t.Fatalf("banner drawn %d time(s) with banner_mode off", shown)
	}
	if !m.Close("off1", "operator") || m.Active() != "" {
		t.Fatal("Fleet could not end a session with the banner off")
	}
}

func TestBannerMinimizedDrawsTheCornerBox(t *testing.T) {
	ui := &fakeUI{}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
	res := m.Open(context.Background(), OpenRequest{SessionID: "min1", Operator: "tech@example.com", BannerMode: BannerMinimized, Recording: true})
	if res.Banner != BannerMinimized {
		t.Fatalf("%+v", res)
	}
	ui.mu.Lock()
	defer ui.mu.Unlock()
	if len(ui.shown) != 1 || !ui.shown[0].Minimized || !ui.shown[0].Compact() {
		t.Fatalf("banners %+v", ui.shown)
	}
	text := userui.BannerText(ui.shown[0])
	if !strings.Contains(text, "tech@example.com") || !strings.Contains(text, "REC") {
		t.Fatalf("corner box text %q", text)
	}
	if ui.onEnd == nil {
		t.Fatal("the corner box has no End session")
	}
}

// A session the person was asked about always shows the full banner, whatever the payload says.
func TestBannerModeIgnoredWhenThePersonIsAsked(t *testing.T) {
	for _, req := range []OpenRequest{
		{SessionID: "a1", ConsentRequired: true, BannerMode: BannerOff},
		{SessionID: "a2", RefuseWindowSeconds: 15, BannerMode: BannerOff},
		{SessionID: "a3", ConsentRequired: true, BannerMode: BannerMinimized},
		{SessionID: "a4", BannerMode: "something-else"},
	} {
		ui := &fakeUI{answer: userui.Accepted}
		m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
		res := m.Open(context.Background(), req)
		ui.mu.Lock()
		n := len(ui.shown)
		mini := n > 0 && ui.shown[0].Minimized
		ui.mu.Unlock()
		if res.Banner != BannerShown || n != 1 || mini {
			t.Fatalf("%s: %+v banners=%d minimized=%v", req.SessionID, res, n, mini)
		}
		m.Close("", "test")
	}
}

// Open shells keep their full lines: a minimized banner with a shell is drawn in full.
func TestMinimizedBannerWithAShellIsNotCompact(t *testing.T) {
	i := userui.BannerInfo{SessionID: "s", Operator: "op", Minimized: true, Shells: []userui.ShellLine{{Operator: "op", Reason: "fix"}}}
	if i.Compact() {
		t.Fatal("a banner naming a shell must not be the corner box")
	}
	if !strings.Contains(userui.BannerText(i), "Shell open by op") {
		t.Fatal("shell line missing")
	}
}
