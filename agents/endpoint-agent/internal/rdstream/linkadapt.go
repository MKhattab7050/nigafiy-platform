package rdstream

// Link adaptation (owner, 2026-11-28, docs/roadmap/2026-11-28-wan-speed.md).
//
// The old rules judged a link by its absolute RTT: the bitrate climbed only below 120 ms and was
// cut at 180 ms. A phone on 4G reaches the PC through a Tailscale relay whose RTT never drops
// below about 150-230 ms even when the link is empty, so the bitrate sat at the 300 kbit/s floor
// with 0 % loss on a link that carries 4 Mbit/s cleanly. LinkAdapt instead learns the link's own
// base RTT (the lowest recent RTT) and reacts to how far the RTT rises above it (a queue is
// building) and to loss. After a cut it waits a few windows before climbing again, so the bitrate
// does not swing up and down every window.

const (
	// WANVideoBitrate caps links whose base RTT says they are not the local network. Phase 1 measured
	// 4 Mbit/s clean and 5.5 Mbit/s with 32 % loss from the PC to a phone on 4G over the relay.
	WANVideoBitrate = 4_000_000
	// lanBaseMs: a base RTT below this is the local network (LAN limits apply).
	lanBaseMs = 40
	// holdWindows: windows without climbing after a cut (hysteresis).
	holdWindows = 3
)

// LinkAdapt holds one link's state between adapt windows. The zero value is ready to use.
type LinkAdapt struct {
	rttMs  int // smoothed RTT
	baseMs int // lowest recent smoothed RTT
	hold   int // windows left before the bitrate may climb again
}

// RTT is the smoothed round-trip time in ms (0 before the first sample).
func (a *LinkAdapt) RTT() int { return a.rttMs }

// Base is the learned empty-link RTT in ms (0 before the first sample).
func (a *LinkAdapt) Base() int { return a.baseMs }

// WAN reports whether the link is slower than the local network.
func (a *LinkAdapt) WAN() bool { return a.baseMs >= lanBaseMs }

// Queue is how far the smoothed RTT sits above the base RTT, in ms.
func (a *LinkAdapt) Queue() int { return max(0, a.rttMs-a.baseMs) }

// observe folds one RTT sample in. The base follows a lower RTT at once (a direct path was found)
// and drifts up slowly (a tenth of the gap per window) so a move to a slower path is learned in
// about half a minute without mistaking a short queue for a slower path.
func (a *LinkAdapt) observe(rttMs int) {
	if rttMs <= 0 {
		return
	}
	if a.rttMs == 0 {
		a.rttMs, a.baseMs = rttMs, rttMs
		return
	}
	a.rttMs = (a.rttMs*7 + rttMs*3) / 10
	if a.rttMs < a.baseMs {
		a.baseMs = a.rttMs
	} else {
		a.baseMs += (a.rttMs - a.baseMs + 9) / 10
	}
}

// Cap is the highest bitrate this link may reach.
func (a *LinkAdapt) Cap() int {
	if a.WAN() {
		return WANVideoBitrate
	}
	return MaxVideoBitrate
}

// Step folds one window's RTT, loss (0..1), jitter and PLI burst in and returns the next bitrate.
// The queue thresholds scale with the base RTT because a long relayed path also jitters more.
func (a *LinkAdapt) Step(cur int, loss float64, rttMs, jitterMs int, pliBurst bool) int {
	a.observe(rttMs)
	q := a.Queue()
	big, small, calm := 250, 100, 50
	if a.WAN() {
		big, small, calm = max(300, a.baseMs), max(140, a.baseMs/2), max(70, a.baseMs/4)
	}
	switch {
	case loss > 0.10 || q > big:
		cur = cur * 3 / 4
		a.hold = holdWindows
	case loss > 0.04 || q > small || jitterMs >= 80 || pliBurst:
		cur = cur * 9 / 10
		a.hold = holdWindows
	case a.hold > 0:
		a.hold--
	case loss < 0.02 && q < calm:
		cur = cur*108/100 + 50_000
	}
	return min(a.Cap(), max(MinVideoBitrate, cur))
}
