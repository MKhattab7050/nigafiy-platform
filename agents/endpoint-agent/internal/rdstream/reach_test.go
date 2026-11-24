package rdstream

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/nigafiy/agent/internal/desktop"
)

// targetDesktop is a desktop that can move its helper (what the service's supervisor does).
type targetDesktop struct {
	*toolDesktop
	mu      sync.Mutex
	targets []string
}

func (d *targetDesktop) TargetSession(s string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.targets = append(d.targets, s)
	return nil
}

func TestAnotherWindowsSessionNeedsTheService(t *testing.T) {
	ui := &fakeUI{}
	d := &toolDesktop{fakeDesktop: newFakeDesktop(ui)}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: d})
	res := m.Open(context.Background(), OpenRequest{SessionID: "s1", Operator: "it", UserSession: "3"})
	if res.Consent != "unavailable" || !strings.HasPrefix(res.ConsentError, "user_session_needs_service") || res.Banner != "not_shown" {
		t.Fatalf("result %+v", res)
	}
	// The console's session needs nothing special.
	if res := m.Open(context.Background(), OpenRequest{SessionID: "s2", Operator: "it"}); res.Banner != "shown" {
		t.Fatalf("console session: %+v", res)
	}
	m.Close("", "test")
}

func TestTheHelperMovesToTheChosenSessionAndBackAfterwards(t *testing.T) {
	ui := &fakeUI{}
	d := &targetDesktop{toolDesktop: &toolDesktop{fakeDesktop: newFakeDesktop(ui)}}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: d})
	if res := m.Open(context.Background(), OpenRequest{SessionID: "s1", Operator: "it", UserSession: "winlogon"}); res.Banner != "shown" {
		t.Fatalf("open: %+v", res)
	}
	// The banner is shown on the sign-in screen too: nothing about the target hides it.
	if len(ui.shown) == 0 {
		t.Fatal("no banner")
	}
	m.Close("s1", "operator")
	d.mu.Lock()
	defer d.mu.Unlock()
	if strings.Join(d.targets, ",") != "winlogon," {
		t.Fatalf("targets %q", d.targets)
	}
}

func TestRequestHelpFromTheTrayReachesTheAgentWithoutASession(t *testing.T) {
	ui := &fakeUI{}
	d := &toolDesktop{fakeDesktop: newFakeDesktop(ui)}
	var got []string
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: d, OnHelpRequest: func(note, user string) { got = append(got, note+"|"+user) }})
	d.emit(desktop.ToolEvent{Kind: "help_request", Text: "Printer jammed", User: `CORP\sami`}, nil)
	d.emit(desktop.ToolEvent{Kind: "help_request", Text: ""}, nil)
	_ = m
	if len(got) != 1 || got[0] != `Printer jammed|CORP\sami` {
		t.Fatalf("got %q", got)
	}
}
