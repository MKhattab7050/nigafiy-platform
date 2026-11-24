package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"time"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
)

// Fleet Pro, reaching computers: the boot state and Windows sessions in the heartbeat, the tray
// icon (Request help, Nigafiy ID), and restart and reconnect (fleet_restart,
// fleet_safe_boot_clear).

// bootState: safe mode now, whether a safe-boot flag this agent set is still pending, and whether
// the agent is the service (what safe mode, other sessions and the sign-in screen need).
func (a *Agent) bootState() map[string]any {
	st := map[string]any{"service": a.deps.InService, "safe_boot_flag": a.reboot.SafeBootPending()}
	if a.deps.SafeMode != nil {
		st["safe_mode"] = a.deps.SafeMode()
	}
	return st
}

// showTray shows (or updates) the tray icon with this computer's Nigafiy ID. Errors (no shell on
// this desktop, not Windows) are only logged once per ID.
func (a *Agent) showTray(ctx context.Context, nigafiyID string) {
	if nigafiyID == "" || a.deps.Desktop == nil || a.deps.NoTray {
		return
	}
	a.mu.Lock()
	a.nigafiyID = nigafiyID
	first := a.trayID != nigafiyID
	a.trayID = nigafiyID
	a.mu.Unlock()
	go func() {
		_, _, err := a.deps.Desktop.Tool(ctx, desktop.ToolRequest{Op: desktop.ToolTray, Tray: &desktop.TrayInfo{NigafiyID: nigafiyID, Server: a.baseURL}}, nil)
		if err != nil && first {
			a.log.Info("tray icon not shown", "reason", err.Error())
		}
	}()
}

// sendHelpRequest: "Request help" from the tray goes to Fleet (POST /agent/help-request).
func (a *Agent) sendHelpRequest(note, user string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	body := map[string]any{"note": note}
	if user != "" {
		body["user"] = user
	}
	if err := a.post(ctx, "/help-request", body, true, nil); err != nil {
		a.log.Warn("help request could not be sent", "error", err.Error())
		return
	}
	a.log.Info("help request sent to IT")
}

// restartComputer: Windows shows the message to the person for 15 s before restarting; elsewhere
// the agent's power_action restart.
func (a *Agent) restartComputer(ctx context.Context, message string) error {
	if runtime.GOOS == "windows" && a.deps.RebootRun != nil {
		if out, err := a.deps.RebootRun(ctx, "shutdown", "/r", "/t", "15", "/c", message); err != nil {
			return fmt.Errorf("shutdown /r: %w: %s", err, out)
		}
		return nil
	}
	raw, _ := json.Marshal(map[string]any{"action": "restart", "reason": message})
	res := a.deps.ExecuteCommand(ctx, control.Command{ID: "fleet-restart", Kind: "power_action", Payload: raw})
	if !res.OK {
		return fmt.Errorf("restart: %s", res.Error)
	}
	return nil
}

// reachCommand runs fleet_restart and fleet_safe_boot_clear.
func (a *Agent) reachCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	switch cmd.Kind {
	case "fleet_restart":
		var p struct {
			RestartID string `json:"restart_id"`
			Mode      string `json:"mode"`
			Reason    string `json:"reason"`
			Operator  string `json:"operator"`
			SessionID string `json:"session_id"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.RestartID == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid restart payload"}, true
		}
		if a.reboot.Run == nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Restart is disabled on this agent"}, true
		}
		set, err := a.reboot.RestartForReconnect(ctx, p.Mode, p.Operator, p.Reason)
		data, _ := json.Marshal(map[string]any{"safe_boot_set": set})
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error(), Data: data}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Restarting (%s) for session %s", p.Mode, p.SessionID), Data: data}, true
	case "fleet_safe_boot_clear":
		if a.reboot.Run == nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Restart is disabled on this agent"}, true
		}
		err := a.reboot.Clear(ctx)
		data, _ := json.Marshal(map[string]any{"safe_boot_flag": a.reboot.SafeBootPending()})
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error(), Data: data}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: "Safe boot cleared", Data: data}, true
	}
	return control.Result{}, false
}
