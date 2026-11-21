// Package smart implements the collector's smart network checks (Phase 5). Every check is a
// read-only observation, made openly from the collector host, never a change to the network:
//
//   - DHCPProbe: one DHCPDISCOVER per authorized interface, listing every DHCP server that offers
//     (rogue DHCP detection). A lease is never requested or accepted.
//   - AuditUPnP: asks the gateway's UPnP IGD which port forwards are open (GetGenericPortMappingEntry).
//     Nothing is added or removed.
//   - ReadWiFi: the collector host's own Wi-Fi link and the networks its adapter already lists.
//   - GrabBanners: fetches the start page / TLS certificate of a device's web interface.
//
// Results are plain structs with JSON tags matching the server's `smart_check` protocol.
package smart

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sort"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/identify"
)

// DHCPInterface is one network interface of the collector host to probe.
type DHCPInterface struct {
	Name    string
	Index   int
	Address netip.Addr
	MAC     net.HardwareAddr
}

// DHCPOffer is what one server offered.
type DHCPOffer struct {
	ServerID     string   `json:"server_id"`
	SourceIP     string   `json:"source_ip"`
	ServerMAC    string   `json:"server_mac,omitempty"`
	OfferedIP    string   `json:"offered_ip,omitempty"`
	SubnetMask   string   `json:"subnet_mask,omitempty"`
	Routers      []string `json:"routers"`
	DNS          []string `json:"dns"`
	LeaseSeconds *uint32  `json:"lease_seconds,omitempty"`
	Domain       string   `json:"domain,omitempty"`
}

// DHCPInterfaceResult is the outcome of probing one interface.
type DHCPInterfaceResult struct {
	Name          string      `json:"name"`
	Address       string      `json:"address"`
	MAC           string      `json:"mac,omitempty"`
	ListenError   string      `json:"listen_error,omitempty"`
	ListenSeconds float64     `json:"listen_seconds,omitempty"`
	Offers        []DHCPOffer `json:"offers"`
}

const (
	maxDHCPInterfaces = 16
	maxOffers         = 32
)

var dhcpCookie = []byte{99, 130, 83, 99}

// BuildDiscover crafts a DHCPDISCOVER for mac with transaction id xid. The broadcast flag asks
// servers to broadcast their offer (we hold no lease for the address they offer).
func BuildDiscover(mac net.HardwareAddr, xid uint32) []byte {
	msg := make([]byte, 236, 300)
	msg[0], msg[1], msg[2] = 1, 1, 6 // BOOTREQUEST, Ethernet, 6-byte MAC
	binary.BigEndian.PutUint32(msg[4:8], xid)
	binary.BigEndian.PutUint16(msg[10:12], 0x8000) // broadcast flag
	copy(msg[28:34], mac)
	msg = append(msg, dhcpCookie...)
	msg = append(msg, 53, 1, 1)                     // DHCPDISCOVER
	msg = append(msg, 55, 6, 1, 3, 6, 15, 51, 54)   // ask for mask, routers, DNS, domain, lease, server id
	msg = append(msg, 57, 2, 0x05, 0xdc)            // max message size 1500
	msg = append(msg, 255)
	for len(msg) < 300 { // BOOTP minimum size; some relays drop shorter packets
		msg = append(msg, 0)
	}
	return msg
}

func ipv4s(v []byte) []string {
	var out []string
	for i := 0; i+4 <= len(v) && len(out) < 8; i += 4 {
		out = append(out, net.IP(v[i:i+4]).String())
	}
	return out
}

// ParseOffer reads a DHCPOFFER answering transaction xid. source is the UDP source address.
func ParseOffer(msg []byte, xid uint32, source netip.Addr) (DHCPOffer, bool) {
	const fixed = 236
	if len(msg) < fixed+4 || msg[0] != 2 /* BOOTREPLY */ || binary.BigEndian.Uint32(msg[4:8]) != xid {
		return DHCPOffer{}, false
	}
	if string(msg[fixed:fixed+4]) != string(dhcpCookie) {
		return DHCPOffer{}, false
	}
	o := DHCPOffer{SourceIP: source.String(), Routers: []string{}, DNS: []string{}}
	if yi := net.IP(msg[16:20]); !yi.IsUnspecified() {
		o.OfferedIP = yi.String()
	}
	isOffer := false
	for opts := msg[fixed+4:]; len(opts) > 0; {
		code := opts[0]
		if code == 255 {
			break
		}
		if code == 0 {
			opts = opts[1:]
			continue
		}
		if len(opts) < 2 || len(opts) < 2+int(opts[1]) {
			break
		}
		v := opts[2 : 2+int(opts[1])]
		switch code {
		case 53:
			isOffer = len(v) == 1 && v[0] == 2
		case 54:
			if len(v) == 4 {
				o.ServerID = net.IP(v).String()
			}
		case 1:
			if len(v) == 4 {
				o.SubnetMask = net.IP(v).String()
			}
		case 3:
			o.Routers = ipv4s(v)
		case 6:
			o.DNS = ipv4s(v)
		case 15:
			o.Domain = cleanText(strings.TrimRight(string(v), "\x00"), 120)
		case 51:
			if len(v) == 4 {
				l := binary.BigEndian.Uint32(v)
				o.LeaseSeconds = &l
			}
		}
		opts = opts[2+int(opts[1]):]
	}
	if !isOffer {
		return DHCPOffer{}, false
	}
	if o.ServerID == "" { // a server that omits option 54 is identified by its address
		o.ServerID = o.SourceIP
	}
	return o, true
}

// cleanText makes device-supplied text safe (no control characters) and bounded to max bytes.
func cleanText(s string, max int) string {
	s = identify.Clean(s)
	if len(s) > max {
		s = s[:max]
		for len(s) > 0 && !validUTF8Tail(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

func validUTF8Tail(s string) bool { return strings.ToValidUTF8(s, "�") == s }

// Interfaces returns the collector host's IPv4 interfaces whose address lies in one of allowed,
// each once (the first matching address). Loopback, down and MAC-less interfaces are skipped.
func Interfaces(allowed []netip.Prefix) []DHCPInterface {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []DHCPInterface
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 || len(i.HardwareAddr) != 6 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			addr, _ := netip.AddrFromSlice(ipn.IP.To4())
			if inAny(addr, allowed) {
				out = append(out, DHCPInterface{Name: i.Name, Index: i.Index, Address: addr, MAC: i.HardwareAddr})
				break
			}
		}
		if len(out) >= maxDHCPInterfaces {
			break
		}
	}
	return out
}

func inAny(a netip.Addr, prefixes []netip.Prefix) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// PacketConn is the part of a UDP socket the probe uses (a test double in tests).
type PacketConn interface {
	WriteTo(b []byte, addr net.Addr) (int, error)
	ReadFrom(b []byte) (int, net.Addr, error)
	SetReadDeadline(t time.Time) error
	Close() error
}

// DHCPListener opens the DHCP client port (UDP 68) for one interface.
type DHCPListener func(ctx context.Context, iface DHCPInterface) (PacketConn, error)

var broadcastServer = &net.UDPAddr{IP: net.IPv4bcast, Port: 67}

// ErrNoInterface: no interface of the collector host is inside an authorized range.
var ErrNoInterface = errors.New("no network interface of this host is inside an authorized range")

// DHCPProbe sends one DHCPDISCOVER on each interface and collects every offer for `listen`.
// Interfaces are probed in parallel. The returned slice has one entry per interface.
func DHCPProbe(ctx context.Context, ifaces []DHCPInterface, listen time.Duration, open DHCPListener) []DHCPInterfaceResult {
	out := make([]DHCPInterfaceResult, len(ifaces))
	done := make(chan struct{}, len(ifaces))
	for i, iface := range ifaces {
		go func() {
			defer func() { done <- struct{}{} }()
			out[i] = probeOne(ctx, iface, listen, open)
		}()
	}
	for range ifaces {
		<-done
	}
	return out
}

func probeOne(ctx context.Context, iface DHCPInterface, listen time.Duration, open DHCPListener) DHCPInterfaceResult {
	res := DHCPInterfaceResult{Name: cleanText(iface.Name, 120), Address: iface.Address.String(), MAC: iface.MAC.String(), Offers: []DHCPOffer{}}
	conn, err := open(ctx, iface)
	if err != nil {
		res.ListenError = cleanText(err.Error(), 300)
		return res
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	var b [4]byte
	_, _ = rand.Read(b[:])
	xid := binary.BigEndian.Uint32(b[:])
	started := time.Now()
	if _, err := conn.WriteTo(BuildDiscover(iface.MAC, xid), broadcastServer); err != nil {
		res.ListenError = cleanText("could not send the DHCPDISCOVER: "+err.Error(), 300)
		return res
	}
	seen := map[string]bool{}
	buf := make([]byte, 1500)
	deadline := started.Add(listen)
	for ctx.Err() == nil && len(res.Offers) < maxOffers {
		_ = conn.SetReadDeadline(deadline)
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			break // deadline reached (or closed on shutdown)
		}
		src, ok := sourceAddr(from)
		if !ok {
			continue
		}
		offer, ok := ParseOffer(buf[:n], xid, src)
		if !ok || seen[offer.ServerID] {
			continue
		}
		seen[offer.ServerID] = true
		res.Offers = append(res.Offers, offer)
	}
	res.ListenSeconds = float64(time.Since(started).Round(100*time.Millisecond)) / float64(time.Second)
	if res.ListenSeconds > 60 {
		res.ListenSeconds = 60
	}
	sort.Slice(res.Offers, func(i, j int) bool { return res.Offers[i].ServerID < res.Offers[j].ServerID })
	return res
}

func sourceAddr(a net.Addr) (netip.Addr, bool) {
	if u, ok := a.(*net.UDPAddr); ok {
		addr, ok := netip.AddrFromSlice(u.IP.To4())
		return addr, ok && u.IP.To4() != nil
	}
	return netip.Addr{}, false
}
