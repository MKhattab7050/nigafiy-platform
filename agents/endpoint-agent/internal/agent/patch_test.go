package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/patch"
	"github.com/nigafiy/agent/internal/userui"
)

// A fake updater: nothing is installed on this computer.
type fakePatch struct {
	mu        sync.Mutex
	installed [][]patch.Item
	block     chan struct{}
}

func (f *fakePatch) Scan(context.Context) patch.Status {
	return patch.Status{Source: "wua", InstallSupported: true, Updates: []patch.Update{{ID: "u1", Title: "Update 1", Classification: "security"}}}
}

func (f *fakePatch) Install(_ context.Context, items []patch.Item) (patch.InstallResult, error) {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	f.installed = append(f.installed, items)
	f.mu.Unlock()
	return patch.InstallResult{Results: []patch.ItemResult{{ID: items[0].ID, Result: "succeeded", RebootRequired: true}}, RebootRequired: true}, nil
}

type askDesktop struct {
	desktop.Desktop
	asked  []userui.AskRequest
	answer string
}

func (d *askDesktop) Tool(_ context.Context, req desktop.ToolRequest, _ []byte) (desktop.ToolResult, []byte, error) {
	d.asked = append(d.asked, *req.Ask)
	return desktop.ToolResult{Answer: &userui.AskAnswer{Answer: d.answer}}, nil, nil
}

func newPatchAgent(t *testing.T) (*Agent, *fakePatch, *[]string, *[]string) {
	posted := &[]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*posted = append(*posted, r.URL.Path)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	calls := &[]string{}
	fp := &fakePatch{}
	a := &Agent{
		log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		addrs:      fixedServer(srv.URL),
		httpClient: srv.Client(),
		wakePatch:  make(chan struct{}, 1),
		patchBusy:  make(chan struct{}, 1),
		deps: Deps{Patch: fp, RebootRun: func(_ context.Context, name string, args ...string) ([]byte, error) {
			*calls = append(*calls, name+" "+strings.Join(args, " "))
			return nil, nil
		}, ExecuteCommand: func(_ context.Context, c control.Command) control.Result {
			*calls = append(*calls, c.Kind+" "+string(c.Payload))
			return control.Result{OK: true}
		}},
	}
	a.credential = "cred"
	return a, fp, calls, posted
}

func cmd(kind string, p any) control.Command {
	raw, _ := json.Marshal(p)
	return control.Command{ID: "c-" + kind, Kind: kind, Payload: raw}
}

func TestPatchInstallRunsOnlyTheSentUpdatesOneAtATime(t *testing.T) {
	a, fp, _, _ := newPatchAgent(t)
	res, handled := a.patchCommand(context.Background(), cmd("patch_install", map[string]any{"install_id": "i1", "updates": []map[string]string{{"update_id": "u1", "title": "Update 1"}}}))
	if !handled || !res.OK || !strings.Contains(string(res.Data), `"reboot_required":true`) {
		t.Fatalf("install: %+v", res)
	}
	if len(fp.installed) != 1 || fp.installed[0][0].ID != "u1" {
		t.Fatalf("installed %+v", fp.installed)
	}
	// A rescan is requested after the install.
	select {
	case <-a.wakePatch:
	default:
		t.Fatal("no rescan after the install")
	}
	// Invalid payloads are refused before anything runs.
	for _, p := range []any{map[string]any{"install_id": "i2"}, map[string]any{"updates": []map[string]string{{"update_id": "u1"}}}} {
		if r, _ := a.patchCommand(context.Background(), cmd("patch_install", p)); r.OK {
			t.Fatalf("accepted %v", p)
		}
	}
	// A second install while one runs is refused.
	fp.block = make(chan struct{})
	done := make(chan control.Result)
	go func() {
		r, _ := a.patchCommand(context.Background(), cmd("patch_install", map[string]any{"install_id": "i3", "updates": []map[string]string{{"update_id": "u1"}}}))
		done <- r
	}()
	for len(a.patchBusy) == 0 {
		runtime.Gosched() // wait for the first install to take the slot
	}
	if r, _ := a.patchCommand(context.Background(), cmd("patch_install", map[string]any{"install_id": "i4", "updates": []map[string]string{{"update_id": "u1"}}})); r.OK || !strings.Contains(r.Error, "Another update install") {
		t.Fatalf("second install: %+v", r)
	}
	close(fp.block)
	if r := <-done; !r.OK {
		t.Fatalf("first: %+v", r)
	}
}

func TestPatchScanReportsToTheServer(t *testing.T) {
	a, _, _, posted := newPatchAgent(t)
	res, _ := a.patchCommand(context.Background(), cmd("patch_scan", map[string]any{}))
	if !res.OK || res.Output != "1 missing updates (wua)" {
		t.Fatalf("scan: %+v", res)
	}
	if len(*posted) != 1 || !strings.HasSuffix((*posted)[0], "/patch-status") {
		t.Fatalf("posted %v", *posted)
	}
	a.deps.Patch = nil
	if r, _ := a.patchCommand(context.Background(), cmd("patch_scan", map[string]any{})); r.OK {
		t.Fatal("scan without an updater")
	}
}

func TestPatchRestartQuestionAndRestart(t *testing.T) {
	a, _, calls, _ := newPatchAgent(t)
	// Nobody signed in (no desktop): the server may restart.
	res, _ := a.patchCommand(context.Background(), cmd("patch_reboot_prompt", patchPrompt{InstallID: "i1", Text: "Restart now?", CanPostpone: true}))
	if !strings.Contains(string(res.Data), `"no_user"`) {
		t.Fatalf("no desktop: %+v", res)
	}
	d := &askDesktop{answer: "no"}
	a.deps.Desktop = d
	res, _ = a.patchCommand(context.Background(), cmd("patch_reboot_prompt", patchPrompt{InstallID: "i1", Text: "Restart now?", CanPostpone: true}))
	if !strings.Contains(string(res.Data), `"postpone"`) || d.asked[0].Kind != "yes_no" || d.asked[0].Operator != "Nigafiy" {
		t.Fatalf("postpone: %+v %+v", res, d.asked)
	}
	// No postponement left: an acknowledgement only, which counts as "restart".
	d.answer = "ok"
	res, _ = a.patchCommand(context.Background(), cmd("patch_reboot_prompt", patchPrompt{InstallID: "i1", Text: "Restarting in 5 minutes", CanPostpone: false}))
	if !strings.Contains(string(res.Data), `"restart"`) || d.asked[1].Kind != "ok" {
		t.Fatalf("ok: %+v", res)
	}
	d.answer = "timeout"
	res, _ = a.patchCommand(context.Background(), cmd("patch_reboot_prompt", patchPrompt{InstallID: "i1", Text: "Restart now?", CanPostpone: true}))
	if !strings.Contains(string(res.Data), `"no_answer"`) {
		t.Fatalf("timeout: %+v", res)
	}
	res, _ = a.patchCommand(context.Background(), cmd("patch_reboot", map[string]any{"install_id": "i1", "message": "Nigafiy: restarting to finish updates", "notice_s": 300}))
	if !res.OK || len(*calls) != 1 {
		t.Fatalf("reboot: %+v %v", res, *calls)
	}
	if !strings.Contains((*calls)[0], "Nigafiy: restarting to finish updates") {
		t.Fatalf("restart call %q", (*calls)[0])
	}
	a.deps.RebootRun = nil
	if r, _ := a.patchCommand(context.Background(), cmd("patch_reboot", map[string]any{"install_id": "i1", "message": "x"})); r.OK {
		t.Fatal("restart without a runner")
	}
}
