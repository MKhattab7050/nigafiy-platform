package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/rdstream"
	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
)

// Remote desktop session commands run through the Desktop (this process, or the session helper
// when the agent is a service), never through the generic control runner:
//
//	rd_session_open   consent (when required) → banner → live stream   (server-issued)
//	rd_session_close  stream and banner off                             (server-issued)
//	rd_capture        one JPEG frame: the HTTP fallback path
//	rd_input          one mouse/keyboard event: the HTTP fallback path
func (a *Agent) sessionCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	if a.deps.Desktop == nil {
		return control.Result{}, false
	}
	switch cmd.Kind {
	case "rd_session_open":
		var req rdstream.OpenRequest
		if err := json.Unmarshal(cmd.Payload, &req); err != nil || req.SessionID == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid remote session payload"}, true
		}
		res := a.sessions.Open(ctx, req)
		raw, _ := json.Marshal(res)
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Session %s: consent %s, banner %s, stream %s", req.SessionID, res.Consent, res.Banner, res.Stream), Data: raw}, true
	case "rd_session_close":
		var p struct {
			SessionID string `json:"session_id"`
			Reason    string `json:"reason"`
		}
		_ = json.Unmarshal(cmd.Payload, &p)
		closed := a.sessions.Close(p.SessionID, p.Reason)
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Session %s closed (%v)", p.SessionID, closed)}, true
	case "rd_capture":
		var opts remotedesktop.CaptureOptions
		_ = json.Unmarshal(cmd.Payload, &opts)
		frame, err := a.deps.Desktop.CaptureFrame(opts)
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error()}, true
		}
		raw, _ := json.Marshal(frame)
		out := fmt.Sprintf("Captured frame %dx%d (%d bytes, %s)", frame.Width, frame.Height, frame.ByteLength, frame.CaptureMode)
		if frame.Unchanged {
			out = fmt.Sprintf("Screen unchanged %dx%d (no image sent, %s)", frame.Width, frame.Height, frame.CaptureMode)
		}
		return control.Result{ID: cmd.ID, OK: true, Output: out, Data: raw}, true
	case "rd_input":
		var ev remotedesktop.InputEvent
		if err := json.Unmarshal(cmd.Payload, &ev); err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid remote desktop input payload"}, true
		}
		// The open session's profile decides here too (the server checked it first).
		if perms, open := a.sessionPermissions(); open && !perms.Control {
			return control.Result{ID: cmd.ID, OK: false, Error: "The session's permission profile is view only: input refused by the agent"}, true
		}
		if err := a.deps.Desktop.Input(ev); err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: err.Error()}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Input '%s' delivered", ev.Kind)}, true
	}
	return control.Result{}, false
}

// sessionPermissions: what the open session allows (ok false when none is open here).
func (a *Agent) sessionPermissions() (userui.Permissions, bool) {
	if a.sessions == nil {
		return userui.Permissions{}, false
	}
	return a.sessions.Allows()
}
