// Package tools runs the IT toolbox requests an administrator makes from the dashboard: ping,
// TCP port check, DNS lookup, reverse DNS and traceroute. It is a closed list. Each tool takes one
// validated target; nothing here runs text supplied by the server as a command.
package tools

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/probe"
)

// Request is one toolbox run.
type Request struct {
	RunID  string `json:"run_id"`
	Tool   string `json:"tool"`
	Target string `json:"target"`
	Port   int    `json:"port,omitempty"`
	// InScope reports whether an address lies inside an authorized network scope of the site. Set by
	// the agent from its delivered scopes (never from the request payload); nil refuses every
	// local-kind address.
	InScope func(netip.Addr) bool `json:"-"`
}

const (
	maxHops           = 20
	tracerouteTimeout = 75 * time.Second
)

// A target is an IPv4 address or a host name. The pattern cannot start with "-", so a target can
// never be read as an option by a program it is handed to.
var hostname = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}))*\.?$`)

// ValidTarget reports whether s is an IPv4 address or a syntactically valid host name.
func ValidTarget(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	if ip := net.ParseIP(s); ip != nil {
		return ip.To4() != nil
	}
	return hostname.MatchString(s)
}

// Runner holds the probes the tools are built from.
type Runner struct {
	ICMP          func(ctx context.Context, ip string) probe.Result
	TCP           func(ctx context.Context, host string, port int) probe.Result
	AllowLoopback bool
}

func resolveIPv4(ctx context.Context, host string) (string, error) {
	if ip := net.ParseIP(host); ip != nil {
		return ip.String(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if err != nil || len(ips) == 0 {
		return "", errors.New("the name does not resolve to an IPv4 address")
	}
	return ips[0].String(), nil
}

func round(ms float64) float64 { return float64(int(ms*100+0.5)) / 100 }

// Run executes one request and returns what was measured. An error means the tool could not give
// an answer at all (bad request, name does not resolve); "host did not reply" is a result, not an error.
func (r Runner) Run(ctx context.Context, req Request) (map[string]any, error) {
	if !ValidTarget(req.Target) {
		return nil, errors.New("the target is not an IPv4 address or a host name")
	}
	switch req.Tool {
	case "ping":
		ip, err := resolveIPv4(ctx, req.Target)
		if err != nil {
			return nil, err
		}
		if err := r.CheckTarget(req.Tool, ip, req.InScope); err != nil {
			return nil, err
		}
		res := r.ICMP(ctx, ip)
		out := map[string]any{"resolved": ip, "replied": res.OK, "requests": 5}
		if res.LatencyMs != nil {
			out["latency_ms"] = *res.LatencyMs
		}
		if res.LossPct != nil {
			out["loss_pct"] = *res.LossPct
		}
		if res.JitterMs != nil {
			out["jitter_ms"] = *res.JitterMs
		}
		if res.Error != "" {
			out["detail"] = res.Error
		}
		return out, nil

	case "tcp":
		if req.Port < 1 || req.Port > 65535 {
			return nil, errors.New("a port between 1 and 65535 is required")
		}
		ip, err := resolveIPv4(ctx, req.Target)
		if err != nil {
			return nil, err
		}
		if err := r.CheckTarget(req.Tool, ip, req.InScope); err != nil {
			return nil, err
		}
		res := r.TCP(ctx, ip, req.Port)
		out := map[string]any{"port": req.Port, "open": res.OK}
		if res.LatencyMs != nil {
			out["connect_ms"] = *res.LatencyMs
		}
		if res.Resolved != "" {
			out["resolved"] = res.Resolved
		}
		if res.Error != "" {
			out["detail"] = res.Error
		}
		return out, nil

	case "dns":
		if net.ParseIP(req.Target) != nil {
			return nil, errors.New("a DNS lookup needs a name; use reverse DNS for an address")
		}
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		start := time.Now()
		addrs, err := net.DefaultResolver.LookupHost(c, req.Target)
		elapsed := time.Since(start)
		out := map[string]any{"lookup_ms": round(float64(elapsed.Microseconds()) / 1000), "resolver": "the collector host's configured DNS resolver"}
		if err != nil {
			out["found"] = false
			out["detail"] = dnsError(err)
			return out, nil
		}
		if len(addrs) > 16 {
			addrs = addrs[:16]
		}
		out["found"] = len(addrs) > 0
		out["addresses"] = addrs
		return out, nil

	case "rdns":
		ip := net.ParseIP(req.Target)
		if ip == nil {
			return nil, errors.New("reverse DNS needs an IPv4 address")
		}
		if err := r.CheckTarget(req.Tool, ip.String(), req.InScope); err != nil {
			return nil, err
		}
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		names, err := net.DefaultResolver.LookupAddr(c, ip.String())
		out := map[string]any{}
		if err != nil || len(names) == 0 {
			out["found"] = false
			if err != nil {
				out["detail"] = dnsError(err)
			}
			return out, nil
		}
		if len(names) > 8 {
			names = names[:8]
		}
		for i, n := range names {
			names[i] = strings.TrimSuffix(n, ".")
		}
		out["found"] = true
		out["names"] = names
		return out, nil

	case "traceroute":
		ip, err := resolveIPv4(ctx, req.Target)
		if err != nil {
			return nil, err
		}
		if err := r.CheckTarget(req.Tool, ip, req.InScope); err != nil {
			return nil, err
		}
		hops, raw, err := traceroute(ctx, ip)
		if err != nil {
			return nil, err
		}
		reached := len(hops) > 0 && hops[len(hops)-1].Address == ip
		return map[string]any{"resolved": ip, "hops": hops, "reached": reached, "max_hops": maxHops, "method": raw}, nil

	case "ports":
		ip, err := resolveIPv4(ctx, req.Target)
		if err != nil {
			return nil, err
		}
		if err := r.CheckTarget(req.Tool, ip, req.InScope); err != nil {
			return nil, err
		}
		open := r.scanCommonPorts(ctx, ip)
		return map[string]any{"resolved": ip, "checked": len(commonPorts), "open_ports": open}, nil
	}
	return nil, fmt.Errorf("unknown tool %q", req.Tool)
}

type OpenPort struct {
	Port      int     `json:"port"`
	Service   string  `json:"service"`
	ConnectMs float64 `json:"connect_ms,omitempty"`
}

var commonPorts = []struct {
	port    int
	service string
}{
	{21, "FTP"},
	{22, "SSH"},
	{23, "Telnet"},
	{53, "DNS"},
	{80, "HTTP"},
	{88, "Kerberos"},
	{135, "MS-RPC"},
	{139, "NetBIOS"},
	{443, "HTTPS"},
	{445, "SMB"},
	{554, "RTSP"},
	{631, "IPP (Printer)"},
	{3306, "MySQL"},
	{3389, "RDP"},
	{5432, "PostgreSQL"},
	{5900, "VNC"},
	{8080, "HTTP-Alt"},
	{8443, "HTTPS-Alt"},
	{9100, "JetDirect (Printer)"},
}

func (r Runner) scanCommonPorts(ctx context.Context, ip string) []OpenPort {
	sem := make(chan struct{}, 6)
	var mu sync.Mutex
	open := []OpenPort{}
	var wg sync.WaitGroup
	for _, p := range commonPorts {
		wg.Add(1)
		go func(port int, svc string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			c, cancel := context.WithTimeout(ctx, 900*time.Millisecond)
			defer cancel()
			res := r.TCP(c, ip, port)
			if res.OK {
				entry := OpenPort{Port: port, Service: svc}
				if res.LatencyMs != nil {
					entry.ConnectMs = *res.LatencyMs
				}
				mu.Lock()
				open = append(open, entry)
				mu.Unlock()
			}
		}(p.port, p.service)
	}
	wg.Wait()
	sort.Slice(open, func(i, j int) bool { return open[i].Port < open[j].Port })
	return open
}

func dnsError(err error) string {
	var d *net.DNSError
	if errors.As(err, &d) {
		switch {
		case d.IsNotFound:
			return "no such name"
		case d.IsTimeout:
			return "the resolver did not answer in time"
		}
	}
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// Hop is one line of a route trace.
type Hop struct {
	N       int       `json:"n"`
	Address string    `json:"address,omitempty"` // empty: the hop did not answer
	RTTMs   []float64 `json:"rtt_ms,omitempty"`
}

// traceroute runs the operating system's own route tracer with numeric output. The only variable
// argument is an IPv4 address that was parsed and re-formatted by net.ParseIP.
func traceroute(ctx context.Context, ip string) ([]Hop, string, error) {
	if net.ParseIP(ip) == nil {
		return nil, "", errors.New("not an address")
	}
	ctx, cancel := context.WithTimeout(ctx, tracerouteTimeout)
	defer cancel()
	var cmd *exec.Cmd
	var method string
	if runtime.GOOS == "windows" {
		method = "tracert (ICMP)"
		cmd = exec.CommandContext(ctx, "tracert", "-d", "-h", strconv.Itoa(maxHops), "-w", "1000", ip)
	} else {
		method = "traceroute (UDP)"
		cmd = exec.CommandContext(ctx, "traceroute", "-n", "-m", strconv.Itoa(maxHops), "-w", "1", "-q", "2", ip)
	}
	hideWindow(cmd)
	out, err := cmd.Output()
	hops := ParseTrace(string(out))
	if len(hops) == 0 {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, method, errors.New("the route tracing program is not installed on the collector host")
		}
		if ctx.Err() != nil {
			return nil, method, errors.New("the route trace did not finish in time")
		}
		return nil, method, errors.New("the route trace produced no hops")
	}
	return hops, method, nil
}

var (
	hopLine = regexp.MustCompile(`^\s*(\d{1,2})\s+(.*)$`)
	ipv4    = regexp.MustCompile(`\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b`)
	rtt     = regexp.MustCompile(`(<?\d+(?:\.\d+)?)\s*ms`)
)

// ParseTrace reads the hop lines of Windows tracert and Unix traceroute -n output. Lines that are
// not hops (headers, "Trace complete.") are ignored; a hop of only "*" has no address.
func ParseTrace(output string) []Hop {
	var hops []Hop
	for _, line := range strings.Split(output, "\n") {
		m := hopLine.FindStringSubmatch(strings.TrimRight(line, "\r "))
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		rest := m[2]
		// A real hop line contains a reply time or an asterisk; anything else is prose that starts with a number.
		if n < 1 || n > 64 || (!strings.Contains(rest, "*") && !rtt.MatchString(rest)) {
			continue
		}
		if len(hops) > 0 && n != hops[len(hops)-1].N+1 {
			continue
		}
		if len(hops) == 0 && n != 1 {
			continue
		}
		hop := Hop{N: n}
		for _, t := range rtt.FindAllStringSubmatch(rest, 3) {
			if v, err := strconv.ParseFloat(strings.TrimPrefix(t[1], "<"), 64); err == nil {
				hop.RTTMs = append(hop.RTTMs, v)
			}
		}
		// The address comes after the times on Windows and before them on Unix; times never look like addresses.
		if a := ipv4.FindString(rest); a != "" && net.ParseIP(a) != nil {
			hop.Address = a
		}
		hops = append(hops, hop)
	}
	return hops
}
