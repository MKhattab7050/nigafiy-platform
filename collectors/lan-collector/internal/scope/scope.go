// Package scope decides what the collector is permitted to probe.
//
// A scope arrives from the cloud (where an administrator attested authorization), but the
// collector does not trust it blindly: it re-validates every scope against hard rules and the
// optional local allow-list before sending a single packet.
//
// IPv4 scopes are RFC 1918 ranges no larger than MinPrefixBits and are swept address by address.
// IPv6 scopes are unicast LAN prefixes (unique-local, link-local or global unicast) no larger than
// MinIPv6PrefixBits. An IPv6 LAN is normally a /64 (2^64 addresses): it can never be swept. IPv6
// discovery reads the host's neighbour table and sends one echo request to the link's all-nodes
// multicast group instead; only prefixes of /120 or smaller (at most 256 addresses) may be swept.
package scope

import (
	"errors"
	"fmt"
	"net/netip"
)

var private = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

var loopback = netip.MustParsePrefix("127.0.0.0/8")

const (
	// MinIPv6PrefixBits is the largest IPv6 scope accepted: a /48 (a whole site). Larger ranges are
	// not one organisation's LAN.
	MinIPv6PrefixBits = 48
	// SweepIPv6MinBits is the smallest IPv6 prefix length that may be swept address by address
	// (a /120 = 256 addresses, the same order as an IPv4 /24).
	SweepIPv6MinBits = 120
)

// ErrIPv6TooLargeToSweep explains why an IPv6 prefix larger than /120 is never swept.
var ErrIPv6TooLargeToSweep = errors.New("an IPv6 prefix larger than /120 cannot be swept address by address " +
	"(a /64 holds 18,446,744,073,709,551,616 addresses): IPv6 discovery reads the neighbour table and " +
	"sends one echo request to the all-nodes multicast group (ff02::1) of the link instead")

type Policy struct {
	MinPrefixBits int            // IPv4: e.g. 20 → nothing larger than a /20
	Allowed       []netip.Prefix // optional local allow-list
	AllowLoopback bool           // development/test only
}

// Check returns the normalised prefix if it may be probed, or an error explaining why not.
func (p Policy) Check(cidr string) (netip.Prefix, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("not a valid CIDR")
	}
	if prefix.Addr().Zone() != "" {
		return netip.Prefix{}, fmt.Errorf("a scope cannot carry an interface zone")
	}
	prefix = prefix.Masked()
	if prefix.Addr().Is4() {
		if err := p.check4(prefix); err != nil {
			return netip.Prefix{}, err
		}
	} else if err := p.check6(prefix); err != nil {
		return netip.Prefix{}, err
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

func (p Policy) check4(prefix netip.Prefix) error {
	if prefix.Bits() < p.MinPrefixBits {
		return fmt.Errorf("scope is larger than the /%d maximum", p.MinPrefixBits)
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
		return fmt.Errorf("not a private (RFC 1918) range")
	}
	return nil
}

func (p Policy) check6(prefix netip.Prefix) error {
	addr := prefix.Addr()
	if addr.Is4In6() {
		return fmt.Errorf("IPv4-mapped IPv6 ranges are not scopes: authorize the IPv4 range instead")
	}
	cls := ClassOf(addr)
	if p.AllowLoopback && cls == ClassLoopback && prefix.Bits() == 128 {
		return nil
	}
	if prefix.Bits() < MinIPv6PrefixBits {
		return fmt.Errorf("IPv6 scope is larger than the /%d maximum", MinIPv6PrefixBits)
	}
	// Every class boundary is a /23 or shorter except AS112 (/48), so a /48-or-longer prefix lies
	// inside exactly one class: the class of its network address.
	switch cls {
	case ClassUniqueLocal, ClassLinkLocal, ClassGlobal:
		return nil
	}
	return fmt.Errorf("not an IPv6 LAN range (unique-local fc00::/7, link-local fe80::/10 or global unicast 2000::/3; " +
		"tunnelling, translation, documentation, multicast and other special-purpose ranges are refused)")
}

func contains(outer, inner netip.Prefix) bool {
	return outer.Addr().BitLen() == inner.Addr().BitLen() && outer.Bits() <= inner.Bits() && outer.Contains(inner.Addr())
}

// Sweepable reports whether every address of the prefix may be probed one by one. IPv4 scopes
// (already bounded by the policy) always may; IPv6 only up to 256 addresses (/120 or longer).
func Sweepable(prefix netip.Prefix) error {
	if prefix.Addr().Is6() && prefix.Bits() < SweepIPv6MinBits {
		return ErrIPv6TooLargeToSweep
	}
	return nil
}

// Hosts lists the probeable addresses of a prefix. For IPv4 the network and broadcast addresses
// are skipped for anything larger than a /31. For IPv6 the all-zero subnet-router anycast address
// is skipped for anything larger than a /127. A prefix that is not Sweepable yields nothing.
func Hosts(prefix netip.Prefix) []netip.Addr {
	prefix = prefix.Masked()
	if Sweepable(prefix) != nil {
		return nil
	}
	hostBits := prefix.Addr().BitLen() - prefix.Bits()
	size := 1 << hostBits
	out := make([]netip.Addr, 0, size)
	addr := prefix.Addr()
	v6 := prefix.Addr().Is6()
	for i := 0; i < size; i++ {
		skip := false
		if v6 {
			skip = i == 0 && size > 2
		} else {
			skip = (i == 0 || i == size-1) && size > 2
		}
		if !skip {
			out = append(out, addr)
		}
		addr = addr.Next()
	}
	return out
}
