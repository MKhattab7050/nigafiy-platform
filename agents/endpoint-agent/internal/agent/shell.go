package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/shell"
	"github.com/nigafiy/agent/internal/tray"
	"github.com/nigafiy/agent/internal/userui"
)

// Fleet Pro remote shell (admin only, off unless the group's policy turns it on):
//
//	shell_open   start the shell, put it on the banner, join it to the API   (server-issued)
//	shell_close  the API ended it (operator End, idle there, policy)         (server-issued)

func (a *Agent) newShellManager(mux *desktop.BannerMux) *shell.Manager {
	cfg := shell.Config{
		ServerURL:  a.baseURL,
		TLS:        a.tlsConfig,
		Credential: a.currentCredential,
		UserAgent:  "nigafiy-agent/" + a.version,
		Log:        a.log,
		NotifyEnded: func(ctx context.Context, shellID, reason string, exitCode *int) error {
			body := map[string]any{"shell_id": shellID, "reason": reason}
			if exitCode != nil {
				body["exit_code"] = *exitCode
			}
			return a.post(ctx, "/shell-end", body, true, nil)
		},
	}
	if mux != nil {
		cfg.Banner = mux.SetShells
	}
	return shell.NewManager(cfg)
}

func (a *Agent) shellCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	switch cmd.Kind {
	case "shell_open":
		var req shell.OpenRequest
		if err := json.Unmarshal(cmd.Payload, &req); err != nil || req.ShellID == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid shell payload"}, true
		}
		res, err := a.shells.Open(context.WithoutCancel(ctx), req)
		raw, _ := json.Marshal(res)
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error(), Data: raw}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Shell %s open (%s, %s), banner %s", req.ShellID, res.Shell, res.PTY, res.Banner), Data: raw}, true
	case "shell_close":
		var p struct {
			ShellID string `json:"shell_id"`
			Reason  string `json:"reason"`
		}
		_ = json.Unmarshal(cmd.Payload, &p)
		closed := a.shells.Close(p.ShellID, p.Reason)
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Shell %s closed (%v)", p.ShellID, closed)}, true
	}
	return control.Result{}, false
}

// showITActivity: "IT activity…" from the tray shows what IT did here in the last 30 days.
func (a *Agent) showITActivity() {
	if a.deps.Desktop == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var resp struct {
		Items []tray.ActivityItem `json:"items"`
	}
	text := ""
	if err := a.post(ctx, "/it-activity", map[string]any{}, true, &resp); err != nil {
		a.log.Warn("IT activity could not be loaded", "error", err.Error())
		text = "The IT activity list could not be loaded from the server. Try again later. / تعذّر تحميل قائمة نشاط تقنية المعلومات من الخادم. حاول لاحقًا."
	} else {
		text = tray.ActivityText(resp.Items, time.Local)
	}
	ask := userui.AskRequest{SessionID: "it-activity", ID: "it-activity", Operator: "Nigafiy", Text: text, Kind: "ok", TimeoutSeconds: 600}
	if _, _, err := a.deps.Desktop.Tool(context.Background(), desktop.ToolRequest{Op: desktop.ToolAsk, Ask: &ask}, nil); err != nil {
		a.log.Info("IT activity not shown", "reason", err.Error())
	}
}
