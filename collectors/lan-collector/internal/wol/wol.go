// Package wol sends Wake-on-LAN "magic packets".
//
// A magic packet is 6 bytes of 0xFF followed by the target MAC address repeated 16 times, sent as a
// UDP broadcast. A computer whose network adapter has Wake-on-LAN enabled powers on when it sees
// one. Nothing else on the network reacts to it. The collector only sends it to the broadcast
// address of a scope it is authorized to work in.
package wol

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"
)

// MagicPacket builds the 102-byte payload for mac.
func MagicPacket(mac net.HardwareAddr) []byte {
	p := bytes.Repeat([]byte{0xff}, 6)
	for i := 0; i < 16; i++ {
		p = append(p, mac...)
	}
	return p
}

// ParseMAC accepts a unicast 48-bit MAC address only.
func ParseMAC(s string) (net.HardwareAddr, error) {
	mac, err := net.ParseMAC(s)
	if err != nil || len(mac) != 6 {
		return nil, errors.New("not a 48-bit MAC address")
	}
	if mac[0]&1 == 1 {
		return nil, errors.New("multicast/broadcast MAC addresses cannot be woken")
	}
	if bytes.Equal(mac, make([]byte, 6)) {
		return nil, errors.New("all-zero MAC address")
	}
	return mac, nil
}

// BroadcastOf returns the directed broadcast address of an IPv4 prefix.
func BroadcastOf(p netip.Prefix) netip.Addr {
	a := p.Masked().Addr().As4()
	bits := p.Bits()
	for i := 0; i < 4; i++ {
		// bits of this octet that belong to the host part
		hostBits := 8 - max(0, min(8, bits-8*i))
		a[i] |= byte(1<<hostBits - 1)
	}
	return netip.AddrFrom4(a)
}

// Send transmits the magic packet for mac to broadcast:9, a few times (UDP gives no delivery guarantee).
// broadcast must be the broadcast address of one of the allowed prefixes.
func Send(mac net.HardwareAddr, broadcast netip.Addr, allowed []netip.Prefix) error {
	ok := false
	for _, p := range allowed {
		if p.Addr().Is4() && BroadcastOf(p) == broadcast {
			ok = true
			break
		}
	}
	if !ok {
		return fmt.Errorf("%s is not the broadcast address of an authorized scope", broadcast)
	}
	conn, err := net.DialUDP("udp4", nil, net.UDPAddrFromAddrPort(netip.AddrPortFrom(broadcast, 9)))
	if err != nil {
		return err
	}
	defer conn.Close()
	packet := MagicPacket(mac)
	for i := 0; i < 3; i++ {
		if _, err := conn.Write(packet); err != nil {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}
