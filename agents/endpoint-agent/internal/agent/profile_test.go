package agent

import (
	"context"
	"encoding/json"
	"image"
	"sync"
	"testing"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/rdstream"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
)

type quietUI struct{}

func (quietUI) Consent(context.Context, userui.ConsentRequest) (userui.ConsentAnswer, error) {
	return userui.Accepted, nil
}
func (quietUI) ShowBanner(userui.BannerInfo, func()) error { return nil }
func (quietUI) HideBanner(string)                          {}

type inputDesktop struct {
	*desktop.Local
	mu     sync.Mutex
	inputs int
}

func (d *inputDesktop) Input(remotedesktop.InputEvent) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inputs++
	return nil
}

// The HTTP fallback path (rd_input as a command) obeys the open session's profile too.
func TestHTTPInputObeysTheSessionProfile(t *testing.T) {
	d := &inputDesktop{Local: desktop.NewLocalWith(quietUI{}, func(int) (*image.RGBA, []remotedesktop.DisplayInfo, int, string, error) {
		return image.NewRGBA(image.Rect(0, 0, 8, 8)), nil, 0, "test", nil
	})}
	a := &Agent{deps: Deps{Desktop: d}, sessions: rdstream.NewManager(rdstream.Config{ServerURL: "http://127.0.0.1:1", Credential: func() string { return "x" }, Desktop: d})}
	open := func(perms map[string]bool) {
		p, _ := json.Marshal(map[string]any{"session_id": "s1", "operator": "tech", "control": true, "stream": false, "permissions": perms})
		res, handled := a.sessionCommand(context.Background(), control.Command{ID: "o", Kind: "rd_session_open", Payload: p})
		if !handled || !res.OK {
			t.Fatalf("open: %+v", res)
		}
	}
	input := func() control.Result {
		res, _ := a.sessionCommand(context.Background(), control.Command{ID: "i", Kind: "rd_input", Payload: json.RawMessage(`{"kind":"mouse_click","x":0.5,"y":0.5}`)})
		return res
	}

	open(map[string]bool{"view": true})
	if r := input(); r.OK {
		t.Fatalf("view-only session accepted input: %+v", r)
	}
	open(map[string]bool{"view": true, "control": true})
	if r := input(); !r.OK {
		t.Fatalf("control session refused input: %+v", r)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.inputs != 1 {
		t.Fatalf("inputs delivered: %d", d.inputs)
	}
}
