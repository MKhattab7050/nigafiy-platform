// Package discovery finds the devices that are present in one authorized scope.
//
// Method (low impact by design):
//  1. one ICMP echo request per address, rate limited and concurrency limited;
//  2. read the host's neighbour (ARP) table, which the OS filled in while sending step 1 —
//     this yields MAC addresses, and reveals devices that drop ICMP but still answer ARP;
//  3. one reverse-DNS lookup per device found.
//
// No port scanning, no fingerprinting probes, no crafted packets.
package discovery

import (
	"context"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/nigafiy/sensor/internal/identify"
	"github.com/nigafiy/sensor/internal/netinfo"
	"github.com/nigafiy/sensor/internal/scope"
)

// Prober sends one ICMP echo request.
type Prober interface {
	Ping(ctx context.Context, ip string, timeout time.Duration) (rtt time.Duration, ok bool)
}

type Options struct {
	Concurrency int           // maximum probes in flight
	PPS         int           // maximum probes started per second
	Timeout     time.Duration // per-probe timeout
	Neighbors   func(ctx context.Context) (map[string]netinfo.Neighbor, error)
	ReverseName func(ctx context.Context, ip string) string
	// LocalMACs returns this host's own IPv4 → MAC pairs (optional).
	LocalMACs func() map[string]string
	// LocalDown returns addresses of this host's own disconnected interfaces (optional): they are
	// not on the network and are removed from the result.
	LocalDown func() []string
	// DHCPName returns the name / vendor class a client with this MAC announced over DHCP (optional).
	DHCPName func(mac string) (hostname, vendorClass string, ok bool)
	// Identify asks devices what they are (mDNS, SSDP, NetBIOS). Optional.
	Identify func(ctx context.Context, prefix netip.Prefix, hosts []string) map[string]*identify.Info
}

type Host struct {
	IP       string   `json:"ip"`
	MAC      string   `json:"mac,omitempty"`
	Hostname string   `json:"hostname,omitempty"`
	RTTMs    *float64 `json:"rtt_ms,omitempty"`
	Sources  []string `json:"sources"`
	// What the device said about itself (see package identify).
	Names    []identify.Name   `json:"names,omitempty"`
	Services []string          `json:"services,omitempty"`
	Hints    map[string]string `json:"hints,omitempty"`
	SSDP     *identify.SSDP    `json:"ssdp,omitempty"`
}

type Result struct {
	StartedAt   time.Time
	FinishedAt  time.Time
	HostsProbed int
	Hosts       []Host
	// Complete is false when the sweep was interrupted (shutdown). An incomplete sweep must not be
	// reported: missing hosts would be misread as "offline".
	Complete bool
}

// Sweep probes every host address of prefix. The caller is responsible for having validated the
// prefix against the scope policy.
func Sweep(ctx context.Context, prefix netip.Prefix, prober Prober, opt Options) Result {
	res := Result{StartedAt: time.Now().UTC()}
	addrs := scope.Hosts(prefix)
	if opt.Concurrency < 1 {
		opt.Concurrency = 1
	}
	if opt.PPS < 1 {
		opt.PPS = 1
	}

	found := map[string]*Host{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, opt.Concurrency)
	pace := time.NewTicker(time.Second / time.Duration(opt.PPS))
	defer pace.Stop()

	interrupted := false
launch:
	for _, addr := range addrs {
		select {
		case <-ctx.Done():
			interrupted = true
			break launch
		case <-pace.C:
		}
		select {
		case <-ctx.Done():
			interrupted = true
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
			mu.Lock()
			found[ip] = &Host{IP: ip, RTTMs: &v, Sources: []string{"icmp"}}
			mu.Unlock()
		}(addr.String())
	}
	wg.Wait()
	if interrupted || ctx.Err() != nil {
		res.FinishedAt = time.Now().UTC()
		return res
	}

	if opt.Neighbors != nil {
		if table, err := opt.Neighbors(ctx); err == nil {
			for ip, n := range table {
				addr, err := netip.ParseAddr(ip)
				if err != nil || !prefix.Contains(addr) || n.MAC == "" {
					continue
				}
				if h, ok := found[ip]; ok {
					h.MAC = n.MAC
					h.Sources = append(h.Sources, "arp_cache")
				} else if n.Reachable {
					// Silent to ICMP, but the OS just confirmed it at layer 2. A merely stale
					// entry is NOT counted: it would keep departed devices "online".
					found[ip] = &Host{IP: ip, MAC: n.MAC, Sources: []string{"arp_cache"}}
				}
			}
		}
	}

	if opt.LocalDown != nil {
		for _, ip := range opt.LocalDown() {
			delete(found, ip)
		}
	}

	if opt.LocalMACs != nil {
		// The collector host itself: it is certainly present, and its MAC is read from its own interface.
		for ip, mac := range opt.LocalMACs() {
			addr, err := netip.ParseAddr(ip)
			if err != nil || !prefix.Contains(addr) || mac == "" {
				continue
			}
			if h, ok := found[ip]; ok {
				if h.MAC == "" {
					h.MAC = mac
				}
				h.Sources = append(h.Sources, "local_interface")
			} else {
				found[ip] = &Host{IP: ip, MAC: mac, Sources: []string{"local_interface"}}
			}
		}
	}

	if opt.Identify != nil {
		ips := make([]string, 0, len(found))
		for ip := range found {
			ips = append(ips, ip)
		}
		for ip, info := range opt.Identify(ctx, prefix, ips) {
			if len(info.Sources) == 0 {
				continue
			}
			h, ok := found[ip]
			if !ok {
				// It answered a discovery protocol from inside the scope, so it is present even
				// though it ignored ICMP and has no fresh neighbour entry.
				h = &Host{IP: ip}
				found[ip] = h
			}
			h.Names, h.Services, h.Hints, h.SSDP = info.Names, info.Services, info.Hints, info.SSDP
			h.Sources = append(h.Sources, info.Sources...)
		}
	}

	if opt.DHCPName != nil {
		// Names learned by passively listening to DHCP, matched by MAC to devices found in this scope.
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
				if h.Hints == nil {
					h.Hints = map[string]string{}
				}
				h.Hints["dhcp_vendor_class"] = vendor
			}
			h.Sources = append(h.Sources, "dhcp")
		}
	}

	if opt.ReverseName != nil {
		var nwg sync.WaitGroup
		nsem := make(chan struct{}, 8)
		for _, h := range found {
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
		a, _ := netip.ParseAddr(res.Hosts[i].IP)
		b, _ := netip.ParseAddr(res.Hosts[j].IP)
		return a.Less(b)
	})
	res.FinishedAt = time.Now().UTC()
	res.Complete = ctx.Err() == nil
	return res
}
