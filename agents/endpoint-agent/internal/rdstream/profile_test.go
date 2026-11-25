package rdstream

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/userui"
)

// Fleet Pro permission profiles on the agent side: the agent enforces the flags it receives
// (defence in depth behind the server), lists them on the banner, runs the unattended refuse
// window, and shows the banner whatever the profile says.

// recordingUI answers consent with a fixed answer and remembers the requests.
type recordingUI struct {
	fakeUI
	reqMu sync.Mutex
	reqs  []userui.ConsentRequest
}

func (r *recordingUI) Consent(ctx context.Context, req userui.ConsentRequest) (userui.ConsentAnswer, error) {
	r.reqMu.Lock()
	r.reqs = append(r.reqs, req)
	r.reqMu.Unlock()
	return r.fakeUI.Consent(ctx, req)
}

func TestBannerShowsForEveryProfileAndListsThePermissions(t *testing.T) {
	sets := []*userui.Permissions{
		nil,
		{},
		{View: true},
		{View: true, Control: true, ClipboardIn: true, ClipboardOut: true, Files: true, Audio: true, Record: true, Restart: true, PrivacyScreen: true, BlockInput: true, Shell: true},
	}
	for i, p := range sets {
		for _, refuse := range []int{0, 15} {
			ui := &recordingUI{fakeUI: fakeUI{answer: userui.TimedOut}}
			m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
			res := m.Open(context.Background(), OpenRequest{SessionID: "s", Operator: "tech", Reason: "why", Control: true, Permissions: p, Profile: "P", RefuseWindowSeconds: refuse})
			if res.Banner != "shown" || len(ui.shown) != 1 {
				t.Fatalf("set %d refuse %d: banner not shown: %+v", i, refuse, res)
			}
			b := ui.shown[0]
			if b.Permissions == nil {
				t.Fatalf("set %d: the banner must carry the permissions", i)
			}
			if p != nil && (*b.Permissions != *p || b.Control != p.Control) {
				t.Fatalf("set %d: banner permissions %+v control %v", i, *b.Permissions, b.Control)
			}
			text := userui.BannerText(b)
			if !strings.Contains(text, "tech") || !strings.Contains(text, "why") || !strings.Contains(text, "Allowed") || !strings.Contains(text, "المسموح") {
				t.Fatalf("set %d: banner text %q", i, text)
			}
			m.Close("", "test")
		}
	}
}

func TestEffectivePermissions(t *testing.T) {
	legacy := OpenRequest{Control: true}.Effective()
	if !legacy.View || !legacy.Control || !legacy.ClipboardIn || !legacy.ClipboardOut || legacy.Files || legacy.Shell {
		t.Fatalf("older server without profiles: %+v", legacy)
	}
	if (OpenRequest{Control: false}).Effective().Control {
		t.Fatal("control off stays off")
	}
	// The profile and the control flag must both allow mouse and keyboard.
	if (OpenRequest{Control: true, Permissions: &userui.Permissions{View: true}}).Effective().Control {
		t.Fatal("a view-only profile must not control")
	}
	if (OpenRequest{Control: false, Permissions: &userui.Permissions{View: true, Control: true}}).Effective().Control {
		t.Fatal("control=false must win over the profile")
	}
}

func TestRefuseWindow(t *testing.T) {
	perms := &userui.Permissions{View: true, Control: true}
	cases := []struct {
		answer  userui.ConsentAnswer
		consent string
		banner  string
	}{
		{userui.TimedOut, "not_refused", "shown"},
		{userui.Accepted, "accepted", "shown"},
		{userui.Denied, "denied", "not_shown"},
	}
	for _, c := range cases {
		ui := &recordingUI{fakeUI: fakeUI{answer: c.answer}}
		m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
		res := m.Open(context.Background(), OpenRequest{SessionID: "s", Operator: "ops", Reason: "patching", Control: true, Permissions: perms, RefuseWindowSeconds: 20})
		if res.Consent != c.consent || res.Banner != c.banner {
			t.Fatalf("%s: %+v", c.answer, res)
		}
		if len(ui.reqs) != 1 || ui.reqs[0].Mode != userui.ModeRefuse || ui.reqs[0].TimeoutSeconds != 20 || ui.reqs[0].Permissions == nil || !ui.reqs[0].Permissions.Control {
			t.Fatalf("%s: dialog request %+v", c.answer, ui.reqs)
		}
		if c.answer == userui.Denied && m.Active() != "" {
			t.Fatal("a refused session must not stay open")
		}
		m.Close("", "test")
	}
	// No refuse window and no consent: nobody is asked.
	ui := &recordingUI{fakeUI: fakeUI{answer: userui.Denied}}
	m := NewManager(Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: newFakeDesktop(ui)})
	if res := m.Open(context.Background(), OpenRequest{SessionID: "s", Control: true}); res.Consent != "not_required" || len(ui.reqs) != 0 {
		t.Fatalf("unattended without window: %+v asked=%d", res, len(ui.reqs))
	}
	if p, ok := m.Allows(); !ok || !p.Control {
		t.Fatalf("allows: %+v %v", p, ok)
	}
	m.Close("", "test")
	if _, ok := m.Allows(); ok {
		t.Fatal("no session open: Allows must say so")
	}
}

func TestStreamEnforcesTheProfile(t *testing.T) {
	ui := &fakeUI{answer: userui.Accepted}
	d := newFakeDesktop(ui)
	finished := make(chan struct{})
	srv := wsServer(t, func(c *srvConn, in <-chan msgIn, _ *http.Request) {
		defer close(finished)
		hello := next(t, in, "hello")
		if hello.text["control"] != false {
			t.Errorf("hello must say view only: %v", hello.text)
		}
		c.json(map[string]any{"t": "input", "ev": map[string]any{"kind": "key_press", "key": "Enter"}})
		if e := next(t, in, "input_error"); e.text["code"] != "profile_forbids_control" {
			t.Errorf("input_error %v", e.text)
		}
		// Clipboard from the computer is allowed by this profile, to the computer is not.
		c.json(map[string]any{"t": "clipboard_get", "req": "g"})
		if got := next(t, in, "clipboard"); got.text["text"] != "remote text" {
			t.Errorf("clipboard %v", got.text)
		}
		c.json(map[string]any{"t": "clipboard_set", "req": "s", "text": "overwrite"})
		if e := next(t, in, "clipboard_error"); e.text["code"] != "profile_forbids_clipboard_in" || e.text["req"] != "s" {
			t.Errorf("clipboard_error %v", e.text)
		}
		c.json(map[string]any{"t": "end"})
		for range in {
		}
	})
	defer srv.Close()
	m := NewManager(Config{ServerURL: srv.URL, Credential: func() string { return "lda_e.s" }, UserAgent: "test", Desktop: d, MaxFPS: 30})
	// The server's Control flag says yes; the profile says view only: the profile wins.
	res := m.Open(context.Background(), OpenRequest{SessionID: "sess-p", Operator: "tech", Control: true, Stream: true, Quality: 60, Scale: 1,
		Permissions: &userui.Permissions{View: true, ClipboardOut: true}})
	if res.Banner != "shown" {
		t.Fatalf("open %+v", res)
	}
	select {
	case <-finished:
	case <-time.After(hangGuard):
		t.Fatal("stream test did not finish")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.inputs) != 0 || d.clip != "remote text" {
		t.Fatalf("refused actions reached the desktop: inputs=%v clip=%q", d.inputs, d.clip)
	}
	m.Close("", "test")
}
