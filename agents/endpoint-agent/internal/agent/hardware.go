package agent

import (
	"context"
	"time"
)

// hardwareInterval: the hardware and licence inventory changes rarely and its queries are slow
// (the Windows licensing service, disk reliability counters), so it is measured every 6 hours,
// and at once when IT asks for a refresh.
const hardwareInterval = 6 * time.Hour

func (a *Agent) hardwareLoop(ctx context.Context) {
	if a.deps.CollectHardware == nil {
		return
	}
	// Let the first heartbeat and inventory go out before the slow queries start.
	select {
	case <-ctx.Done():
		return
	case <-time.After(20 * time.Second):
	case <-a.wakeHardware:
	}
	for {
		hw := a.deps.CollectHardware(ctx)
		if ctx.Err() != nil {
			return
		}
		if err := a.post(ctx, "/hardware", hw, true, nil); err != nil {
			a.log.Debug("hardware inventory upload failed", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-a.wakeHardware:
		case <-time.After(hardwareInterval):
		}
	}
}
