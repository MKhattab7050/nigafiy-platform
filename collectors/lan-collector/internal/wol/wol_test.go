package wol

import (
	"bytes"
	"net"
	"net/netip"
	"testing"
)

func TestMagicPacket(t *testing.T) {
	mac, _ := net.ParseMAC("00:be:43:49:ce:88")
	p := MagicPacket(mac)
	if len(p) != 102 || !bytes.Equal(p[:6], bytes.Repeat([]byte{0xff}, 6)) || !bytes.Equal(p[96:], mac) {
		t.Fatalf("bad packet: % x", p)
	}
}

func TestParseMAC(t *testing.T) {
	if _, err := ParseMAC("00:be:43:49:ce:88"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "00:00:00:00:00:00", "nonsense", "00:11:22:33:44:55:66:77"} {
		if _, err := ParseMAC(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestBroadcastOf(t *testing.T) {
	cases := map[string]string{"192.168.1.0/24": "192.168.1.255", "10.0.4.0/22": "10.0.7.255", "172.16.0.0/20": "172.16.15.255", "192.168.1.128/25": "192.168.1.255"}
	for cidr, want := range cases {
		if got := BroadcastOf(netip.MustParsePrefix(cidr)).String(); got != want {
			t.Errorf("%s: got %s want %s", cidr, got, want)
		}
	}
}

func TestSendOnlyToAuthorizedBroadcast(t *testing.T) {
	mac, _ := ParseMAC("00:be:43:49:ce:88")
	allowed := []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}
	for _, target := range []string{"10.0.0.255", "192.168.1.20", "8.8.8.8"} {
		if err := Send(mac, netip.MustParseAddr(target), allowed); err == nil {
			t.Errorf("sending to %s must be refused", target)
		}
	}
}
