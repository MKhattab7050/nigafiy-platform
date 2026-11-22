package rdstream

import (
	"testing"
	"time"
)

func TestControllerDegradesOnSlowLinkAndRecoversWhenFast(t *testing.T) {
	t0 := time.Now()
	c := NewController(85, 1.0, true, t0)
	if c.Current() != (Step{85, 1.0}) {
		t.Fatalf("start at the operator's choice, got %+v", c.Current())
	}
	now := t0
	// A slow link: 600 ms round trips. One step per MinChangeGap, never faster.
	changes := 0
	for i := 0; i < 30; i++ {
		now = now.Add(100 * time.Millisecond)
		c.FrameSent(80_000)
		if c.Ack(600*time.Millisecond, 80_000, 100*time.Millisecond, now) {
			changes++
		}
	}
	if changes < 2 || changes > 3 {
		t.Fatalf("3 s of slow acks should give 2-3 steps down (one per second), got %d", changes)
	}
	if c.Current().Quality >= 85 {
		t.Fatalf("quality did not drop: %+v", c.Current())
	}
	low := c.Index()
	// A fast link: 20 ms round trips, small frames. Improves only after StableFor, one step at a time.
	for i := 0; i < 20; i++ { // 2 s: not yet stable long enough
		now = now.Add(100 * time.Millisecond)
		c.FrameSent(5_000)
		c.Ack(20*time.Millisecond, 5_000, 100*time.Millisecond, now)
	}
	if c.Index() != low {
		t.Fatalf("improved before %v of stable acks", StableFor)
	}
	for i := 0; i < 200; i++ {
		now = now.Add(100 * time.Millisecond)
		c.FrameSent(5_000)
		c.Ack(20*time.Millisecond, 5_000, 100*time.Millisecond, now)
	}
	if c.Current() != (Step{85, 1.0}) {
		t.Fatalf("never above the ceiling and back to it on a fast link, got %+v", c.Current())
	}
	if c.RTT() <= 0 || c.RTT() > 50*time.Millisecond || c.Throughput() <= 0 {
		t.Fatalf("measured rtt %v throughput %v", c.RTT(), c.Throughput())
	}
}

func TestControllerDegradesWhenFramesAreTooBigForTheThroughput(t *testing.T) {
	now := time.Now()
	c := NewController(85, 1.0, true, now)
	// Fast round trip, but 400 KB frames on a 500 KB/s link: 800 ms per frame.
	for i := 0; i < 15; i++ {
		now = now.Add(200 * time.Millisecond)
		c.FrameSent(400_000)
		c.Ack(100*time.Millisecond, 100_000, 200*time.Millisecond, now)
	}
	if c.Index() == 0 {
		t.Fatal("too-large frames for the measured throughput must degrade")
	}
}

func TestControllerCeilingFixedModeAndTimeout(t *testing.T) {
	now := time.Now()
	c := NewController(55, 0.75, true, now)
	if c.Current() != (Step{55, 0.75}) {
		t.Fatalf("ceiling rung %+v", c.Current())
	}
	if !c.Timeout(now.Add(2*time.Second)) || c.Current() != (Step{45, 0.75}) {
		t.Fatalf("an unacknowledged frame must degrade, got %+v", c.Current())
	}
	// Bottom of the ladder: no further step.
	for i := 0; i < 30; i++ {
		c.Timeout(now.Add(time.Duration(3+i) * time.Second))
	}
	if c.Current() != Ladder[len(Ladder)-1] {
		t.Fatalf("bottom %+v", c.Current())
	}
	f := NewController(72, 0.9, false, now)
	if f.Current() != (Step{72, 0.9}) {
		t.Fatalf("fixed mode keeps exactly the operator's values, got %+v", f.Current())
	}
	if f.Ack(2*time.Second, 1, time.Second, now.Add(10*time.Second)) || f.Timeout(now.Add(20*time.Second)) {
		t.Fatal("fixed mode never changes")
	}
}

func TestControllerStartsAtExactlyTheOperatorsChoice(t *testing.T) {
	c := NewController(60, 0.5, true, time.Now())
	if c.Current() != (Step{60, 0.5}) {
		t.Fatalf("got %+v", c.Current())
	}
	if !c.Timeout(time.Now().Add(2*time.Second)) || c.Current() != (Step{55, 0.5}) {
		t.Fatalf("next rung below the choice, got %+v", c.Current())
	}
}
