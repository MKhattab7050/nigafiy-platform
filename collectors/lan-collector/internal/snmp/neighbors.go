package snmp

import (
	"net"
	"sort"
)

// Neighbour tables besides LLDP, read with the same read-only walks as the rest of Poll.
//
// CISCO-CDP-MIB cdpCacheTable (1.3.6.1.4.1.9.9.23.1.2.1.1), indexed by ifIndex.deviceIndex:
//
//	.3 cdpCacheAddressType (1 = ip)   .4 cdpCacheAddress (4 octets for IPv4)
//	.5 cdpCacheVersion                .6 cdpCacheDeviceId
//	.7 cdpCacheDevicePort             .8 cdpCachePlatform
//
// MIKROTIK-MIB mtxrNeighborTable (1.3.6.1.4.1.14988.1.1.11.1.1), indexed by mtxrNeighborIndex.
// RouterOS fills it from MNDP (and CDP / LLDP when those are enabled on the router):
//
//	.2 mtxrNeighborIpAddress   .3 mtxrNeighborMacAddress   .4 mtxrNeighborVersion
//	.5 mtxrNeighborPlatform    .6 mtxrNeighborIdentity     .8 mtxrNeighborInterfaceID (ifIndex)
const (
	oidCdpCache      = ".1.3.6.1.4.1.9.9.23.1.2.1.1"
	oidCdpAddrType   = oidCdpCache + ".3"
	oidCdpAddress    = oidCdpCache + ".4"
	oidCdpVersion    = oidCdpCache + ".5"
	oidCdpDeviceID   = oidCdpCache + ".6"
	oidCdpDevicePort = oidCdpCache + ".7"
	oidCdpPlatform   = oidCdpCache + ".8"

	oidMtxrNeighbor   = ".1.3.6.1.4.1.14988.1.1.11.1.1"
	oidMtxrNbIP       = oidMtxrNeighbor + ".2"
	oidMtxrNbMAC      = oidMtxrNeighbor + ".3"
	oidMtxrNbVersion  = oidMtxrNeighbor + ".4"
	oidMtxrNbPlatform = oidMtxrNeighbor + ".5"
	oidMtxrNbIdentity = oidMtxrNeighbor + ".6"
	oidMtxrNbIfIndex  = oidMtxrNeighbor + ".8"
)

// Neighbour protocols as reported in Neighbor.Protocol.
const (
	ProtoLLDP     = "lldp"
	ProtoCDP      = "cdp"
	ProtoMikroTik = "mikrotik"
)

// ipv4Octets returns the dotted form of a 4-byte address value (CDP sends it as an octet string,
// the MikroTik table as an IpAddress, which gosnmp hands over as a string).
func ipv4Octets(v any) string {
	switch x := v.(type) {
	case []byte:
		if len(x) == 4 {
			return net.IP(x).String()
		}
	case string:
		if ip := net.ParseIP(x); ip != nil && ip.To4() != nil {
			return ip.To4().String()
		}
	}
	return ""
}

// readCDP walks cdpCacheTable. A device without CDP answers the walk with nothing.
func readCDP(w walker) []Neighbor {
	addrType := map[[2]int]int{}
	_, _ = w.walk(oidCdpAddrType, MaxLLDP, func(idx []int, v any) {
		if len(idx) == 2 {
			addrType[[2]int{idx[0], idx[1]}] = int(num(v))
		}
	})
	nb := map[[2]int]*Neighbor{}
	get := func(idx []int) *Neighbor {
		if len(idx) != 2 {
			return nil
		}
		k := [2]int{idx[0], idx[1]}
		n := nb[k]
		if n == nil {
			if len(nb) >= MaxLLDP {
				return nil
			}
			n = &Neighbor{IfIndex: idx[0], Protocol: ProtoCDP}
			nb[k] = n
		}
		return n
	}
	for _, col := range []struct {
		oid string
		set func(k [2]int, n *Neighbor, v any)
	}{
		{oidCdpDeviceID, func(_ [2]int, n *Neighbor, v any) { n.SysName = clip(text(v), 120) }},
		{oidCdpDevicePort, func(_ [2]int, n *Neighbor, v any) { n.PortID = clip(text(v), 80) }},
		{oidCdpPlatform, func(_ [2]int, n *Neighbor, v any) { n.Platform = clip(text(v), 120) }},
		{oidCdpVersion, func(_ [2]int, n *Neighbor, v any) { n.Version = clip(firstLine(v), 120) }},
		{oidCdpAddress, func(k [2]int, n *Neighbor, v any) {
			if t, ok := addrType[k]; !ok || t == 1 {
				n.Address = ipv4Octets(v)
			}
		}},
	} {
		_, _ = w.walk(col.oid, MaxLLDP, func(idx []int, v any) {
			if n := get(idx); n != nil {
				col.set([2]int{idx[0], idx[1]}, n, v)
			}
		})
	}
	return sortedNeighbors(nb)
}

// readMikroTik walks mtxrNeighborTable.
func readMikroTik(w walker) []Neighbor {
	nb := map[[2]int]*Neighbor{}
	get := func(idx []int) *Neighbor {
		if len(idx) != 1 {
			return nil
		}
		k := [2]int{idx[0], 0}
		n := nb[k]
		if n == nil {
			if len(nb) >= MaxLLDP {
				return nil
			}
			n = &Neighbor{Protocol: ProtoMikroTik}
			nb[k] = n
		}
		return n
	}
	for _, col := range []struct {
		oid string
		set func(n *Neighbor, v any)
	}{
		{oidMtxrNbIfIndex, func(n *Neighbor, v any) { n.IfIndex = int(num(v)) }},
		{oidMtxrNbIdentity, func(n *Neighbor, v any) { n.SysName = clip(text(v), 120) }},
		{oidMtxrNbMAC, func(n *Neighbor, v any) {
			if b, ok := v.([]byte); ok && len(b) == 6 {
				n.ChassisID = hexBytes(b)
			}
		}},
		{oidMtxrNbIP, func(n *Neighbor, v any) { n.Address = ipv4Octets(v) }},
		{oidMtxrNbPlatform, func(n *Neighbor, v any) { n.Platform = clip(text(v), 120) }},
		{oidMtxrNbVersion, func(n *Neighbor, v any) { n.Version = clip(firstLine(v), 120) }},
	} {
		_, _ = w.walk(col.oid, MaxLLDP, func(idx []int, v any) {
			if n := get(idx); n != nil {
				col.set(n, v)
			}
		})
	}
	// A row whose interface is unknown cannot be placed on a port; it is still kept (if_index 0).
	return sortedNeighbors(nb)
}

// firstLine returns the first line of a version string as text. Cisco sends the whole multi-line
// "show version" banner in cdpCacheVersion; only its first line identifies the software.
func firstLine(v any) string {
	if b, ok := v.([]byte); ok {
		for i, c := range b {
			if c == '\n' || c == '\r' {
				return text(b[:i])
			}
		}
	}
	return text(v)
}

func sortedNeighbors(nb map[[2]int]*Neighbor) []Neighbor {
	keys := make([][2]int, 0, len(nb))
	for k := range nb {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})
	out := make([]Neighbor, 0, len(keys))
	for _, k := range keys {
		n := nb[k]
		if n.SysName == "" && n.ChassisID == "" && n.Address == "" {
			continue // a half-read row says nothing about who is there
		}
		out = append(out, *n)
	}
	return out
}
