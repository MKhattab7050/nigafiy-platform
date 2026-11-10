package tools

import (
	"context"
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
		"::1":                false, // IPv4 only
		"fe80::1":            false,
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

	out, err := r.Run(ctx, Request{Tool: "ping", Target: "192.168.1.9"})
	if err != nil || out["replied"] != true || out["latency_ms"] != 2.5 || out["resolved"] != "192.168.1.9" {
		t.Fatalf("ping: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "tcp", Target: "192.168.1.9", Port: 22})
	if err != nil || out["open"] != true {
		t.Fatalf("tcp open: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "tcp", Target: "192.168.1.9", Port: 23})
	if err != nil || out["open"] != false || out["detail"] != "connection refused" {
		t.Fatalf("tcp closed: %v %v", out, err)
	}
	out, err = r.Run(ctx, Request{Tool: "ports", Target: "192.168.1.9"})
	if err != nil {
		t.Fatalf("ports: %v", err)
	}
	if open, ok := out["open_ports"].([]OpenPort); !ok || len(open) != 1 || open[0].Port != 22 {
		t.Fatalf("ports open_ports: %+v", out)
	}
	for _, bad := range []Request{
		{Tool: "tcp", Target: "192.168.1.9"},            // no port
		{Tool: "ping", Target: "-n 100000 192.168.1.9"}, // not a target
		{Tool: "dns", Target: "192.168.1.9"},            // needs a name
		{Tool: "rdns", Target: "example.com"},           // needs an address
		{Tool: "ports", Target: "8.8.8.8"},              // public IP refused for port scan
		{Tool: "shell", Target: "192.168.1.9"},          // not on the list
		{Tool: "traceroute", Target: "$(reboot)"},
	} {
		if _, err := r.Run(ctx, bad); err == nil {
			t.Errorf("expected %+v to be refused", bad)
		}
	}
}
