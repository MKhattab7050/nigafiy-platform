// Package identify asks devices what they are, using the discovery protocols devices themselves
// offer for that purpose:
//
//   - mDNS / DNS-SD (Bonjour): names and advertised services (printers, phones, TVs, computers);
//   - SSDP / UPnP: device description (friendly name, manufacturer, model) of TVs, routers, IoT;
//   - NetBIOS node status: the computer name of Windows machines.
//
// All three are ordinary, low-volume LAN discovery traffic (what a phone or PC sends when it looks
// for a printer). Nothing is logged in to, no ports are scanned, and only answers coming from
// addresses inside the authorized scope are kept.
package identify

import (
	"context"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// Name is one name a device gave for itself, and through which protocol.
type Name struct {
	Source string `json:"source"` // mdns | netbios | ssdp
	Name   string `json:"name"`
}

type SSDP struct {
	Server       string   `json:"server,omitempty"`
	FriendlyName string   `json:"friendly_name,omitempty"`
	Manufacturer string   `json:"manufacturer,omitempty"`
	Model        string   `json:"model,omitempty"`
	DeviceTypes  []string `json:"device_types,omitempty"`
}

// Info is everything one device told us about itself.
type Info struct {
	Names    []Name            `json:"names,omitempty"`
	Services []string          `json:"services,omitempty"`
	Hints    map[string]string `json:"hints,omitempty"`
	SSDP     *SSDP             `json:"ssdp,omitempty"`
	Sources  []string          `json:"-"`
}

const (
	maxNames    = 6
	maxServices = 30
	maxHints    = 10
	maxText     = 100
)

// Clean makes device-supplied text safe to store and show: valid UTF-8, no control characters, bounded.
func Clean(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > maxText {
		s = s[:maxText]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
		// The cut can land after a space ("…TV  rest"): trim again (found by FuzzClean).
		s = strings.TrimRightFunc(s, unicode.IsSpace)
	}
	return s
}

type collector struct {
	mu     sync.Mutex
	prefix netip.Prefix
	byIP   map[string]*Info
}

func (c *collector) get(ip string) *Info {
	addr, err := netip.ParseAddr(ip)
	if err != nil || !c.prefix.Contains(addr) {
		return nil // answers from outside the authorized scope are ignored
	}
	info := c.byIP[ip]
	if info == nil {
		info = &Info{Hints: map[string]string{}}
		c.byIP[ip] = info
	}
	return info
}

func (c *collector) addName(ip, source, name string) {
	name = Clean(strings.TrimSuffix(strings.TrimSuffix(name, "."), ".local"))
	if name == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.get(ip)
	if info == nil || len(info.Names) >= maxNames {
		return
	}
	for _, n := range info.Names {
		if strings.EqualFold(n.Name, name) {
			return
		}
	}
	info.Names = append(info.Names, Name{Source: source, Name: name})
	info.mark(source)
}

func (c *collector) addService(ip, service string) {
	service = Clean(strings.TrimSuffix(strings.TrimSuffix(service, "."), ".local"))
	if service == "" || !strings.HasPrefix(service, "_") {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.get(ip)
	if info == nil || len(info.Services) >= maxServices {
		return
	}
	for _, s := range info.Services {
		if s == service {
			return
		}
	}
	info.Services = append(info.Services, service)
	info.mark("mdns")
}

func (c *collector) addHint(ip, key, value string) {
	key, value = Clean(key), Clean(value)
	if key == "" || value == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.get(ip)
	if info == nil {
		return
	}
	if _, exists := info.Hints[key]; !exists && len(info.Hints) < maxHints {
		info.Hints[key] = value
		info.mark("mdns")
	}
}

func (c *collector) ssdp(ip string, update func(*SSDP)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.get(ip)
	if info == nil {
		return
	}
	if info.SSDP == nil {
		info.SSDP = &SSDP{}
	}
	update(info.SSDP)
	info.mark("ssdp")
}

func (i *Info) mark(source string) {
	for _, s := range i.Sources {
		if s == source {
			return
		}
	}
	i.Sources = append(i.Sources, source)
}

// localAddrsIn returns this host's own IPv4 addresses that lie inside prefix.
func localAddrsIn(prefix netip.Prefix) []net.IP {
	var out []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.To4() == nil {
			continue
		}
		if addr, ok := netip.AddrFromSlice(ipn.IP.To4()); ok && prefix.Contains(addr) {
			out = append(out, ipn.IP.To4())
		}
	}
	return out
}

// Run queries the local segment and returns what each in-scope address said about itself.
// hosts are the addresses that discovery already found (used for the per-host questions).
func Run(ctx context.Context, prefix netip.Prefix, hosts []string) map[string]*Info {
	c := &collector{prefix: prefix, byIP: map[string]*Info{}}
	var wg sync.WaitGroup
	run := func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn()
		}()
	}
	// Multicast discovery only reaches the local segment, and must leave through the interface that
	// is actually in the scope (a host can have several). No interface in the scope → routed
	// network → multicast cannot work there, so it is not attempted.
	for _, local := range localAddrsIn(prefix) {
		run(func() { probeMDNS(ctx, c, hosts, local) })
		run(func() { probeSSDP(ctx, c, local) })
	}
	run(func() { probeNetBIOS(ctx, c, hosts) })
	wg.Wait()
	for _, info := range c.byIP {
		sort.Strings(info.Services)
		sort.Strings(info.Sources)
		if len(info.Hints) == 0 {
			info.Hints = nil
		}
	}
	return c.byIP
}
