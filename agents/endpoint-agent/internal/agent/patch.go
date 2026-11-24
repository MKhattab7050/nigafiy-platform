package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strconv"
	"time"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/patch"
	"github.com/nigafiy/agent/internal/userui"
)

// Patches (Fleet Pro): the agent reports the updates this computer is missing every 6 hours (and
// when IT asks), installs only what the server sends in patch_install (approved, inside a
// maintenance window), asks the person before a restart (patch_reboot_prompt, with "Later" while
// postponements remain) and restarts when the server says so (patch_reboot).

const patchInterval = 6 * time.Hour

func (a *Agent) patchLoop(ctx context.Context) {
	if a.deps.Patch == nil {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(90 * time.Second):
	case <-a.wakePatch:
	}
	for {
		a.scanAndReport(ctx)
		select {
		case <-ctx.Done():
			return
		case <-a.wakePatch:
		case <-time.After(patchInterval):
		}
	}
}

func (a *Agent) scanAndReport(ctx context.Context) patch.Status {
	st := a.deps.Patch.Scan(ctx)
	if ctx.Err() == nil {
		if err := a.post(ctx, "/patch-status", st, true, nil); err != nil {
			a.log.Debug("patch status upload failed", "error", err.Error())
		}
	}
	return st
}

type patchPrompt struct {
	InstallID   string `json:"install_id"`
	Text        string `json:"text"`
	CanPostpone bool   `json:"can_postpone"`
	TimeoutS    int    `json:"timeout_s"`
}

func (a *Agent) patchCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	switch cmd.Kind {
	case "patch_scan", "patch_install":
		if a.deps.Patch == nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Patching is not available on this agent"}, true
		}
	}
	switch cmd.Kind {
	case "patch_scan":
		st := a.scanAndReport(ctx)
		if st.Error != "" {
			return control.Result{ID: cmd.ID, OK: false, Error: st.Error}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("%d missing updates (%s)", len(st.Updates), st.Source)}, true
	case "patch_install":
		var p struct {
			InstallID string       `json:"install_id"`
			Updates   []patch.Item `json:"updates"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.InstallID == "" || len(p.Updates) == 0 || len(p.Updates) > 200 {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid patch install payload"}, true
		}
		select {
		case a.patchBusy <- struct{}{}:
			defer func() { <-a.patchBusy }()
		default:
			return control.Result{ID: cmd.ID, OK: false, Error: "Another update install is running on this computer"}, true
		}
		res, err := a.deps.Patch.Install(ctx, p.Updates)
		data, _ := json.Marshal(res)
		// The new state goes out at once (what is still missing, restart pending).
		select {
		case a.wakePatch <- struct{}{}:
		default:
		}
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error(), Data: data}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("%d updates processed", len(res.Results)), Data: data}, true
	case "patch_reboot_prompt":
		var p patchPrompt
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.InstallID == "" || p.Text == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid restart question"}, true
		}
		answer := a.askRestart(ctx, p)
		data, _ := json.Marshal(map[string]string{"answer": answer})
		return control.Result{ID: cmd.ID, OK: true, Output: "Restart question: " + answer, Data: data}, true
	case "patch_reboot":
		var p struct {
			InstallID string `json:"install_id"`
			Message   string `json:"message"`
			NoticeS   int    `json:"notice_s"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.InstallID == "" || p.Message == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid restart payload"}, true
		}
		if a.deps.RebootRun == nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Restart is disabled on this agent"}, true
		}
		if err := a.patchRestart(ctx, p.Message, p.NoticeS); err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error()}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: "Restart started after updates"}, true
	}
	return control.Result{}, false
}

// askRestart: restart | postpone | no_user (nobody signed in) | no_answer (closed or timed out).
func (a *Agent) askRestart(ctx context.Context, p patchPrompt) string {
	if a.deps.Desktop == nil {
		return "no_user"
	}
	kind := "yes_no"
	if !p.CanPostpone {
		kind = "ok"
	}
	timeout := p.TimeoutS
	if timeout < 60 || timeout > 600 {
		timeout = 300
	}
	ask := userui.AskRequest{SessionID: "patch-" + p.InstallID, ID: "patch-reboot-" + p.InstallID, Operator: "Nigafiy", Text: p.Text, Kind: kind, TimeoutSeconds: timeout}
	res, _, err := a.deps.Desktop.Tool(ctx, desktop.ToolRequest{Op: desktop.ToolAsk, Ask: &ask}, nil)
	if err != nil || res.Answer == nil {
		return "no_user"
	}
	switch res.Answer.Answer {
	case "yes", "ok":
		return "restart"
	case "no":
		return "postpone"
	}
	return "no_answer"
}

// patchRestart restarts with a notice the person can read (Windows: shutdown /c, at most 10 min).
func (a *Agent) patchRestart(ctx context.Context, message string, noticeS int) error {
	if noticeS < 15 {
		noticeS = 15
	}
	if noticeS > 600 {
		noticeS = 600
	}
	if len(message) > 500 {
		message = message[:500]
	}
	if runtime.GOOS == "windows" {
		if out, err := a.deps.RebootRun(ctx, "shutdown", "/r", "/t", strconv.Itoa(noticeS), "/c", message); err != nil {
			return fmt.Errorf("shutdown /r: %w: %s", err, out)
		}
		return nil
	}
	return a.restartComputer(ctx, message)
}
