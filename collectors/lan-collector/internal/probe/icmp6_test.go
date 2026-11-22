package probe

import (
	"context"
	"net/netip"
	"testing"
	"time"
)

// Sends ICMPv6 echo requests to ::1 only (the loopback interface: nothing leaves this machine).
// Opening an ICMPv6 socket needs either unprivileged ICMP datagram sockets (Linux
// ping_group_range, macOS) or administrator rights (raw socket); without them the test is skipped.
func TestEcho6Loopback(t *testing.T) {
	loop := netip.IPv6Loopback()
	c, _, err := listen6("::1")
	if err != nil {
		t.Skipf("no ICMPv6 socket on this host without privileges: %v", err)
	}
	_ = c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	replies, err := Echo6(ctx, loop, loop, 0, 1, time.Second)
	if err != nil {
		t.Fatalf("echo to ::1: %v", err)
	}
	if len(replies) != 1 || replies[0].From != loop {
		t.Fatalf("expected one reply from ::1, got %+v", replies)
	}
}

func TestEcho6RefusesIPv4(t *testing.T) {
	if _, err := Echo6(context.Background(), netip.Addr{}, netip.MustParseAddr("127.0.0.1"), 0, 1, time.Millisecond); err == nil {
		t.Fatal("an IPv4 destination must be refused")
	}
}
