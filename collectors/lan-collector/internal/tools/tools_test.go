package tools

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/lan-detective/lan-collector/internal/probe"
)

func TestValidTarget(t *testing.T) {
	for target, want := range map[string]bool{
		"192.168.1.1":        true,
		"example.com":        true,
		"printer-2.office":   true,
		"host":               true,
		"_dmarc.example.com": false, // a host name starts with a letter or digit
		"":                   false,
		"-h":                 false, // would be read as an option
		"--help":             false,
		"a b":                false,
		"host;reboot":        false,
		"$(id)":              false,
		"1.2.3.4 -t":         false,
		"::1":                true, // syntax only: the scope rule decides
		"fd00::5":            true,
		"fe80::1":            true,  // refused later by the scope rule (link-local)
		"fe80::1%eth0":       false, // no zones
		"::ffff:192.0.2.1":   false, // IPv4-mapped
		"a..b":               false,
	} {
		if got := ValidTarget(target); got != want {
			t.Errorf("ValidTarget(%q) = %v, want %v", target, got, want)
		}
	}
}

func TestParseTraceWindows(t *testing.T) {
	out := "\r\nTracing route to 1.1.1.1 over a maximum of 20 hops\r\n\r\n" +
		"  1    <1 ms    <1 ms     1 ms  192.168.1.2 \r\n" +
		"  2     8 ms     7 ms     9 ms  10.45.0.1 \r\n" +
		"  3     *        *        *     Request timed out.\r\n" +
		"  4    22 ms    21 ms    23 ms  1.1.1.1 \r\n\r\nTrace complete.\r\n"
	got := ParseTrace(out)
	want := []Hop{
		{N: 1, Address: "192.168.1.2", RTTMs: []float64{1, 1, 1}},
		{N: 2, Address: "10.45.0.1", RTTMs: []float64{8, 7, 9}},
		{N: 3},
		{N: 4, Address: "1.1.1.1", RTTMs: []float64{22, 21, 23}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseTraceUnix(t *testing.T) {
	out := "traceroute to 1.1.1.1 (1.1.1.1), 20 hops max, 60 byte packets\n" +
		" 1  192.168.1.2  0.412 ms  0.398 ms\n" +
		" 2  * *\n" +
		" 3  1.1.1.1  11.204 ms  10.9 ms\n"
	got := ParseTrace(out)
	want := []Hop{
		{N: 1, Address: "192.168.1.2", RTTMs: []float64{0.412, 0.398}},
		{N: 2},
		{N: 3, Address: "1.1.1.1", RTTMs: []float64{11.204, 10.9}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if hops := ParseTrace("20 hops is the maximum\nnothing here\n"); len(hops) != 0 {
		t.Fatalf("prose parsed as hops: %+v", hops)
	}
}

func TestParseTraceIPv6(t *testing.T) {
	win := "\r\r\nTracing route to 2606:4700:4700::1111 over a maximum of 20 hops\r\r\n\r\r\n" +
		"  1    <1 ms    <1 ms    <1 ms  fd00:70::1 \r\r\n" +
		"  2     *        *        *     Request timed out.\r\r\n" +
		"  3    12 ms    11 ms    12 ms  2606:4700:4700::1111 \r\r\n"
	want := []Hop{{N: 1, Address: "fd00:70::1", RTTMs: []float64{1, 1, 1}}, {N: 2}, {N: 3, Address: "2606:4700:4700::1111", RTTMs: []float64{12, 11, 12}}}
	if got := ParseTrace(win); !reflect.DeepEqual(got, want) {
		t.Fatalf("windows: got %+v\r\nwant %+v", got, want)
	}
	unix := "traceroute to 2606:4700:4700::1111 (2606:4700:4700::1111), 20 hops max, 80 byte packets\r\n" +
		" 1  fd00:70::1  0.512 ms  0.4 ms\r\n" +
		" 2  2606:4700:4700::1111  10.1 ms  10.3 ms\r\n"
	want = []Hop{{N: 1, Address: "fd00:70::1", RTTMs: []float64{0.512, 0.4}}, {N: 2, Address: "2606:4700:4700::1111", RTTMs: []float64{10.1, 10.3}}}
	if got := ParseTrace(unix); !reflect.DeepEqual(got, want) {
		t.Fatalf("unix: got %+v\r\nwant %+v", got, want)
	}
}

func TestRun(t *testing.T) {
	latency, loss := 2.5, 0.0
	r := Runner{
		ICMP: func(_ context.Context, ip string) probe.Result {
			return probe.Result{OK: true, LatencyMs: &latency, LossPct: &loss, Resolved: ip}
		},
		TCP: func(_ context.Context, _ string, port int) probe.Result {
			if port == 22 {
				return probe.Result{OK: true, LatencyMs: &latency, Resolved: "192.168.1.9"}
			}
			return probe.Result{Error: "connection refused"}
		},
	}
	ctx := context.Background()
	lan := netip.MustParsePrefix("192.168.1.0/24")
	inLAN := func(a netip.Addr) bool { return lan.Contains(a) }

	out, err := r.Run(ctx, Request{Tool: "ping", Target: "192.168.1.9", InScope: inLAN})
	if err != nil || out["replied"] != true || out["latency_ms"] != 2.5 || out["resolved"] != "192.168.1.9" {
		t.Fatalf("ping: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "tcp", Target: "192.168.1.9", Port: 22, InScope: inLAN})
	if err != nil || out["open"] != true {
		t.Fatalf("tcp open: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "tcp", Target: "192.168.1.9", Port: 23, InScope: inLAN})
	if err != nil || out["open"] != false || out["detail"] != "connection refused" {
		t.Fatalf("tcp closed: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "ports", Target: "192.168.1.9", InScope: inLAN})
	if err != nil {
		t.Fatalf("ports: %v", err)
	}
	if open, ok := out["open_ports"].([]OpenPort); !ok || len(open) != 1 || open[0].Port != 22 {
		t.Fatalf("ports open_ports: %+v", out)
	}
	for _, bad := range []Request{
		{Tool: "tcp", Target: "192.168.1.9"},            // no port
		{Tool: "tcp", Target: "8.8.8.8", Port: 53},      // public IP refused for TCP check
		{Tool: "tcp", Target: "127.0.0.1", Port: 22},    // loopback refused unless explicitly allowed
		{Tool: "ping", Target: "-n 100000 192.168.1.9"}, // not a target
		{Tool: "dns", Target: "192.168.1.9"},            // needs a name
		{Tool: "rdns", Target: "example.com"},           // needs an address
		{Tool: "ports", Target: "8.8.8.8"},              // public IP refused for port scan
		{Tool: "ports", Target: "127.0.0.1"},            // loopback refused unless explicitly allowed
		{Tool: "shell", Target: "192.168.1.9"},          // not on the list
		{Tool: "traceroute", Target: "$(reboot)"},
	} {
		if _, err := r.Run(ctx, bad); err == nil {
			t.Errorf("expected %+v to be refused", bad)
		}
	}
	rLoop := r
	rLoop.AllowLoopback = true
	loop := func(a netip.Addr) bool { return a.IsLoopback() }
	if _, err := rLoop.Run(ctx, Request{Tool: "tcp", Target: "127.0.0.1", Port: 22, InScope: loop}); err != nil {
		t.Fatalf("expected loopback tcp to succeed when AllowLoopback=true: %v", err)
	}
	if _, err := rLoop.Run(ctx, Request{Tool: "ports", Target: "127.0.0.1", InScope: loop}); err != nil {
		t.Fatalf("expected loopback ports to succeed when AllowLoopback=true: %v", err)
	}
}

func TestScopeRule(t *testing.T) {
	icmpCalls := 0
	latency := 1.0
	r := Runner{
		ICMP: func(_ context.Context, ip string) probe.Result {
			icmpCalls++
			return probe.Result{OK: true, LatencyMs: &latency}
		},
		TCP: func(context.Context, string, int) probe.Result {
			t.Fatal("TCP probe must not run for a refused target")
			return probe.Result{}
		},
	}
	scope := netip.MustParsePrefix("192.168.70.0/24")
	in := func(a netip.Addr) bool { return scope.Contains(a) }
	ctx := context.Background()

	// In scope: allowed for ping.
	if _, err := r.Run(ctx, Request{Tool: "ping", Target: "192.168.70.5", InScope: in}); err != nil {
		t.Fatalf("in-scope ping refused: %v", err)
	}
	// Public: ping allowed (diagnostics), TCP and port scan refused before any probe.
	if _, err := r.Run(ctx, Request{Tool: "ping", Target: "1.1.1.1", InScope: in}); err != nil {
		t.Fatalf("public ping refused: %v", err)
	}
	for _, req := range []Request{
		{Tool: "ping", Target: "10.20.30.40", InScope: in},       // private, outside every scope
		{Tool: "traceroute", Target: "172.16.0.1", InScope: in},  // private, outside
		{Tool: "rdns", Target: "192.168.71.1", InScope: in},      // private, outside
		{Tool: "ping", Target: "192.168.70.5"},                   // no scopes delivered: nothing local
		{Tool: "ping", Target: "169.254.1.1", InScope: in},       // link-local, outside
		{Tool: "ping", Target: "100.64.0.1", InScope: in},        // CGNAT, outside
		{Tool: "tcp", Target: "1.1.1.1", Port: 443, InScope: in}, // public port check
		{Tool: "ports", Target: "8.8.8.8", InScope: in},          // public port scan
		{Tool: "tcp", Target: "10.0.0.1", Port: 22, InScope: in}, // private, outside
		{Tool: "ping", Target: "255.255.255.255", InScope: in},
		{Tool: "ping", Target: "224.0.0.1", InScope: in},
		{Tool: "ping", Target: "240.0.0.1", InScope: in},
		{Tool: "ping", Target: "0.0.0.0", InScope: in},
		{Tool: "ping", Target: "127.0.0.1", InScope: func(netip.Addr) bool { return true }}, // loopback not allowed
	} {
		before := icmpCalls
		if _, err := r.Run(ctx, req); err == nil {
			t.Errorf("expected %s %s to be refused", req.Tool, req.Target)
		}
		if icmpCalls != before {
			t.Errorf("%s %s: probe ran although the target was refused", req.Tool, req.Target)
		}
	}
	// IPv6: unique-local and global addresses inside a scope are LAN addresses.
	scope6 := netip.MustParsePrefix("fd00:70::/64")
	global6 := netip.MustParsePrefix("2a01:4f8:70:1::/64")
	in6 := func(a netip.Addr) bool { return scope6.Contains(a) || global6.Contains(a) }
	for _, req := range []Request{
		{Tool: "ping", Target: "fd00:70::5", InScope: in6},
		{Tool: "rdns", Target: "fd00:70::5", InScope: in6},
		{Tool: "ping", Target: "2a01:4f8:70:1::9", InScope: in6},
		{Tool: "ping", Target: "2606:4700:4700::1111", InScope: in6}, // public IPv6: diagnostics allowed
	} {
		if _, err := r.Run(ctx, req); err != nil {
			t.Errorf("expected %s %s to be allowed: %v", req.Tool, req.Target, err)
		}
	}
	for _, req := range []Request{
		{Tool: "ping", Target: "fd00:71::5", InScope: in6},                                // unique-local, outside every scope
		{Tool: "ping", Target: "fe80::1", InScope: func(netip.Addr) bool { return true }}, // link-local: never
		{Tool: "ping", Target: "ff02::1", InScope: in6},                                   // multicast
		{Tool: "ping", Target: "2001:db8::1", InScope: in6},                               // documentation
		{Tool: "ping", Target: "2002:c000:201::1", InScope: in6},                          // 6to4
		{Tool: "ping", Target: "::", InScope: in6},                                        // unspecified
		{Tool: "ping", Target: "::1", InScope: func(netip.Addr) bool { return true }},     // loopback not allowed
		{Tool: "tcp", Target: "2606:4700:4700::1111", Port: 443, InScope: in6},            // public port check
	} {
		before := icmpCalls
		if _, err := r.Run(ctx, req); err == nil {
			t.Errorf("expected %s %s to be refused", req.Tool, req.Target)
		}
		if icmpCalls != before {
			t.Errorf("%s %s: probe ran although the target was refused", req.Tool, req.Target)
		}
	}
	if err := r.CheckTarget("ping", "10.1.1.1", in); !errors.Is(err, ErrOutOfScope) {
		t.Fatalf("expected ErrOutOfScope, got %v", err)
	}
}
