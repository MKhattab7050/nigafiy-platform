// Package watch runs the application-level monitoring checks: HTTP(S) requests, TLS certificate
// expiry and single SNMP OID reads. Every TCP connection goes through Guard, which decides — for
// each resolved address, on every redirect hop — whether the collector may connect there at all.
//
// The rule (the API applies the same one before a check is stored, apps/api monitoring/kinds.ts;
// documented in docs/features/watch-checks.md):
//   - an address inside one of the site's authorized scopes (delivered by the cloud and re-validated
//     by the collector's own scope policy: never larger than the hard limit, inside the local
//     allowed_cidrs when set) is allowed;
//   - a public, globally routable IPv4 address is allowed only when the check explicitly opts in
//     (allow_public), the same way webhook and e-mail destinations must be public;
//   - everything else is refused: private addresses outside the scopes, loopback, link-local
//     (169.254.0.0/16, which includes cloud metadata endpoints), CGNAT, multicast, reserved and
//     documentation ranges, and IPv6 (scopes are IPv4 only).
//
// A host name is resolved by the collector and every address it resolves to must pass; the
// connection then goes to exactly the address that was checked, so a DNS answer cannot change
// between the check and the connection. HTTP proxies from the environment are never used.
package watch

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"
)

// Guard decides which addresses a check may connect to.
type Guard struct {
	// Scopes are the authorized ranges, already accepted by the collector's scope policy.
	Scopes []netip.Prefix
	// AllowPublic lets the check reach public internet addresses (explicit per-check opt-in).
	AllowPublic bool
	// Resolve looks up the IPv4 addresses of a host name; nil uses the system resolver.
	Resolve func(ctx context.Context, host string) ([]netip.Addr, error)
}

// RefusedError is a connection the guard did not allow. It is never a network failure: nothing was sent.
type RefusedError struct{ Reason string }

func (e *RefusedError) Error() string { return "refused: " + e.Reason }

// IsRefused reports whether err (or anything it wraps) is a guard refusal.
func IsRefused(err error) bool {
	var r *RefusedError
	return errors.As(err, &r)
}

var notPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

// IsPublicIPv4 reports whether addr is a globally routable unicast IPv4 address.
func IsPublicIPv4(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.Is4() {
		return false
	}
	for _, p := range notPublic {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

// Allow returns nil when the check may connect to addr, or a RefusedError that explains why not.
func (g Guard) Allow(addr netip.Addr) error {
	addr = addr.Unmap()
	if !addr.Is4() {
		return &RefusedError{fmt.Sprintf("%s is not an IPv4 address (authorized scopes are IPv4 only)", addr)}
	}
	for _, p := range g.Scopes {
		if p.Contains(addr) {
			return nil
		}
	}
	if IsPublicIPv4(addr) {
		if g.AllowPublic {
			return nil
		}
		return &RefusedError{fmt.Sprintf("%s is a public address and this check does not allow public hosts", addr)}
	}
	return &RefusedError{fmt.Sprintf("%s is outside the authorized ranges of this site", addr)}
}

func (g Guard) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{a}, nil
	}
	if g.Resolve != nil {
		return g.Resolve(ctx, host)
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(rctx, "ip4", host)
	if err != nil || len(addrs) == 0 {
		return nil, errors.New("name does not resolve")
	}
	return addrs, nil
}

// Vet resolves host and returns the address to connect to. Every resolved address must be allowed.
func (g Guard) Vet(ctx context.Context, host string) (netip.Addr, error) {
	addrs, err := g.resolve(ctx, host)
	if err != nil {
		return netip.Addr{}, err
	}
	if len(addrs) == 0 {
		return netip.Addr{}, errors.New("name does not resolve")
	}
	for _, a := range addrs {
		if err := g.Allow(a); err != nil {
			return netip.Addr{}, err
		}
	}
	return addrs[0].Unmap(), nil
}

// dialer connects only to vetted addresses and remembers the last address it connected to.
type dialer struct {
	g       Guard
	d       net.Dialer
	mu      sync.Mutex
	address string
}

func newDialer(g Guard, timeout time.Duration) *dialer {
	return &dialer{g: g, d: net.Dialer{Timeout: timeout}}
}

func (x *dialer) DialContext(ctx context.Context, _ string, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addr, err := x.g.Vet(ctx, host)
	if err != nil {
		return nil, err
	}
	x.mu.Lock()
	x.address = addr.String()
	x.mu.Unlock()
	return x.d.DialContext(ctx, "tcp4", net.JoinHostPort(addr.String(), port))
}

func (x *dialer) last() string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.address
}

// Result is one sample of a watch check, mapped by the agent onto a check_result item.
type Result struct {
	OK        bool
	LatencyMs *float64
	Error     string
	// Value is the measured number: HTTP status code, TLS days remaining, the OID value.
	Value *float64
	// Resolved is the address actually connected to.
	Resolved string
	// Details is the evidence of this sample (never the response body itself).
	Details map[string]any
}

func ms(d time.Duration) *float64 {
	v := float64(d.Microseconds()) / 1000
	return &v
}

func num(v float64) *float64 { return &v }

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
