package probe

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net"
	"net/netip"
	"os"
	"runtime"
	"strconv"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv6"
)

// AllNodes is the link-local all-nodes multicast group (RFC 4291): every IPv6 host on a link
// listens on it and answers an echo request sent there (RFC 4443).
var AllNodes = netip.MustParseAddr("ff02::1")

// EchoReply6 is one ICMPv6 echo reply.
type EchoReply6 struct {
	From netip.Addr // without zone
	RTT  time.Duration
}

// listen6 opens an ICMPv6 endpoint bound to src: an unprivileged datagram socket where the OS
// offers one (Linux with net.ipv4.ping_group_range, macOS), else a raw socket (Windows; Linux with
// CAP_NET_RAW). Raw sockets need administrator / root rights.
func listen6(src string) (*icmp.PacketConn, bool, error) {
	if runtime.GOOS != "windows" {
		if c, err := icmp.ListenPacket("udp6", src); err == nil {
			return c, false, nil
		}
	}
	c, err := icmp.ListenPacket("ip6:ipv6-icmp", src)
	if err != nil {
		return nil, true, err
	}
	return c, true, nil
}

// Echo6 sends `count` ICMPv6 echo requests, one per second, from src to dst and collects every
// matching echo reply until `wait` after the last request. dst may be a unicast address or a
// multicast group; for a link-scoped destination (ff02::1, fe80::/10) ifIndex names the interface.
// Replies are matched on a random payload token, so replies to other programs' pings are ignored.
// The caller has validated the destination against the authorized scopes.
func Echo6(ctx context.Context, src, dst netip.Addr, ifIndex, count int, wait time.Duration) ([]EchoReply6, error) {
	if !dst.Is6() || dst.Is4In6() {
		return nil, errors.New("not an IPv6 destination")
	}
	if count < 1 {
		count = 1
	}
	zone := ""
	if ifIndex > 0 {
		zone = strconv.Itoa(ifIndex)
	}
	bind := "::"
	if src.IsValid() {
		s := src.WithZone("")
		if s.IsLinkLocalUnicast() && zone != "" {
			s = s.WithZone(zone)
		}
		bind = s.String()
	}
	c, raw, err := listen6(bind)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if p := c.IPv6PacketConn(); p != nil && dst.IsMulticast() {
		if ifIndex > 0 {
			if ifi, err := net.InterfaceByIndex(ifIndex); err == nil {
				_ = p.SetMulticastInterface(ifi)
			}
		}
		_ = p.SetMulticastHopLimit(1) // never leaves the link
		_ = p.SetMulticastLoopback(false)
	}

	token := make([]byte, 16)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	id := os.Getpid() & 0xffff
	target := &net.IPAddr{IP: dst.AsSlice()}
	if dst.IsLinkLocalUnicast() || dst.IsLinkLocalMulticast() || dst.IsInterfaceLocalMulticast() {
		target.Zone = zone
	}
	var to net.Addr = target
	if !raw {
		to = &net.UDPAddr{IP: target.IP, Zone: target.Zone}
	}

	sent := make([]time.Time, count)
	seen := map[netip.Addr]bool{}
	var replies []EchoReply6
	buf := make([]byte, 1500)
	for seq := 0; seq < count; seq++ {
		msg := icmp.Message{Type: ipv6.ICMPTypeEchoRequest, Body: &icmp.Echo{ID: id, Seq: seq, Data: token}}
		b, err := msg.Marshal(nil) // the kernel fills in the ICMPv6 checksum
		if err != nil {
			return nil, err
		}
		sent[seq] = time.Now()
		if _, err := c.WriteTo(b, to); err != nil {
			return replies, err
		}
		until := time.Now().Add(time.Second)
		if seq == count-1 {
			until = time.Now().Add(wait)
		}
		for {
			if ctx.Err() != nil {
				return replies, ctx.Err()
			}
			if time.Now().After(until) {
				break
			}
			_ = c.SetReadDeadline(until)
			n, from, err := c.ReadFrom(buf)
			if err != nil {
				var ne net.Error
				if errors.As(err, &ne) && ne.Timeout() {
					break
				}
				return replies, err
			}
			m, err := icmp.ParseMessage(58, buf[:n])
			if err != nil || m.Type != ipv6.ICMPTypeEchoReply {
				continue
			}
			echo, ok := m.Body.(*icmp.Echo)
			// A datagram socket's identifier is rewritten by the kernel: match on the token only.
			if !ok || !bytes.Equal(echo.Data, token) || echo.Seq < 0 || echo.Seq >= count || (raw && echo.ID != id) {
				continue
			}
			addr := addrOf(from)
			if !addr.IsValid() || seen[addr] {
				continue
			}
			seen[addr] = true
			replies = append(replies, EchoReply6{From: addr, RTT: time.Since(sent[echo.Seq])})
		}
	}
	return replies, nil
}

func addrOf(a net.Addr) netip.Addr {
	var ip net.IP
	switch v := a.(type) {
	case *net.IPAddr:
		ip = v.IP
	case *net.UDPAddr:
		ip = v.IP
	default:
		return netip.Addr{}
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return netip.Addr{}
	}
	return addr.Unmap().WithZone("")
}

// EchoAllNodes sends paced echo requests to ff02::1 on one interface, from the host's address src on
// that link, and returns who answered. Sending from an address of the scope makes devices answer
// from their own address of the same scope (RFC 6724 source selection) instead of their link-local one.
func EchoAllNodes(ctx context.Context, src netip.Addr, ifIndex int, wait time.Duration) ([]EchoReply6, error) {
	return Echo6(ctx, src, AllNodes, ifIndex, 2, wait)
}
