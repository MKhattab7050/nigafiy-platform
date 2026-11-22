package scope

import "net/netip"

// Class is the kind of an IPv6 address. The table is the same one the API applies
// (apps/api/src/common/net.ts ipv6Class), so both sides agree on every address.
type Class int

const (
	ClassOther       Class = iota // unspecified, multicast, IPv4-mapped / translated, special purpose
	ClassLoopback                 // ::1
	ClassLinkLocal                // fe80::/10 (RFC 4291): meaningful on one link only
	ClassUniqueLocal              // fc00::/7 (RFC 4193)
	ClassGlobal                   // 2000::/3 (RFC 3587) minus the special-purpose blocks inside it
)

func (c Class) String() string {
	switch c {
	case ClassLoopback:
		return "loopback"
	case ClassLinkLocal:
		return "link_local"
	case ClassUniqueLocal:
		return "unique_local"
	case ClassGlobal:
		return "global"
	}
	return "other"
}

var (
	linkLocal     = netip.MustParsePrefix("fe80::/10")
	uniqueLocal   = netip.MustParsePrefix("fc00::/7")
	globalUnicast = netip.MustParsePrefix("2000::/3")
	// Special-purpose blocks inside 2000::/3 that are never somebody's LAN.
	specialInGlobal = []netip.Prefix{
		netip.MustParsePrefix("2001::/23"),         // IETF protocol assignments (RFC 2928): Teredo, benchmarking, ORCHID, AMT…
		netip.MustParsePrefix("2001:db8::/32"),     // documentation (RFC 3849)
		netip.MustParsePrefix("2002::/16"),         // 6to4 relays (RFC 3056)
		netip.MustParsePrefix("2620:4f:8000::/48"), // AS112 (RFC 7534)
		netip.MustParsePrefix("3fff::/20"),         // documentation (RFC 9637)
	}
)

// ClassOf classifies an IPv6 address (an IPv4 address is ClassOther). The zone is ignored.
func ClassOf(a netip.Addr) Class {
	a = a.WithZone("")
	if !a.Is6() || a.Is4In6() {
		return ClassOther
	}
	switch {
	case a == netip.IPv6Loopback():
		return ClassLoopback
	case linkLocal.Contains(a):
		return ClassLinkLocal
	case uniqueLocal.Contains(a):
		return ClassUniqueLocal
	case globalUnicast.Contains(a):
		for _, p := range specialInGlobal {
			if p.Contains(a) {
				return ClassOther
			}
		}
		return ClassGlobal
	}
	return ClassOther
}

// IsLinkLocal reports whether an address is IPv6 link-local (fe80::/10).
func IsLinkLocal(a netip.Addr) bool { return ClassOf(a) == ClassLinkLocal }
