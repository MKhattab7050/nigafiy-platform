package rdstream

import (
	"math"
	"time"
)

// Adaptive quality: the JPEG quality and scale follow what the link to the viewer actually
// delivers. Every frame the viewer has drawn is acknowledged ("ack" with the frame's seq); the
// round trip of that ack and the bytes acknowledged per second are measured, never estimated.
//
//   - Degrade one step when the measured round trip exceeds HighRTT, or when the last frame would
//     take longer than MaxFrameTime to deliver at the measured throughput.
//   - Improve one step after StableFor of round trips under LowRTT with frames delivered within
//     GoodFrameTime.
//   - At most one change per MinChangeGap (no oscillation), and never above the operator's chosen
//     ceiling (quality / scale picked in the viewer).

// Step is one rung of the quality ladder.
type Step struct {
	Quality int
	Scale   float64
}

// Ladder from best to most frugal. The scale never drops below 0.4 (text must stay readable).
var Ladder = []Step{
	{85, 1.0}, {75, 1.0}, {65, 1.0}, {65, 0.85}, {55, 0.85}, {55, 0.75}, {45, 0.75}, {45, 0.6}, {35, 0.6}, {35, 0.5}, {30, 0.4},
}

const (
	HighRTT       = 400 * time.Millisecond
	LowRTT        = 150 * time.Millisecond
	MaxFrameTime  = 300 * time.Millisecond
	GoodFrameTime = 80 * time.Millisecond
	StableFor     = 3 * time.Second
	MinChangeGap  = time.Second
	ewmaAlpha     = 0.3
)

// Controller is not safe for concurrent use; the stream loop owns it.
type Controller struct {
	// rungs: the ladder clipped to the operator's choice (quality and scale each at most what the
	// operator picked, repeats removed); rungs[0] is exactly the operator's choice.
	rungs       []Step
	ceiling     int
	idx         int
	adaptive    bool
	rtt         time.Duration // EWMA of measured ack round trips
	throughput  float64       // EWMA of acknowledged bytes per second
	lastBytes   int
	lastChange  time.Time
	stableSince time.Time
	haveSample  bool
	fixed       Step
}

// NewController starts at the operator's choice (the nearest rung at or below it).
func NewController(quality int, scale float64, adaptive bool, now time.Time) *Controller {
	c := &Controller{adaptive: adaptive, lastChange: now}
	c.SetCeiling(quality, scale, adaptive)
	return c
}

// SetCeiling applies the operator's quality/scale choice (and whether to adapt below it).
func (c *Controller) SetCeiling(quality int, scale float64, adaptive bool) {
	c.adaptive = adaptive
	quality = clampInt(quality, 10, 95)
	scale = math.Max(0.25, math.Min(1, scale))
	c.rungs = c.rungs[:0]
	for _, s := range Ladder {
		r := Step{Quality: min(s.Quality, quality), Scale: math.Min(s.Scale, scale)}
		if n := len(c.rungs); n == 0 || c.rungs[n-1] != r {
			c.rungs = append(c.rungs, r)
		}
	}
	c.ceiling = 0
	c.idx = 0
	c.stableSince = time.Time{}
	if !adaptive {
		c.fixed = Step{Quality: quality, Scale: scale}
	}
}

// fixed is used when adaptation is off: exactly what the operator picked.
func (c *Controller) Current() Step {
	if !c.adaptive {
		return c.fixed
	}
	return c.rungs[c.idx]
}

// Index of the current rung, 0 = the operator's choice (tests).
func (c *Controller) Index() int { return c.idx }

// RTT is the measured round trip (0 before the first ack).
func (c *Controller) RTT() time.Duration { return c.rtt }

// Throughput in bytes per second (0 before the first ack).
func (c *Controller) Throughput() float64 { return c.throughput }

// FrameSent records the size of the frame just sent (used for the delivery-time check).
func (c *Controller) FrameSent(bytes int) { c.lastBytes = bytes }

// Ack feeds one measured acknowledgement: its round trip and the bytes it acknowledged over
// `interval` (the time since the previous ack). It returns true when the step changed.
func (c *Controller) Ack(rtt time.Duration, bytes int, interval time.Duration, now time.Time) bool {
	if !c.haveSample {
		c.rtt = rtt
		c.haveSample = true
	} else {
		c.rtt = time.Duration(ewmaAlpha*float64(rtt) + (1-ewmaAlpha)*float64(c.rtt))
	}
	if interval > 0 && bytes > 0 {
		// Bytes over the round trip is a lower bound of the link rate; use the larger of the two
		// views so an idle gap between frames does not read as a slow link.
		rate := float64(bytes) / math.Max(interval.Seconds(), 1e-3)
		if rtt > 0 {
			rate = math.Max(rate, float64(bytes)/rtt.Seconds())
		}
		if c.throughput == 0 {
			c.throughput = rate
		} else {
			c.throughput = ewmaAlpha*rate + (1-ewmaAlpha)*c.throughput
		}
	}
	return c.decide(now)
}

// Timeout records a frame that was never acknowledged (a stalled link): degrade.
func (c *Controller) Timeout(now time.Time) bool {
	c.stableSince = time.Time{}
	return c.step(+1, now)
}

func (c *Controller) frameTime() time.Duration {
	if c.throughput <= 0 || c.lastBytes <= 0 {
		return 0
	}
	return time.Duration(float64(c.lastBytes) / c.throughput * float64(time.Second))
}

func (c *Controller) decide(now time.Time) bool {
	if !c.adaptive {
		return false
	}
	ft := c.frameTime()
	if c.rtt > HighRTT || ft > MaxFrameTime {
		c.stableSince = time.Time{}
		return c.step(+1, now)
	}
	if c.rtt < LowRTT && ft <= GoodFrameTime {
		if c.stableSince.IsZero() {
			c.stableSince = now
		}
		if now.Sub(c.stableSince) >= StableFor {
			if c.step(-1, now) {
				c.stableSince = now
				return true
			}
		}
		return false
	}
	c.stableSince = time.Time{}
	return false
}

// step moves +1 (more frugal) or -1 (better, never above the ceiling).
func (c *Controller) step(dir int, now time.Time) bool {
	if !c.adaptive || now.Sub(c.lastChange) < MinChangeGap {
		return false
	}
	next := c.idx + dir
	if next < c.ceiling || next >= len(c.rungs) {
		return false
	}
	c.idx = next
	c.lastChange = now
	return true
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
