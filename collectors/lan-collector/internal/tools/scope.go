package tools

import (
	"errors"
	"net/netip"
)

// The toolbox scope rule (the API applies the same rule before queuing, modules/toolbox/queue.ts):
//
//   - an address of the local kind (RFC 1918 private, loopback, link-local, CGNAT 100.64.0.0/10)
//     must lie inside an authorized network scope of the site, for every tool;
//   - the TCP port check and the service port scan only ever target such in-scope addresses;
//   - ping, traceroute and reverse DNS may target a public address (internet reachability
//     diagnostics: a handful of ICMP/UDP probes, no port scanning);
//   - a DNS lookup of a name sends nothing to the name (it asks the collector's resolver);
//   - unspecified, broadcast, multicast and reserved (240.0.0.0/4) addresses are refused.
//
// The check runs on the address actually probed: for a host name, after it was resolved.

var cgnat = netip.MustParsePrefix("100.64.0.0/10")
var reserved = netip.MustParsePrefix("240.0.0.0/4")
var thisNetwork = netip.MustParsePrefix("0.0.0.0/8")

// ErrOutOfScope is returned for a target the scope rule refuses.
var ErrOutOfScope = errors.New("the target is not inside an authorized network scope of this site")

func isLocalKind(a netip.Addr) bool {
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || cgnat.Contains(a)
}

// scopeOnly are the tools that connect to TCP ports: authorized private scopes only.
func scopeOnly(tool string) bool { return tool == "tcp" || tool == "ports" }

// CheckTarget applies the scope rule to the address a tool is about to probe.
func (r Runner) CheckTarget(tool string, ip string, inScope func(netip.Addr) bool) error {
	a, err := netip.ParseAddr(ip)
	if err != nil || !a.Is4() {
		return errors.New("the target is not an IPv4 address")
	}
	if a.IsUnspecified() || a.IsMulticast() || a == netip.AddrFrom4([4]byte{255, 255, 255, 255}) || reserved.Contains(a) || thisNetwork.Contains(a) {
		return errors.New("this address cannot be a toolbox target (unspecified, broadcast, multicast or reserved)")
	}
	if !isLocalKind(a) {
		if scopeOnly(tool) {
			return errors.New("port checks are only allowed for addresses inside an authorized network scope; public addresses are refused")
		}
		return nil
	}
	if a.IsLoopback() && !r.AllowLoopback {
		return errors.New("loopback addresses are not toolbox targets")
	}
	if inScope == nil || !inScope(a) {
		return ErrOutOfScope
	}
	return nil
}
