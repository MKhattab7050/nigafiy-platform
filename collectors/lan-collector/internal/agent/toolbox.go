package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
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
	// The scope rule is applied by the runner on the address actually probed (after resolving a
	// name), against the scopes this collector was given — never against anything in the request.
	prefixes := a.authorizedPrefixes()
	req.InScope = func(addr netip.Addr) bool { return inPrefixes(addr, prefixes) }
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
		if errors.Is(err, tools.ErrOutOfScope) {
			a.log.Warn("toolbox request refused: target outside the authorized scopes", "tool", req.Tool, "target", req.Target)
		}
	} else {
		item["ok"], item["output"] = true, out
	}
	a.log.Info("ran a toolbox request", "tool", req.Tool, "target", req.Target, "ok", err == nil)
	a.enqueue(item)
	a.wakeUploader()
}
