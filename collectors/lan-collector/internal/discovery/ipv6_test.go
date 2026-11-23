package discovery

import (
	"context"
	"net/netip"
	"sort"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/netinfo"
)

func hostsByIP(hosts []Host) map[string]Host {
	out := map[string]Host{}
	for _, h := range hosts {
		out[h.IP] = h
	}
	return out
}

func sorted(s []string) []string {
	c := append([]string(nil), s...)
	sort.Strings(c)
	return c
}

func TestDiscover6NeverSweepsAndUsesNeighboursAndMulticast(t *testing.T) {
	prefix := netip.MustParsePrefix("fd00:10::/64")
	prober := &fakeProber{alive: map[string]bool{"fd00:10::30": true}}
	reads := 0
	var multicastFrom []netip.Addr
	res := Discover6(context.Background(), prefix, prober, Options{
		Concurrency: 4, PPS: 1000, Timeout: time.Second,
		ReverseName: func(_ context.Context, ip string) string {
			if ip == "fd00:10::1" {
				return "gw.lan"
			}
			if ip == "fe80::1" {
				t.Error("no PTR lookup for a link-local address")
			}
			return ""
		},
		DHCPName: func(mac string) (string, string, bool) {
			if mac == "aa:bb:cc:00:00:30" {
				return "nas", "", true
			}
			return "", "", false
		},
	}, Options6{
		LinkInterfaces: func(p netip.Prefix) []netinfo.LinkInterface {
			return []netinfo.LinkInterface{{Name: "eth0", Index: 3, Source: netip.MustParseAddr("fd00:10::5")}}
		},
		MulticastEcho: func(_ context.Context, src netip.Addr, ifIndex int, _ time.Duration) ([]netip.Addr, error) {
			multicastFrom = append(multicastFrom, src)
			if ifIndex != 3 {
				t.Errorf("multicast on interface %d", ifIndex)
			}
			return []netip.Addr{netip.MustParseAddr("fd00:10::1"), netip.MustParseAddr("fd00:10::20"), netip.MustParseAddr("fe80::1"), netip.MustParseAddr("fd99::1")}, nil
		},
		Neighbors6: func(context.Context) ([]netinfo.Neighbor6, error) {
			reads++
			table := []netinfo.Neighbor6{
				{IP: "fd00:10::1", MAC: "00:11:22:33:44:55", Interface: "eth0", Reachable: true, Router: true},
				{IP: "fe80::1", MAC: "00:11:22:33:44:55", Interface: "eth0", Reachable: true, Router: true},
				{IP: "fd00:10::20", MAC: "aa:bb:cc:00:00:20", Interface: "eth0"},                  // answered multicast, entry stale
				{IP: "fd00:10::30", MAC: "aa:bb:cc:00:00:30", Interface: "eth0"},                  // stale: re-checked by unicast echo → answers
				{IP: "fd00:10::40", MAC: "aa:bb:cc:00:00:40", Interface: "eth0"},                  // stale and silent: gone
				{IP: "fd00:10::50", MAC: "aa:bb:cc:00:00:50", Interface: "eth0", Reachable: true}, // silent to ICMPv6, OS confirms it
				{IP: "fe80::99", MAC: "aa:bb:cc:00:00:99", Interface: "eth0", Reachable: true},    // only link-local: not a device of this scope
				{IP: "fd00:20::7", MAC: "aa:bb:cc:00:00:77", Interface: "eth1", Reachable: true},  // other prefix
			}
			return table, nil
		},
		LocalAddrs: func() map[string]string {
			return map[string]string{"fd00:10::5": "aa:aa:aa:aa:aa:05", "fe80::5": "aa:aa:aa:aa:aa:05", "192.168.1.5": "aa:aa:aa:aa:aa:05"}
		},
	})
	if !res.Complete {
		t.Fatal("expected a complete discovery")
	}
	if reads != 2 {
		t.Errorf("neighbour table read %d times, want 2", reads)
	}
	if len(multicastFrom) != 1 || multicastFrom[0].String() != "fd00:10::5" {
		t.Errorf("multicast must be sent from the host's own scope address: %v", multicastFrom)
	}
	// Only known, not-yet-answered addresses are echoed; the /64 is never enumerated.
	if got := sorted(prober.probed); len(got) != 3 || got[0] != "fd00:10::30" || got[1] != "fd00:10::40" || got[2] != "fd00:10::50" {
		t.Errorf("unicast echo went to %v", got)
	}
	if res.HostsProbed != 5 {
		t.Errorf("HostsProbed = %d, want 2 multicast + 3 unicast", res.HostsProbed)
	}
	h := hostsByIP(res.Hosts)
	want := []string{"fd00:10::1", "fd00:10::20", "fd00:10::30", "fd00:10::5", "fd00:10::50", "fe80::1", "fe80::5"}
	var got []string
	for ip := range h {
		got = append(got, ip)
	}
	if g := sorted(got); len(g) != len(want) || g[0] != want[0] {
		t.Fatalf("hosts = %v, want %v", g, want)
	}
	for _, ip := range want {
		if _, ok := h[ip]; !ok {
			t.Errorf("missing %s (have %v)", ip, sorted(got))
		}
	}
	if gw := h["fd00:10::1"]; gw.MAC != "00:11:22:33:44:55" || gw.Hostname != "gw.lan" || gw.Hints["ndp_router"] != "yes" || sorted(gw.Sources)[0] != "icmpv6_multicast" {
		t.Errorf("gateway: %+v", gw)
	}
	if ll := h["fe80::1"]; ll.MAC != "00:11:22:33:44:55" || ll.Sources[0] != "icmpv6_multicast" {
		t.Errorf("gateway link-local rides along with its MAC: %+v", ll)
	}
	if nas := h["fd00:10::30"]; nas.RTTMs == nil || nas.MAC != "aa:bb:cc:00:00:30" || len(nas.Names) != 1 || nas.Names[0].Name != "nas" {
		t.Errorf("nas: %+v", nas)
	}
	if quiet := h["fd00:10::50"]; quiet.Sources[0] != "ndp_cache" {
		t.Errorf("OS-confirmed neighbour: %+v", quiet)
	}
	if self := h["fd00:10::5"]; self.MAC != "aa:aa:aa:aa:aa:05" || self.Sources[0] != "local_interface" {
		t.Errorf("collector host: %+v", self)
	}
	if res.Hosts[0].IP != "fd00:10::1" {
		t.Errorf("hosts must be sorted by address: %v", res.Hosts[0].IP)
	}
}

func TestDiscover6SmallPrefixIsSwept(t *testing.T) {
	prefix := netip.MustParsePrefix("fd00:10::100/126")
	prober := &fakeProber{alive: map[string]bool{"fd00:10::102": true}}
	res := Discover6(context.Background(), prefix, prober, Options{Concurrency: 2, PPS: 1000, Timeout: time.Second}, Options6{})
	if got := sorted(prober.probed); len(got) != 3 {
		t.Fatalf("a /126 is swept (3 addresses without the subnet-router anycast): %v", got)
	}
	if len(res.Hosts) != 1 || res.Hosts[0].IP != "fd00:10::102" || res.Hosts[0].Sources[0] != "icmpv6" {
		t.Fatalf("hosts: %+v", res.Hosts)
	}
}

func TestDiscover6RefusesIPv4AndStopsOnCancel(t *testing.T) {
	if res := Discover6(context.Background(), netip.MustParsePrefix("192.168.1.0/24"), &fakeProber{}, Options{}, Options6{}); res.Complete || len(res.Hosts) != 0 {
		t.Fatalf("IPv4 prefix: %+v", res)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := Discover6(ctx, netip.MustParsePrefix("fd00::/64"), &fakeProber{}, Options{}, Options6{
		Neighbors6: func(context.Context) ([]netinfo.Neighbor6, error) {
			return []netinfo.Neighbor6{{IP: "fd00::1", MAC: "aa:bb:cc:00:00:01", Reachable: true}}, nil
		},
	})
	if res.Complete {
		t.Fatal("a cancelled discovery must not be reported complete")
	}
}
