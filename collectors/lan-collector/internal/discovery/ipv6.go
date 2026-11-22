package discovery

import (
	"context"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/identify"
	"github.com/lan-detective/lan-collector/internal/netinfo"
	"github.com/lan-detective/lan-collector/internal/scope"
)

// MaxUnicast6 bounds the unicast echo requests of one IPv6 discovery (known addresses re-checked).
const MaxUnicast6 = 1024

// Options6 are the IPv6-specific contacts of Discover6 with the host and the network.
type Options6 struct {
	// Neighbors6 reads the host's IPv6 neighbour table.
	Neighbors6 func(ctx context.Context) ([]netinfo.Neighbor6, error)
	// LinkInterfaces lists the host's interfaces that carry an address inside the prefix.
	LinkInterfaces func(prefix netip.Prefix) []netinfo.LinkInterface
	// MulticastEcho sends paced echo requests to ff02::1 on one interface from src and returns who answered.
	MulticastEcho func(ctx context.Context, src netip.Addr, ifIndex int, wait time.Duration) ([]netip.Addr, error)
	// LocalAddrs maps this host's own IPv6 addresses to the MAC of their interface (optional).
	LocalAddrs func() map[string]string
	// MulticastWait is how long replies to the multicast echo are collected (default 2 s).
	MulticastWait time.Duration
}

// Discover6 finds the devices of an IPv6 scope without ever enumerating it (a /64 holds 2^64
// addresses). Method, low impact by design:
//  1. on every interface of this host attached to the prefix: echo requests to the all-nodes group
//     ff02::1 (two, one second apart, hop limit 1), sent from the host's own address of the scope;
//  2. read the host's IPv6 neighbour table (Neighbor Discovery), which those replies filled in;
//  3. one paced unicast echo request to each known address of the prefix that did not answer yet
//     (neighbour-table entries; for a prefix of /120 or smaller: every address, scope.Sweepable);
//  4. read the neighbour table again for MAC addresses and confirmed reachability;
//  5. reverse DNS (PTR) for each device found.
//
// A device is reported present when it answered an echo or the OS confirmed it reachable. A stale
// neighbour entry alone is not presence. Link-local addresses (fe80::/10) on the scope's
// interfaces are reported with the MAC that also holds an address of the scope, as extra evidence
// for that device; on their own they are never a device of a non-link-local scope.
func Discover6(ctx context.Context, prefix netip.Prefix, prober Prober, opt Options, o6 Options6) Result {
	res := Result{StartedAt: time.Now().UTC()}
	prefix = prefix.Masked()
	if !prefix.Addr().Is6() {
		res.FinishedAt = time.Now().UTC()
		return res
	}
	if opt.Concurrency < 1 {
		opt.Concurrency = 1
	}
	if opt.PPS < 1 {
		opt.PPS = 1
	}
	wait := o6.MulticastWait
	if wait <= 0 {
		wait = 2 * time.Second
	}

	var links []netinfo.LinkInterface
	if o6.LinkInterfaces != nil {
		links = o6.LinkInterfaces(prefix)
	}
	onLink := map[string]bool{}
	for _, l := range links {
		onLink[l.Name] = true
	}

	found := map[string]*Host{}
	var mu sync.Mutex
	add := func(ip string, source string) {
		mu.Lock()
		defer mu.Unlock()
		h, ok := found[ip]
		if !ok {
			h = &Host{IP: ip}
			found[ip] = h
		}
		for _, s := range h.Sources {
			if s == source {
				return
			}
		}
		h.Sources = append(h.Sources, source)
	}
	linkLocal := map[string]bool{} // link-local responders kept only if their MAC also holds a scope address

	// 1. multicast echo on each attached link.
	if o6.MulticastEcho != nil {
		for _, l := range links {
			if ctx.Err() != nil {
				break
			}
			from, err := o6.MulticastEcho(ctx, l.Source, l.Index, wait)
			res.HostsProbed += 2
			if err != nil {
				continue
			}
			for _, a := range from {
				a = a.WithZone("")
				switch {
				case prefix.Contains(a):
					add(a.String(), "icmpv6_multicast")
				case scope.IsLinkLocal(a):
					linkLocal[a.String()] = true
				}
			}
		}
	}
	if ctx.Err() != nil {
		res.FinishedAt = time.Now().UTC()
		return res
	}

	// 2. neighbour table: candidates for the unicast echo.
	candidates := map[string]bool{}
	if o6.Neighbors6 != nil {
		if table, err := o6.Neighbors6(ctx); err == nil {
			for _, n := range table {
				if a, err := netip.ParseAddr(n.IP); err == nil && prefix.Contains(a) {
					candidates[a.String()] = true
				}
			}
		}
	}
	if scope.Sweepable(prefix) == nil {
		for _, a := range scope.Hosts(prefix) {
			candidates[a.String()] = true
		}
	}
	var unicast []string
	for ip := range candidates {
		if _, answered := found[ip]; !answered {
			unicast = append(unicast, ip)
		}
	}
	sort.Slice(unicast, func(i, j int) bool { return netip.MustParseAddr(unicast[i]).Less(netip.MustParseAddr(unicast[j])) })
	if len(unicast) > MaxUnicast6 {
		unicast = unicast[:MaxUnicast6]
	}

	// 3. paced unicast echo of the known addresses.
	if prober != nil && len(unicast) > 0 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, opt.Concurrency)
		pace := time.NewTicker(time.Second / time.Duration(opt.PPS))
	launch:
		for _, ip := range unicast {
			select {
			case <-ctx.Done():
				break launch
			case <-pace.C:
			}
			select {
			case <-ctx.Done():
				break launch
			case sem <- struct{}{}:
			}
			res.HostsProbed++
			wg.Add(1)
			go func(ip string) {
				defer wg.Done()
				defer func() { <-sem }()
				rtt, ok := prober.Ping(ctx, ip, opt.Timeout)
				if !ok {
					return
				}
				v := float64(rtt.Microseconds()) / 1000
				add(ip, "icmpv6")
				mu.Lock()
				found[ip].RTTMs = &v
				mu.Unlock()
			}(ip)
		}
		wg.Wait()
		pace.Stop()
	}
	if ctx.Err() != nil {
		res.FinishedAt = time.Now().UTC()
		return res
	}

	// 4. neighbour table again: MAC addresses, reachability confirmed by the OS, router flags.
	macOf := map[string]string{}
	if o6.Neighbors6 != nil {
		if table, err := o6.Neighbors6(ctx); err == nil {
			for _, n := range table {
				a, err := netip.ParseAddr(n.IP)
				if err != nil {
					continue
				}
				ip := a.String()
				switch {
				case prefix.Contains(a):
					if h, ok := found[ip]; ok || n.Reachable {
						add(ip, "ndp_cache")
						h = found[ip]
						h.MAC = n.MAC
						if n.Router {
							if h.Hints == nil {
								h.Hints = map[string]string{}
							}
							h.Hints["ndp_router"] = "yes"
						}
					}
				case scope.IsLinkLocal(a) && (n.Interface == "" || len(onLink) == 0 || onLink[n.Interface]):
					if n.Reachable || linkLocal[ip] {
						macOf[ip] = n.MAC
					}
				}
			}
		}
	}

	if opt.LocalDown != nil {
		for _, ip := range opt.LocalDown() {
			delete(found, ip)
		}
	}
	if o6.LocalAddrs != nil {
		for ip, mac := range o6.LocalAddrs() {
			a, err := netip.ParseAddr(ip)
			if err != nil || mac == "" {
				continue
			}
			switch {
			case prefix.Contains(a):
				add(a.String(), "local_interface")
				if h := found[a.String()]; h.MAC == "" {
					h.MAC = mac
				}
			case scope.IsLinkLocal(a) && !prefix.Contains(a):
				macOf[a.String()] = mac
			}
		}
	}

	// Link-local addresses ride along with the device (same MAC) that holds an address of the scope.
	scopeMACs := map[string]bool{}
	for _, h := range found {
		if h.MAC != "" {
			scopeMACs[h.MAC] = true
		}
	}
	for ip, mac := range macOf {
		if mac == "" || !scopeMACs[mac] {
			continue
		}
		if _, ok := found[ip]; !ok {
			source := "ndp_cache"
			if linkLocal[ip] {
				source = "icmpv6_multicast"
			}
			found[ip] = &Host{IP: ip, MAC: mac, Sources: []string{source}}
		}
	}

	if opt.DHCPName != nil {
		// Names learned by passively listening to DHCP (IPv4), matched by MAC: the same device.
		for _, h := range found {
			if h.MAC == "" {
				continue
			}
			hostname, vendor, ok := opt.DHCPName(h.MAC)
			if !ok {
				continue
			}
			if hostname != "" {
				h.Names = append(h.Names, identify.Name{Source: "dhcp", Name: hostname})
			}
			if vendor != "" {
				h.Hints = withHint(h.Hints, "dhcp_vendor_class", vendor)
			}
			h.Sources = append(h.Sources, "dhcp")
		}
	}

	if opt.ReverseName != nil {
		var nwg sync.WaitGroup
		nsem := make(chan struct{}, 8)
		for _, h := range found {
			if scope.IsLinkLocal(netip.MustParseAddr(h.IP)) && !prefix.Contains(netip.MustParseAddr(h.IP)) {
				continue // a PTR for a link-local address is meaningless outside the link
			}
			nwg.Add(1)
			nsem <- struct{}{}
			go func(h *Host) {
				defer nwg.Done()
				defer func() { <-nsem }()
				if name := opt.ReverseName(ctx, h.IP); name != "" {
					mu.Lock()
					h.Hostname = name
					h.Sources = append(h.Sources, "rdns")
					mu.Unlock()
				}
			}(h)
		}
		nwg.Wait()
	}

	res.Hosts = make([]Host, 0, len(found))
	for _, h := range found {
		res.Hosts = append(res.Hosts, *h)
	}
	sort.Slice(res.Hosts, func(i, j int) bool {
		return netip.MustParseAddr(res.Hosts[i].IP).Less(netip.MustParseAddr(res.Hosts[j].IP))
	})
	res.FinishedAt = time.Now().UTC()
	res.Complete = ctx.Err() == nil
	return res
}

func withHint(h map[string]string, k, v string) map[string]string {
	if h == nil {
		h = map[string]string{}
	}
	h[k] = v
	return h
}
