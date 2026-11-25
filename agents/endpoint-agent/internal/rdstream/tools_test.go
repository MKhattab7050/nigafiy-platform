package rdstream

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/audio"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/sas"
	"github.com/nigafiy/agent/internal/userui"
)

// toolDesktop records every tool call instead of opening windows, hooks or audio devices.
type toolDesktop struct {
	*fakeDesktop
	tmu    sync.Mutex
	ops    []desktop.ToolRequest
	events func(desktop.ToolEvent, []byte)
}

func (d *toolDesktop) SetToolEvents(fn func(desktop.ToolEvent, []byte)) {
	d.tmu.Lock()
	d.events = fn
	d.tmu.Unlock()
}

func (d *toolDesktop) emit(ev desktop.ToolEvent, data []byte) {
	d.tmu.Lock()
	fn := d.events
	d.tmu.Unlock()
	fn(ev, data)
}

func (d *toolDesktop) Tool(_ context.Context, req desktop.ToolRequest, _ []byte) (desktop.ToolResult, []byte, error) {
	d.tmu.Lock()
	d.ops = append(d.ops, req)
	d.tmu.Unlock()
	switch req.Op {
	case desktop.ToolPrivacyOn:
		return desktop.ToolResult{Privacy: &userui.PrivacyResult{Monitors: 2, Excluded: true}}, nil, nil
	case desktop.ToolAsk:
		return desktop.ToolResult{Answer: &userui.AskAnswer{Answer: "yes"}}, nil, nil
	case desktop.ToolAudioOn:
		return desktop.ToolResult{Audio: &audio.Format{Rate: 48000, Channels: 2, Bits: 32, Float: true}}, nil, nil
	case desktop.ToolClipFilesGet:
		return desktop.ToolResult{Paths: []string{`C:\Users\u\report.pdf`}}, nil, nil
	}
	return desktop.ToolResult{}, nil, nil
}

func (d *toolDesktop) opsSeen() []string {
	d.tmu.Lock()
	defer d.tmu.Unlock()
	var out []string
	for _, o := range d.ops {
		out = append(out, o.Op)
	}
	return out
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func runToolSession(t *testing.T, perms userui.Permissions, cfg Config, script func(c *srvConn, in <-chan msgIn, m *Manager, d *toolDesktop)) (*toolDesktop, *fakeUI, *Manager) {
	t.Helper()
	ui := &fakeUI{answer: userui.Accepted}
	d := &toolDesktop{fakeDesktop: newFakeDesktop(ui)}
	finished := make(chan struct{})
	var mgr *Manager
	srv := wsServer(t, func(c *srvConn, in <-chan msgIn, _ *http.Request) {
		defer close(finished)
		hello := next(t, in, "hello")
		if f, _ := hello.text["features"].([]any); len(f) == 0 {
			t.Errorf("hello lists no tool features: %v", hello.text)
		}
		next(t, in, "tool_state")
		script(c, in, mgr, d)
		c.json(map[string]any{"t": "end"})
		for range in {
		}
	})
	t.Cleanup(srv.Close)
	cfg.ServerURL, cfg.Credential, cfg.UserAgent, cfg.Desktop, cfg.MaxFPS = srv.URL, func() string { return "lda_e.s" }, "test", d, 30
	m := NewManager(cfg)
	mgr = m
	if res := m.Open(context.Background(), OpenRequest{SessionID: "sess-t", Operator: "tech@corp.example", Reason: "printer", Control: true, Stream: true, Permissions: &perms}); res.Banner != "shown" {
		t.Fatalf("open %+v", res)
	}
	select {
	case <-finished:
	case <-time.After(hangGuard):
		t.Fatal("tool session did not finish")
	}
	return d, ui, m
}

func TestToolsRefusedByTheProfileNeverReachTheDesktop(t *testing.T) {
	sasCalled := false
	d, _, m := runToolSession(t, userui.Permissions{View: true}, Config{SAS: func(bool) error { sasCalled = true; return nil }}, func(c *srvConn, in <-chan msgIn, _ *Manager, _ *toolDesktop) {
		for _, tc := range []struct {
			msg  map[string]any
			code string
		}{
			{map[string]any{"t": "privacy", "on": true}, "profile_forbids_privacy_screen"},
			{map[string]any{"t": "block_input", "on": true}, "profile_forbids_block_input"},
			{map[string]any{"t": "audio", "on": true}, "profile_forbids_audio"},
			{map[string]any{"t": "sas"}, "profile_forbids_control"},
		} {
			c.json(tc.msg)
			if e := next(t, in, "tool_error"); e.text["code"] != tc.code {
				t.Errorf("%v → %v", tc.msg, e.text)
			}
		}
		c.json(map[string]any{"t": "clipboard_get", "req": "i", "format": "image"})
		if e := next(t, in, "clipboard_error"); e.text["code"] != "profile_forbids_clipboard_out" {
			t.Errorf("image get %v", e.text)
		}
		c.json(map[string]any{"t": "clipboard_set", "req": "f", "format": "files", "paths": []string{`C:\x`}})
		if e := next(t, in, "clipboard_error"); e.text["code"] != "profile_forbids_clipboard_in" {
			t.Errorf("files set %v", e.text)
		}
	})
	m.Close("", "test")
	for _, op := range d.opsSeen() {
		if op != desktop.ToolEndAllForSess {
			t.Fatalf("a refused tool reached the desktop: %v", d.opsSeen())
		}
	}
	if sasCalled {
		t.Fatal("Ctrl+Alt+Del sent in a view-only session")
	}
}

func TestToolsAllowedRunShowOnTheBannerAndEndWithTheSession(t *testing.T) {
	all := userui.Permissions{View: true, Control: true, ClipboardIn: true, ClipboardOut: true, Files: true, Audio: true, PrivacyScreen: true, BlockInput: true}
	notified := make(chan string, 1)
	cfg := Config{
		SAS:         func(asService bool) error { return &sas.Refusal{Code: "sas_needs_service", Message: "not the service"} },
		NotifyEnded: func(_ context.Context, s string) error { notified <- s; return nil },
	}
	d, ui, m := runToolSession(t, all, cfg, func(c *srvConn, in <-chan msgIn, m *Manager, d *toolDesktop) {
		c.json(map[string]any{"t": "privacy", "on": true})
		st := next(t, in, "tool_state")
		if st.text["privacy"] != true || st.text["privacy_excluded"] != true {
			t.Errorf("privacy state %v", st.text)
		}
		c.json(map[string]any{"t": "block_input", "on": true})
		if st := next(t, in, "tool_state"); st.text["input_blocked"] != true {
			t.Errorf("blocked state %v", st.text)
		}
		c.json(map[string]any{"t": "sas"})
		if r := next(t, in, "sas_result"); r.text["ok"] != false || r.text["code"] != "sas_needs_service" {
			t.Errorf("sas %v", r.text)
		}
		c.json(map[string]any{"t": "ask", "id": "q1", "text": "May I restart?", "kind": "yes_no"})
		if a := next(t, in, "answer"); a.text["id"] != "q1" || a.text["answer"] != "yes" {
			t.Errorf("answer %v", a.text)
		}
		c.json(map[string]any{"t": "chat", "id": "c1", "text": "hello"})
		next(t, in, "chat_shown")
		d.emit(desktop.ToolEvent{Session: "sess-t", Kind: "chat_reply", Text: "hi back"}, nil)
		if r := next(t, in, "chat"); r.text["from"] != "user" || r.text["text"] != "hi back" {
			t.Errorf("reply %v", r.text)
		}
		c.json(map[string]any{"t": "audio", "on": true})
		if st := next(t, in, "tool_state"); st.text["audio"] != true {
			t.Errorf("audio state %v", st.text)
		}
		samples := make([]int16, 1920*2)
		st0, data := audio.Encode(make([]audio.State, 2), samples)
		_ = st0
		d.emit(desktop.ToolEvent{Session: "sess-t", Kind: "audio", Audio: &audio.Header{T: "audio", Seq: 1, Codec: "ima_adpcm", Rate: 48000, Ch: 2, Frames: 1920}}, data)
		next(t, in, "audio")
		c.json(map[string]any{"t": "clipboard_get", "req": "f", "format": "files"})
		if r := next(t, in, "clipboard"); r.text["format"] != "files" {
			t.Errorf("files %v", r.text)
		}
		c.json(map[string]any{"t": "annotate", "op": map[string]any{"op": "pointer", "display": map[string]any{"w": 1920, "h": 1080}, "x": 0.5, "y": 0.5}})
		c.json(map[string]any{"t": "annotate", "op": map[string]any{"op": "stroke", "display": map[string]any{"w": 1920, "h": 1080}}})
		if e := next(t, in, "tool_error"); e.text["tool"] != "annotate" {
			t.Errorf("bad stroke %v", e.text)
		}
		if !m.Update(UpdateRequest{SessionID: "sess-t", Operators: []string{"tech@corp.example", "lead@corp.example"}, Recording: true}) {
			t.Error("update refused")
		}
		if st := next(t, in, "tool_state"); st.text["recording"] != true {
			t.Errorf("recording state %v", st.text)
		}
		// Ctrl+Alt+Shift+E pressed while the input is blocked ends the session like the End button.
		d.emit(desktop.ToolEvent{Session: "sess-t", Kind: "end_combo"}, nil)
	})
	select {
	case s := <-notified:
		if s != "sess-t" {
			t.Fatalf("notified %s", s)
		}
	case <-time.After(hangGuard):
		t.Fatal("Ctrl+Alt+Shift+E did not end the session")
	}
	deadline := time.Now().Add(hangGuard)
	for (m.Active() != "" || !has(d.opsSeen(), desktop.ToolEndAllForSess)) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	ops := d.opsSeen()
	for _, want := range []string{desktop.ToolPrivacyOn, desktop.ToolBlockOn, desktop.ToolAsk, desktop.ToolChat, desktop.ToolAudioOn, desktop.ToolClipFilesGet, desktop.ToolOverlay, desktop.ToolEndAllForSess} {
		if !has(ops, want) {
			t.Fatalf("desktop never got %s: %v", want, ops)
		}
	}
	ui.mu.Lock()
	defer ui.mu.Unlock()
	var sawPrivacy, sawRecording bool
	for _, b := range ui.shown {
		sawPrivacy = sawPrivacy || (b.PrivacyScreen && b.InputBlocked)
		if b.Recording && len(b.Operators) == 2 {
			sawRecording = true
		}
		if b.Operator != "tech@corp.example" {
			t.Fatalf("a banner without the operator: %+v", b)
		}
	}
	if !sawPrivacy || !sawRecording {
		t.Fatalf("the banner did not show what was on: %+v", ui.shown)
	}
}
