package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/scripts"
)

// Fleet Pro jobs: a script from the library runs here with its parameters passed as data (never
// written into the script), its output capped, and its process tree stopped on timeout or cancel.
//
//	script_run     run one script for one job result   (server-issued)
//	script_cancel  stop that script if it still runs    (server-issued)
//
// The agent runs scripts as its own account: LocalSystem for the Windows service, the agent's
// user otherwise.

// maxResultJSON keeps a result under the gateway's body limit even when the output is binary (JSON
// escaping can grow it six times).
const maxResultJSON = 5 << 20

func (a *Agent) jobsCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	switch cmd.Kind {
	case "script_run":
		var req scripts.Request
		if err := json.Unmarshal(cmd.Payload, &req); err != nil || req.ResultID == "" {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid script payload"}, true
		}
		res, err := a.scripts.Run(ctx, req)
		raw := scriptResultJSON(&res)
		out := fmt.Sprintf("Script finished with exit code %d in %d ms", res.ExitCode, res.DurationMS)
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Output: out, Error: err.Error(), Data: raw}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: out, Data: raw}, true
	case "script_cancel":
		var p struct {
			ResultID string `json:"result_id"`
		}
		_ = json.Unmarshal(cmd.Payload, &p)
		if a.scripts.Cancel(p.ResultID) {
			return control.Result{ID: cmd.ID, OK: true, Output: "The script was stopped"}, true
		}
		return control.Result{ID: cmd.ID, OK: true, Output: "The script was not running here"}, true
	}
	return control.Result{}, false
}

// scriptResultJSON marshals the result, trimming the output when it would not fit the gateway.
func scriptResultJSON(res *scripts.Result) json.RawMessage {
	raw, _ := json.Marshal(res)
	for len(raw) > maxResultJSON && (len(res.Stdout) > 0 || len(res.Stderr) > 0) {
		res.Stdout = res.Stdout[:len(res.Stdout)/2]
		res.Stderr = res.Stderr[:len(res.Stderr)/2]
		res.Capped = true
		raw, _ = json.Marshal(res)
	}
	return raw
}

// unthrottled: commands that must never wait behind long-running ones (a cancel, a shell's
// open and close).
func unthrottled(kind string) bool {
	switch kind {
	case "script_cancel", "shell_open", "shell_close":
		return true
	}
	return false
}
