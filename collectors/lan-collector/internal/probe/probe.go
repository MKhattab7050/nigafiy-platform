// Package probe contains the collector's active measurements: ICMP echo, TCP connect and DNS
// resolution. All of them are single, low-rate, standards-compliant requests — no port scanning,
// no payload inspection, nothing stealthy.
package probe

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"runtime"
	"sync"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// Result is one check measurement.
type Result struct {
	OK        bool
	LatencyMs *float64
	LossPct   *float64
	JitterMs  *float64
	Error     string
	Resolved  string
}

func ms(d time.Duration) *float64 {
	v := math.Round(float64(d)/float64(time.Millisecond)*1000) / 1000
	return &v
}

// ICMP sends echo requests. On Linux it prefers unprivileged ICMP datagram sockets
// (net.ipv4.ping_group_range) and falls back to raw sockets (CAP_NET_RAW).
type ICMP struct {
	once       sync.Once
	privileged bool
}

func (p *ICMP) detect() {
	p.once.Do(func() {
		if runtime.GOOS == "windows" {
			p.privileged = true // the only mode pro-bing supports there; does not require elevation
			return
		}
		test, err := probing.NewPinger("127.0.0.1")
		if err != nil {
			return
		}
		test.Count = 1
		test.Timeout = time.Second
		test.SetPrivileged(false)
		if err := test.Run(); err != nil {
			p.privileged = true
		}
	})
}

func (p *ICMP) run(ctx context.Context, ip string, count int, interval, timeout time.Duration) (*probing.Statistics, error) {
	p.detect()
	pinger, err := probing.NewPinger(ip)
	if err != nil {
		return nil, err
	}
	pinger.SetPrivileged(p.privileged)
	pinger.Count = count
	pinger.Interval = interval
	pinger.Timeout = timeout
	pinger.RecordRtts = true
	if err := pinger.RunWithContext(ctx); err != nil {
		return nil, err
	}
	return pinger.Statistics(), nil
}

// Ping sends a single echo request. It implements discovery.Prober.
func (p *ICMP) Ping(ctx context.Context, ip string, timeout time.Duration) (time.Duration, bool) {
	stats, err := p.run(ctx, ip, 1, time.Second, timeout)
	if err != nil || stats.PacketsRecv == 0 {
		return 0, false
	}
	return stats.AvgRtt, true
}

// Check measures latency, loss and jitter with 5 echo requests over about one second.
func (p *ICMP) Check(ctx context.Context, ip string) Result {
	const count = 5
	stats, err := p.run(ctx, ip, count, 200*time.Millisecond, 3*time.Second)
	if err != nil {
		return Result{Error: truncate(err.Error()), Resolved: ip}
	}
	loss := math.Round(stats.PacketLoss*100) / 100
	res := Result{OK: stats.PacketsRecv > 0, LossPct: &loss, Resolved: ip}
	if stats.PacketsRecv == 0 {
		res.Error = fmt.Sprintf("no echo reply (%d requests sent)", stats.PacketsSent)
		return res
	}
	res.LatencyMs = ms(stats.AvgRtt)
	if len(stats.Rtts) > 1 {
		// Jitter = mean absolute difference between consecutive round-trip times (RFC 3550 style).
		var sum time.Duration
		for i := 1; i < len(stats.Rtts); i++ {
			d := stats.Rtts[i] - stats.Rtts[i-1]
			if d < 0 {
				d = -d
			}
			sum += d
		}
		res.JitterMs = ms(sum / time.Duration(len(stats.Rtts)-1))
	}
	return res
}

// TCP measures the time to complete a TCP handshake, then closes the connection without sending data.
func TCP(ctx context.Context, host string, port int) Result {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var d net.Dialer
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp4", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return Result{Error: truncate(dialError(err))}
	}
	elapsed := time.Since(start)
	resolved, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
	_ = conn.Close()
	return Result{OK: true, LatencyMs: ms(elapsed), Resolved: resolved}
}

// DNS measures how long the host's configured resolver takes to resolve a name.
func DNS(ctx context.Context, name string) Result {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resolver := &net.Resolver{PreferGo: true} // bypass the OS cache where possible so we measure the resolver
	start := time.Now()
	addrs, err := resolver.LookupHost(ctx, name)
	elapsed := time.Since(start)
	if err != nil {
		return Result{Error: truncate(dialError(err))}
	}
	if len(addrs) == 0 {
		return Result{Error: "resolver returned no addresses"}
	}
	return Result{OK: true, LatencyMs: ms(elapsed), Resolved: addrs[0]}
}

// ReverseName returns the PTR name of ip, or "" (bounded wait; failure is normal on most LANs).
func ReverseName(ctx context.Context, ip string) string {
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	names, err := net.DefaultResolver.LookupAddr(ctx, ip)
	if err != nil || len(names) == 0 {
		return ""
	}
	name := names[0]
	if n := len(name); n > 1 && name[n-1] == '.' {
		name = name[:n-1]
	}
	if len(name) > 253 {
		return ""
	}
	return name
}

func dialError(err error) string {
	var dnsErr *net.DNSError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timed out"
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound:
		return "name does not resolve"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Err != nil {
		return opErr.Err.Error()
	}
	return err.Error()
}

func truncate(s string) string {
	if len(s) > 280 {
		return s[:280]
	}
	return s
}
