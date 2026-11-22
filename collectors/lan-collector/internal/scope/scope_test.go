package scope

import (
	"net/netip"
	"testing"
)

func TestPolicyCheck(t *testing.T) {
	base := Policy{MinPrefixBits: 20}
	cases := []struct {
		name   string
		policy Policy
		cidr   string
		want   string // normalised prefix, or "" when it must be refused
	}{
		{"private /24", base, "192.168.1.0/24", "192.168.1.0/24"},
		{"host bits are masked", base, "192.168.1.77/24", "192.168.1.0/24"},
		{"10/20", base, "10.4.16.0/20", "10.4.16.0/20"},
		{"172.16/12 member", base, "172.20.5.0/24", "172.20.5.0/24"},
		{"public range", base, "8.8.8.0/24", ""},
		{"cgnat is not private", base, "100.64.0.0/24", ""},
		{"172.32 is public", base, "172.32.0.0/24", ""},
		{"too large", base, "10.0.0.0/8", ""},
		{"/19 too large", base, "10.0.0.0/19", ""},
		{"ipv6 unique-local /64", base, "fd00::/64", "fd00::/64"},
		{"ipv6 host bits are masked", base, "fd12:3456:789a:1::42/64", "fd12:3456:789a:1::/64"},
		{"ipv6 global unicast /64", base, "2a01:4f8:1:2::/64", "2a01:4f8:1:2::/64"},
		{"ipv6 link-local", base, "fe80::/64", "fe80::/64"},
		{"ipv6 site /48", base, "fd00:1::/48", "fd00:1::/48"},
		{"ipv6 /47 too large", base, "fd00::/47", ""},
		{"ipv6 multicast", base, "ff02::/64", ""},
		{"ipv6 6to4", base, "2002:c0a8:101::/48", ""},
		{"ipv6 teredo", base, "2001:0:1::/48", ""},
		{"ipv6 nat64", base, "64:ff9b::/96", ""},
		{"ipv6 documentation", base, "2001:db8:1::/48", ""},
		{"ipv6 documentation 3fff", base, "3fff:1::/48", ""},
		{"ipv6 orchid", base, "2001:20::/48", ""},
		{"ipv4-mapped", base, "::ffff:192.168.1.0/120", ""},
		{"ipv6 zone refused", base, "fe80::%eth0/64", ""},
		{"ipv6 loopback refused by default", base, "::1/128", ""},
		{"ipv6 loopback in dev mode", Policy{MinPrefixBits: 20, AllowLoopback: true}, "::1/128", "::1/128"},
		{"ipv6 outside v4-only allow-list", Policy{MinPrefixBits: 20, Allowed: []netip.Prefix{netip.MustParsePrefix("192.168.0.0/16")}}, "fd00::/64", ""},
		{"ipv6 inside allow-list", Policy{MinPrefixBits: 20, Allowed: []netip.Prefix{netip.MustParsePrefix("fd00::/48")}}, "fd00:0:0:5::/64", "fd00:0:0:5::/64"},
		{"garbage", base, "all", ""},
		{"loopback refused by default", base, "127.0.0.0/29", ""},
		{"loopback in dev mode", Policy{MinPrefixBits: 20, AllowLoopback: true}, "127.0.0.0/29", "127.0.0.0/29"},
		{"inside local allow-list", Policy{MinPrefixBits: 20, Allowed: []netip.Prefix{netip.MustParsePrefix("192.168.0.0/16")}}, "192.168.7.0/24", "192.168.7.0/24"},
		{"outside local allow-list", Policy{MinPrefixBits: 20, Allowed: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}}, "10.0.0.0/24", ""},
		{"wider than allow-list entry", Policy{MinPrefixBits: 20, Allowed: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}}, "192.168.0.0/23", ""},
	}
	for _, tc := range cases {
		got, err := tc.policy.Check(tc.cidr)
		if tc.want == "" {
			if err == nil {
				t.Errorf("%s: %s should be refused, got %s", tc.name, tc.cidr, got)
			}
			continue
		}
		if err != nil || got.String() != tc.want {
			t.Errorf("%s: got %v / %v, want %s", tc.name, got, err, tc.want)
		}
	}
}

func TestHosts(t *testing.T) {
	if n := len(Hosts(netip.MustParsePrefix("192.168.1.0/24"))); n != 254 {
		t.Errorf("/24 should have 254 hosts, got %d", n)
	}
	h := Hosts(netip.MustParsePrefix("10.0.0.0/30"))
	if len(h) != 2 || h[0].String() != "10.0.0.1" || h[1].String() != "10.0.0.2" {
		t.Errorf("/30 hosts wrong: %v", h)
	}
	if n := len(Hosts(netip.MustParsePrefix("10.0.0.0/31"))); n != 2 {
		t.Errorf("/31 should have 2 hosts, got %d", n)
	}
	if n := len(Hosts(netip.MustParsePrefix("10.0.0.5/32"))); n != 1 {
		t.Errorf("/32 should have 1 host, got %d", n)
	}
	if n := len(Hosts(netip.MustParsePrefix("10.0.0.0/20"))); n != 4094 {
		t.Errorf("/20 should have 4094 hosts, got %d", n)
	}
}

func TestSweepable(t *testing.T) {
	cases := map[string]bool{
		"192.168.1.0/24":    true,
		"10.0.0.0/20":       true,
		"fd00::/64":         false,
		"fd00::/119":        false,
		"fd00::/120":        true,
		"fd00::ff00/128":    true,
		"2a01:4f8:1:2::/56": false,
	}
	for cidr, want := range cases {
		err := Sweepable(netip.MustParsePrefix(cidr))
		if (err == nil) != want {
			t.Errorf("Sweepable(%s) = %v, want sweepable=%v", cidr, err, want)
		}
	}
	if len(Hosts(netip.MustParsePrefix("fd00::/64"))) != 0 {
		t.Error("an IPv6 /64 must never be enumerated")
	}
}

func TestHostsIPv6(t *testing.T) {
	h := Hosts(netip.MustParsePrefix("fd00::100/120"))
	if len(h) != 255 || h[0].String() != "fd00::101" || h[254].String() != "fd00::1ff" {
		t.Errorf("/120 hosts wrong: %d first=%v", len(h), h[0])
	}
	if h := Hosts(netip.MustParsePrefix("fd00::/127")); len(h) != 2 {
		t.Errorf("/127 should have 2 hosts, got %d", len(h))
	}
	if h := Hosts(netip.MustParsePrefix("fd00::5/128")); len(h) != 1 || h[0].String() != "fd00::5" {
		t.Errorf("/128 should be the address itself, got %v", h)
	}
}

func TestIsLinkLocal(t *testing.T) {
	for s, want := range map[string]bool{"fe80::1": true, "fe80::1%eth0": true, "febf::1": true, "fec0::1": false, "fd00::1": false, "192.168.1.1": false} {
		if got := IsLinkLocal(netip.MustParseAddr(s)); got != want {
			t.Errorf("IsLinkLocal(%s) = %v", s, got)
		}
	}
}

func TestClassOf(t *testing.T) {
	for s, want := range map[string]Class{
		"::1": ClassLoopback, "fe80::1%eth0": ClassLinkLocal, "fd12::1": ClassUniqueLocal, "fc00::1": ClassUniqueLocal,
		"2a01:4f8::1": ClassGlobal, "2001:db8::1": ClassOther, "2001::1": ClassOther, "2002::1": ClassOther,
		"ff02::1": ClassOther, "::": ClassOther, "::ffff:192.168.1.1": ClassOther, "192.168.1.1": ClassOther,
		"2620:4f:8000::1": ClassOther, "2620:4f:8001::1": ClassGlobal, "3fff::1": ClassOther,
	} {
		if got := ClassOf(netip.MustParseAddr(s)); got != want {
			t.Errorf("ClassOf(%s) = %v, want %v", s, got, want)
		}
	}
}
