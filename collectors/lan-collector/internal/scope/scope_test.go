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
		{"ipv6", base, "fd00::/64", ""},
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
