package snmp

import (
	"context"
	"net"
	"testing"
	"time"
)

// CDP (CISCO-CDP-MIB cdpCacheTable) and MikroTik (MIKROTIK-MIB mtxrNeighborTable) rows join the
// LLDP list, each tagged with its protocol, in the value formats real devices use: the CDP address
// as 4 raw octets, the MikroTik address as an IpAddress, the MikroTik MAC as 6 raw octets.
func TestPollReadsCDPAndMikroTikNeighbours(t *testing.T) {
	a := demo()
	a.CDPNeighbor(103, 1, "SEP001122334455", "Port 1", "Cisco IP Phone 8841", "SIP88xx.14-1-1\nsecond line", net.ParseIP("10.20.0.31"))
	a.CDPNeighbor(108, 2, "core-sw.example.lan", "GigabitEthernet1/0/48", "cisco WS-C2960X-48FPD-L", "Cisco IOS Software, C2960X", net.ParseIP("10.20.0.2"))
	a.MikroTikNeighbor(1, 104, "hAP-office", "MikroTik", "7.15.3 (stable)", "48:a9:8a:01:02:03", net.ParseIP("10.20.0.5"))
	a.MikroTikNeighbor(2, 0, "cap-roof", "MikroTik", "7.14", "48:a9:8a:0a:0b:0c", net.ParseIP("10.20.0.6"))
	res, err := Poll(context.Background(), start(t, a), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	byProto := map[string][]Neighbor{}
	for _, n := range res.LLDP {
		byProto[n.Protocol] = append(byProto[n.Protocol], n)
	}
	cases := []struct {
		name  string
		proto string
		i     int
		want  Neighbor
	}{
		{"lldp keeps its fields", ProtoLLDP, 0, Neighbor{IfIndex: 108, SysName: "sw-access-2", PortID: "Gi1/0/24", PortDescr: "to access switch", ChassisID: "00:11:22:aa:bb:cc", Protocol: ProtoLLDP}},
		{"cdp phone", ProtoCDP, 0, Neighbor{IfIndex: 103, SysName: "SEP001122334455", PortID: "Port 1", Platform: "Cisco IP Phone 8841", Version: "SIP88xx.14-1-1", Address: "10.20.0.31", Protocol: ProtoCDP}},
		{"cdp switch", ProtoCDP, 1, Neighbor{IfIndex: 108, SysName: "core-sw.example.lan", PortID: "GigabitEthernet1/0/48", Platform: "cisco WS-C2960X-48FPD-L", Version: "Cisco IOS Software, C2960X", Address: "10.20.0.2", Protocol: ProtoCDP}},
		{"mikrotik on a port", ProtoMikroTik, 0, Neighbor{IfIndex: 104, SysName: "hAP-office", ChassisID: "48:a9:8a:01:02:03", Address: "10.20.0.5", Platform: "MikroTik", Version: "7.15.3 (stable)", Protocol: ProtoMikroTik}},
		{"mikrotik without interface", ProtoMikroTik, 1, Neighbor{IfIndex: 0, SysName: "cap-roof", ChassisID: "48:a9:8a:0a:0b:0c", Address: "10.20.0.6", Platform: "MikroTik", Version: "7.14", Protocol: ProtoMikroTik}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			list := byProto[c.proto]
			if c.i >= len(list) {
				t.Fatalf("missing %s entry %d: %+v", c.proto, c.i, res.LLDP)
			}
			if list[c.i] != c.want {
				t.Errorf("got  %+v\nwant %+v", list[c.i], c.want)
			}
		})
	}
	if len(res.LLDP) != 5 {
		t.Errorf("want 5 neighbours, got %d: %+v", len(res.LLDP), res.LLDP)
	}
}

func TestCDPAddressFormats(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{[]byte{10, 0, 0, 1}, "10.0.0.1"},
		{"192.168.88.1", "192.168.88.1"},
		{[]byte{0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}, ""}, // IPv6 is not reported as an IPv4 address
		{"not an address", ""},
		{nil, ""},
	}
	for _, c := range cases {
		if got := ipv4Octets(c.in); got != c.want {
			t.Errorf("ipv4Octets(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
