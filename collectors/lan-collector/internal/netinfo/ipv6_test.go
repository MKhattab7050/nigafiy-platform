package netinfo

import (
	"net/netip"
	"reflect"
	"testing"
)

func TestParseIPNeigh6(t *testing.T) {
	out := `fe80::1 dev eth0 lladdr 00:11:22:33:44:55 router REACHABLE
fd00:10::20 dev eth0 lladdr aa:bb:cc:dd:ee:02 STALE
fd00:10::21 dev eth0 lladdr aa:bb:cc:dd:ee:03 DELAY
fd00:10::30 dev eth0  FAILED
fd00:10::31 dev eth0 INCOMPLETE
ff02::1 dev eth0 lladdr 33:33:00:00:00:01 NOARP
192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
2a01:4f8:1:2::9 dev wlan0 lladdr aa:bb:cc:dd:ee:09 PROBE
`
	got := ParseIPNeigh6(out)
	want := []Neighbor6{
		{IP: "fe80::1", MAC: "00:11:22:33:44:55", Interface: "eth0", Reachable: true, Router: true},
		{IP: "fd00:10::20", MAC: "aa:bb:cc:dd:ee:02", Interface: "eth0"},
		{IP: "fd00:10::21", MAC: "aa:bb:cc:dd:ee:03", Interface: "eth0", Reachable: true},
		{IP: "2a01:4f8:1:2::9", MAC: "aa:bb:cc:dd:ee:09", Interface: "wlan0", Reachable: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseStateTable6(t *testing.T) {
	out := "fe80::1 00-11-22-33-44-55 Reachable Ethernet\r\n" +
		"fe80::5%12 AA-BB-CC-DD-EE-05 Stale Ethernet 2\r\n" +
		"fd00:10:0:0:0:0:0:20 aa-bb-cc-dd-ee-02 Delay Wi-Fi\r\n" +
		"fd00:10::30 00-00-00-00-00-00 Unreachable Wi-Fi\r\n" +
		"ff02::1 33-33-00-00-00-01 Permanent Wi-Fi\r\n" +
		"fd00:10::31  Incomplete Wi-Fi\r\n"
	got := ParseStateTable6(out)
	want := []Neighbor6{
		{IP: "fe80::1", MAC: "00:11:22:33:44:55", Interface: "Ethernet", Reachable: true},
		{IP: "fe80::5", MAC: "aa:bb:cc:dd:ee:05", Interface: "Ethernet 2"},
		{IP: "fd00:10::20", MAC: "aa:bb:cc:dd:ee:02", Interface: "Wi-Fi", Reachable: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseNetshNeighbors6(t *testing.T) {
	out := "\r\nInterface 1: Loopback Pseudo-Interface 1\r\n\r\n\r\n" +
		"Internet Address                              Physical Address   Type\r\n" +
		"--------------------------------------------  -----------------  -----------\r\n" +
		"ff02::c                                                          Permanent\r\n\r\n" +
		"Interface 12: Ethernet 2\r\n\r\n" +
		"Internet Address                              Physical Address   Type\r\n" +
		"--------------------------------------------  -----------------  -----------\r\n" +
		"fe80::1                                       00-11-22-33-44-55  Reachable (Router)\r\n" +
		"fd00:10::20                                   aa-bb-cc-dd-ee-02  Stale\r\n" +
		"fd00:10::30                                   00-00-00-00-00-00  Unreachable\r\n" +
		"ff02::1                                       33-33-00-00-00-01  Permanent\r\n"
	got := ParseNetshNeighbors6(out)
	want := []Neighbor6{
		{IP: "fe80::1", MAC: "00:11:22:33:44:55", Interface: "Ethernet 2", Reachable: true, Router: true},
		{IP: "fd00:10::20", MAC: "aa:bb:cc:dd:ee:02", Interface: "Ethernet 2"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseNDP(t *testing.T) {
	out := `Neighbor                             Linklayer Address  Netif Expire    St Flgs Prbs
fe80::1%en0                          0:11:22:33:44:55     en0 23h59m58s S  R
fd00:10::20                          aa:bb:cc:dd:ee:2     en0 permanent R
fd00:10::21                          aa:bb:cc:dd:ee:3     en0 5s        D
fd00:10::22                          (incomplete)         en0 expired   I
fd00:10::23                          aa:bb:cc:dd:ee:4     en0 expired   N
`
	got := ParseNDP(out)
	want := []Neighbor6{
		{IP: "fe80::1", MAC: "00:11:22:33:44:55", Interface: "en0", Router: true},
		{IP: "fd00:10::20", MAC: "aa:bb:cc:dd:ee:02", Interface: "en0", Reachable: true},
		{IP: "fd00:10::21", MAC: "aa:bb:cc:dd:ee:03", Interface: "en0", Reachable: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestLinkInterfaces(t *testing.T) {
	ifaces := []ifaceAddrs{
		{name: "eth0", index: 3, mac: "aa:aa:aa:aa:aa:01", addrs: []netip.Addr{netip.MustParseAddr("192.168.1.5"), netip.MustParseAddr("fe80::a"), netip.MustParseAddr("fd00:10::5")}},
		{name: "wlan0", index: 4, mac: "aa:aa:aa:aa:aa:02", addrs: []netip.Addr{netip.MustParseAddr("fe80::b"), netip.MustParseAddr("2a01:4f8:1:2::7")}},
	}
	got := linkInterfaces(netip.MustParsePrefix("fd00:10::/64"), ifaces)
	if len(got) != 1 || got[0].Name != "eth0" || got[0].Index != 3 || got[0].Source.String() != "fd00:10::5" {
		t.Fatalf("unique-local scope: %+v", got)
	}
	got = linkInterfaces(netip.MustParsePrefix("fe80::/64"), ifaces)
	if len(got) != 2 || got[1].Source.String() != "fe80::b" {
		t.Fatalf("link-local scope: %+v", got)
	}
	if got := linkInterfaces(netip.MustParsePrefix("fd00:99::/64"), ifaces); len(got) != 0 {
		t.Fatalf("no interface on that prefix: %+v", got)
	}
}
