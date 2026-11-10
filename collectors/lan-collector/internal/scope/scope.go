// Package scope decides what the collector is permitted to probe.
//
// A scope arrives from the cloud (where an administrator attested authorization), but the
// collector does not trust it blindly: it re-validates every scope against hard rules and the
// optional local allow-list before sending a single packet.
package scope

import (
	"fmt"
	"net/netip"
)

var private = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

var loopback = netip.MustParsePrefix("127.0.0.0/8")

type Policy struct {
	MinPrefixBits int            // e.g. 20 → nothing larger than a /20
	Allowed       []netip.Prefix // optional local allow-list
	AllowLoopback bool           // development/test only
}

// Check returns the normalised prefix if it may be probed, or an error explaining why not.
func (p Policy) Check(cidr string) (netip.Prefix, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("not a valid CIDR")
	}
	if !prefix.Addr().Is4() {
		return netip.Prefix{}, fmt.Errorf("only IPv4 scopes are supported")
	}
	prefix = prefix.Masked()
	if prefix.Bits() < p.MinPrefixBits {
		return netip.Prefix{}, fmt.Errorf("scope is larger than the /%d maximum", p.MinPrefixBits)
	}
	ok := false
	for _, r := range private {
		if contains(r, prefix) {
			ok = true
		}
	}
	if p.AllowLoopback && contains(loopback, prefix) {
		ok = true
	}
	if !ok {
		return netip.Prefix{}, fmt.Errorf("not a private (RFC 1918) range")
	}
	if len(p.Allowed) > 0 {
		inside := false
		for _, a := range p.Allowed {
			if contains(a, prefix) {
				inside = true
			}
		}
		if !inside {
			return netip.Prefix{}, fmt.Errorf("outside this collector's local allowed_cidrs")
		}
	}
	return prefix, nil
}

func contains(outer, inner netip.Prefix) bool {
	return outer.Bits() <= inner.Bits() && outer.Contains(inner.Addr())
}

// Hosts lists the probeable addresses of a prefix. Network and broadcast addresses are skipped
// for anything larger than a /31.
func Hosts(prefix netip.Prefix) []netip.Addr {
	prefix = prefix.Masked()
	size := 1 << (32 - prefix.Bits())
	out := make([]netip.Addr, 0, size)
	addr := prefix.Addr()
	for i := 0; i < size; i++ {
		edge := i == 0 || i == size-1
		if !(edge && size > 2) {
			out = append(out, addr)
		}
		addr = addr.Next()
	}
	return out
}
