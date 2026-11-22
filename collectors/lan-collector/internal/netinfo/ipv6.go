package netinfo

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// Neighbor6 is one entry of the host's IPv6 neighbour table (Neighbor Discovery, RFC 4861).
type Neighbor6 struct {
	IP  string // without zone, canonical (RFC 5952)
	MAC string
	// Interface is the name of the interface the entry belongs to ("" when the tool does not say).
	Interface string
	// Reachable means the OS confirmed two-way reachability recently (REACHABLE, DELAY, PROBE). A
	// stale entry still tells which MAC an address had, but is no evidence of presence right now.
	Reachable bool
	// Router means the neighbour announced itself as a router (the IsRouter flag of its advertisements).
	Router bool
}

// parseIPv6 returns the canonical form of an IPv6 address without zone, or "" when s is not one
// (IPv4, IPv4-mapped, multicast, unspecified).
func parseIPv6(s string) string {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	if err != nil || !a.Is6() || a.Is4In6() {
		return ""
	}
	a = a.WithZone("")
	if a.IsMulticast() || a.IsUnspecified() {
		return ""
	}
	return a.String()
}

// ParseIPNeigh6 parses `ip -6 neigh show` (Linux).
//
//	fe80::1 dev eth0 lladdr 00:11:22:33:44:55 router REACHABLE
//	fd00::20 dev eth0 lladdr aa:bb:cc:dd:ee:02 STALE
func ParseIPNeigh6(out string) []Neighbor6 {
	var res []Neighbor6
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 {
			continue
		}
		ip := parseIPv6(f[0])
		if ip == "" {
			continue
		}
		n := Neighbor6{IP: ip}
		state := f[len(f)-1]
		for i := 1; i < len(f); i++ {
			switch f[i] {
			case "dev":
				if i+1 < len(f) {
					n.Interface = f[i+1]
				}
			case "lladdr":
				if i+1 < len(f) {
					n.MAC = NormalizeMAC(f[i+1])
				}
			case "router":
				n.Router = true
			}
		}
		if n.MAC == "" || state == "FAILED" || state == "INCOMPLETE" {
			continue
		}
		n.Reachable = state == "REACHABLE" || state == "DELAY" || state == "PROBE"
		res = append(res, n)
	}
	return res
}

// ParseStateTable6 parses the lines we ask PowerShell's Get-NetNeighbor -AddressFamily IPv6 for:
// "ip mac state alias" (the alias may contain spaces: it is the rest of the line).
func ParseStateTable6(out string) []Neighbor6 {
	var res []Neighbor6
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		ip := parseIPv6(f[0])
		mac := NormalizeMAC(f[1])
		state := f[2]
		if ip == "" || mac == "" || state == "Unreachable" || state == "Incomplete" {
			continue
		}
		n := Neighbor6{IP: ip, MAC: mac, Reachable: state == "Reachable" || state == "Delay" || state == "Probe"}
		if len(f) > 3 {
			n.Interface = strings.Join(f[3:], " ")
		}
		res = append(res, n)
	}
	return res
}

var netshIface = regexp.MustCompile(`^\S[^:]*\s(\d+):\s*(.+?)\s*$`)

// ParseNetshNeighbors6 parses `netsh interface ipv6 show neighbors` (Windows fallback).
//
//	Interface 12: Ethernet
//
//	Internet Address                              Physical Address   Type
//	--------------------------------------------  -----------------  -----------
//	fe80::1                                       00-11-22-33-44-55  Reachable (Router)
//	fd00::20                                      aa-bb-cc-dd-ee-02  Stale
func ParseNetshNeighbors6(out string) []Neighbor6 {
	var res []Neighbor6
	iface := ""
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r ")
		if m := netshIface.FindStringSubmatch(line); m != nil && !strings.Contains(line, "  ") {
			iface = m[2]
			continue
		}
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		ip := parseIPv6(f[0])
		mac := NormalizeMAC(f[1])
		state := f[2]
		if ip == "" || mac == "" || state == "Unreachable" || state == "Incomplete" {
			continue
		}
		res = append(res, Neighbor6{
			IP: ip, MAC: mac, Interface: iface,
			Reachable: state == "Reachable" || state == "Delay" || state == "Probe",
			Router:    strings.Contains(line, "(Router)"),
		})
	}
	return res
}

// ParseNDP parses macOS / BSD `ndp -an`.
//
//	Neighbor                        Linklayer Address  Netif Expire    St Flgs Prbs
//	fe80::1%en0                     0:11:22:33:44:55     en0 23h59m58s S  R
//	fd00::20                        aa:bb:cc:dd:ee:2     en0 permanent R
func ParseNDP(out string) []Neighbor6 {
	var res []Neighbor6
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 {
			continue
		}
		ip := parseIPv6(f[0])
		mac := NormalizeMAC(f[1])
		if ip == "" || mac == "" {
			continue
		}
		state := f[4]
		if state == "I" || state == "N" || state == "W" {
			continue // incomplete, no state, waiting for deletion
		}
		n := Neighbor6{IP: ip, MAC: mac, Interface: f[2], Reachable: state == "R" || state == "D" || state == "P"}
		if len(f) > 5 && strings.Contains(f[5], "R") {
			n.Router = true
		}
		res = append(res, n)
	}
	return res
}

// Neighbors6 returns the host's current IPv6 neighbour table. It only reads OS state.
func Neighbors6(ctx context.Context) ([]Neighbor6, error) {
	switch runtime.GOOS {
	case "linux":
		out, err := run(ctx, "ip", "-6", "neigh", "show")
		if err != nil {
			return nil, fmt.Errorf("IPv6 neighbour table unavailable: %w", err)
		}
		return ParseIPNeigh6(out), nil
	case "windows":
		out, err := run(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command",
			`Get-NetNeighbor -AddressFamily IPv6 | ForEach-Object { "$($_.IPAddress) $($_.LinkLayerAddress) $($_.State) $($_.InterfaceAlias)" }`)
		if err == nil {
			return ParseStateTable6(out), nil
		}
		out, err = run(ctx, "netsh", "interface", "ipv6", "show", "neighbors")
		if err != nil {
			return nil, fmt.Errorf("IPv6 neighbour table unavailable: %w", err)
		}
		return ParseNetshNeighbors6(out), nil
	default:
		out, err := run(ctx, "ndp", "-an")
		if err != nil {
			return nil, fmt.Errorf("IPv6 neighbour table unavailable: %w", err)
		}
		return ParseNDP(out), nil
	}
}

// LinkInterface is an interface of this host that is attached to an IPv6 scope.
type LinkInterface struct {
	Name  string
	Index int
	// Source is this host's own address inside the scope on that interface (for a link-local scope:
	// its link-local address there). Echo requests are sent from it, so devices answer from their
	// own address of the same scope rather than from their link-local one.
	Source netip.Addr
	MAC    string
}

// linkInterfaces is the pure part of LinkInterfaces, for tests.
func linkInterfaces(prefix netip.Prefix, ifaces []ifaceAddrs) []LinkInterface {
	var out []LinkInterface
	for _, i := range ifaces {
		for _, a := range i.addrs {
			if a.Is6() && !a.Is4In6() && prefix.Contains(a.WithZone("")) {
				out = append(out, LinkInterface{Name: i.name, Index: i.index, Source: a.WithZone(""), MAC: i.mac})
				break
			}
		}
	}
	return out
}

type ifaceAddrs struct {
	name  string
	index int
	mac   string
	addrs []netip.Addr
}

func upInterfaces() []ifaceAddrs {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []ifaceAddrs
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		e := ifaceAddrs{name: i.Name, index: i.Index, mac: NormalizeMAC(i.HardwareAddr.String())}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if addr, ok := netip.AddrFromSlice(ipn.IP); ok {
					e.addrs = append(e.addrs, addr.Unmap())
				}
			}
		}
		out = append(out, e)
	}
	return out
}

// LinkInterfaces lists the up, non-loopback interfaces of this host that carry an address inside
// the IPv6 prefix: the links where the scope's devices can be reached by multicast.
func LinkInterfaces(prefix netip.Prefix) []LinkInterface {
	return linkInterfaces(prefix, upInterfaces())
}

// LocalAddrs6 maps each IPv6 address of this host's up interfaces (link-local included, without
// zone) to the MAC of the interface that carries it.
func LocalAddrs6() map[string]string {
	out := map[string]string{}
	for _, i := range upInterfaces() {
		if i.mac == "" {
			continue
		}
		for _, a := range i.addrs {
			if a.Is6() && !a.Is4In6() {
				out[a.WithZone("").String()] = i.mac
			}
		}
	}
	return out
}

// ZoneOf returns the zone to use for a link-scoped address on interface index (the numeric index
// works on every OS, including Windows where interface names contain spaces).
func ZoneOf(index int) string { return strconv.Itoa(index) }
