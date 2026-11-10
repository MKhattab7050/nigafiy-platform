package netinfo

import "testing"

func TestNormalizeMAC(t *testing.T) {
	cases := map[string]string{
		"00-0C-29-AB-CD-EF": "00:0c:29:ab:cd:ef",
		"0:c:29:ab:cd:ef":   "00:0c:29:ab:cd:ef", // macOS drops leading zeros
		"ff:ff:ff:ff:ff:ff": "",                  // broadcast
		"01:00:5e:00:00:16": "",                  // multicast
		"00:00:00:00:00:00": "",
		"(incomplete)":      "",
		"00:0c:29":          "",
	}
	for in, want := range cases {
		if got := NormalizeMAC(in); got != want {
			t.Errorf("NormalizeMAC(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseIPNeigh(t *testing.T) {
	out := `192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 router REACHABLE
192.168.1.20 dev eth0 lladdr aa:bb:cc:dd:ee:02 STALE
192.168.1.30 dev eth0  FAILED
192.168.1.31 dev eth0 INCOMPLETE
192.168.1.40 dev eth0 lladdr aa:bb:cc:dd:ee:04 DELAY
fe80::1 dev eth0 lladdr 00:11:22:33:44:55 router STALE
`
	n := ParseIPNeigh(out)
	if len(n) != 3 {
		t.Fatalf("expected 3 entries, got %d: %v", len(n), n)
	}
	if e := n["192.168.1.1"]; e.MAC != "00:11:22:33:44:55" || !e.Reachable {
		t.Errorf("gateway entry wrong: %+v", e)
	}
	if e := n["192.168.1.20"]; e.MAC != "aa:bb:cc:dd:ee:02" || e.Reachable {
		t.Errorf("stale entry must not count as reachable: %+v", e)
	}
	if !n["192.168.1.40"].Reachable {
		t.Errorf("DELAY should count as reachable")
	}
}

func TestParseProcARP(t *testing.T) {
	content := `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         00:11:22:33:44:55     *        eth0
192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0
192.168.1.20     0x1         0x6         aa:bb:cc:dd:ee:02     *        eth0
`
	n := ParseProcARP(content)
	if len(n) != 2 || n["192.168.1.1"].MAC != "00:11:22:33:44:55" || n["192.168.1.20"].MAC != "aa:bb:cc:dd:ee:02" {
		t.Errorf("unexpected: %v", n)
	}
	if n["192.168.1.1"].Reachable {
		t.Errorf("/proc/net/arp carries no freshness; entries must not be marked reachable")
	}
}

func TestParseStateTable(t *testing.T) {
	out := "192.168.1.1 00-11-22-33-44-55 Reachable\r\n192.168.1.20 AA-BB-CC-DD-EE-02 Stale\r\n192.168.1.255 FF-FF-FF-FF-FF-FF Permanent\r\n224.0.0.22 01-00-5E-00-00-16 Permanent\r\n192.168.1.77 00-00-00-00-00-00 Unreachable\r\n"
	n := ParseStateTable(out)
	if len(n) != 2 || !n["192.168.1.1"].Reachable || n["192.168.1.20"].Reachable || n["192.168.1.20"].MAC != "aa:bb:cc:dd:ee:02" {
		t.Errorf("unexpected: %v", n)
	}
}

func TestParseArpA(t *testing.T) {
	mac := "? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]\n? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]\n? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]\n"
	n := ParseArpA(mac)
	if len(n) != 1 || n["192.168.1.1"].MAC != "00:11:22:33:44:55" {
		t.Errorf("macOS: unexpected %v", n)
	}
	win := "\r\nInterface: 192.168.1.23 --- 0x8\r\n  Internet Address      Physical Address      Type\r\n  192.168.1.1           00-11-22-33-44-55     dynamic\r\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\r\n"
	n = ParseArpA(win)
	if len(n) != 1 || n["192.168.1.1"].MAC != "00:11:22:33:44:55" {
		t.Errorf("windows: unexpected %v", n)
	}
}

func TestGatewayParsers(t *testing.T) {
	proc := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n"
	if gw := ParseProcRoute(proc); gw != "192.168.1.1" {
		t.Errorf("ParseProcRoute = %q", gw)
	}
	win := "IPv4 Route Table\r\n===========\r\nActive Routes:\r\nNetwork Destination        Netmask          Gateway       Interface  Metric\r\n          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.23     25\r\n        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331\r\n"
	if gw := ParseRoutePrint(win); gw != "192.168.1.1" {
		t.Errorf("ParseRoutePrint = %q", gw)
	}
	if gw := ParseRoutePrint("no routes here"); gw != "" {
		t.Errorf("expected empty gateway, got %q", gw)
	}
	bsd := "   route to: default\ndestination: default\n       mask: default\n    gateway: 10.0.0.1\n  interface: en0\n"
	if gw := ParseRouteGet(bsd); gw != "10.0.0.1" {
		t.Errorf("ParseRouteGet = %q", gw)
	}
}
