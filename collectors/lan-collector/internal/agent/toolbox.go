package agent

import (
	"context"
	"encoding/json"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/tools"
)

// At most this many toolbox requests run at once; further ones wait their turn.
const maxConcurrentTools = 2

// runTool executes one IT-toolbox request from the dashboard (ping, port check, DNS, reverse DNS,
// traceroute) and reports the measurement. The request is acknowledged whether or not it could run.
func (a *Agent) runTool(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	if a.deps.Tool == nil {
		return
	}
	var req tools.Request
	if err := json.Unmarshal(cmd.Payload, &req); err != nil || req.RunID == "" {
		a.log.Warn("toolbox request ignored: malformed payload")
		return
	}
	select {
	case a.toolSlots <- struct{}{}:
		defer func() { <-a.toolSlots }()
	case <-ctx.Done():
		return
	}
	started := time.Now()
	out, err := a.deps.Tool(ctx, req)
	if ctx.Err() != nil {
		return // shutting down: the run expires on the server instead of reporting a false failure
	}
	item := map[string]any{"type": "tool_result", "ts": time.Now().UTC(), "run_id": req.RunID, "duration_ms": time.Since(started).Milliseconds()}
	if err != nil {
		item["ok"], item["error"] = false, err.Error()
	} else {
		item["ok"], item["output"] = true, out
	}
	a.log.Info("ran a toolbox request", "tool", req.Tool, "target", req.Target, "ok", err == nil)
	a.enqueue(item)
	a.wakeUploader()
}
