package snmp

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/snmp/sim"
)

func start(t *testing.T, a *sim.Agent) Target {
	t.Helper()
	addr, err := a.Start("127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind loopback UDP:", err)
	}
	t.Cleanup(a.Stop)
	host, port, _ := net.SplitHostPort(addr)
	p, _ := strconv.Atoi(port)
	return Target{ID: "t1", Host: host, Port: p, Version: "2c", Community: a.Community}
}

func demo() *sim.Agent {
	return sim.Switch("s3cret-ro", "sw-core", 8, []sim.Device{
		{MAC: "00:0c:29:aa:00:01", Port: 1},
		{MAC: "00:0c:29:aa:00:02", Port: 2, VLAN: 20},
		{MAC: "00:0c:29:aa:00:03", Port: 8, VLAN: 20},
		{MAC: "00:0c:29:aa:00:04", Port: 8, VLAN: 20},
		{MAC: "00:0c:29:aa:00:05", Port: 8},
	}, "sw-access-2")
}

func TestPollReadsPortsForwardingTableAndNeighbours(t *testing.T) {
	target := start(t, demo())
	res, err := Poll(context.Background(), target, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.SysName != "sw-core" || !strings.Contains(res.SysDescr, "Simulated") {
		t.Errorf("system: %q %q", res.SysName, res.SysDescr)
	}
	if len(res.Ports) != 8 {
		t.Fatalf("want 8 ports, got %d", len(res.Ports))
	}
	p1, p3, p8 := res.Ports[0], res.Ports[2], res.Ports[7]
	if p1.IfIndex != 101 || p1.Name != "Gi0/1" || p1.Descr != "GigabitEthernet0/1" || !p1.OperUp || !p1.AdminUp || p1.SpeedMbps != 1000 ||
		p1.InErrors != 3 || p1.InOctets != 1_000_000 || p1.OutOctets != 2_000_000 {
		t.Errorf("port 1: %+v", p1)
	}
	if p3.OperUp {
		t.Errorf("port 3 has nothing connected and must be down: %+v", p3)
	}
	if p8.Alias != "Uplink" || !p8.OperUp {
		t.Errorf("port 8: %+v", p8)
	}

	// Bridge ports are translated to ifIndex (100+n); both the VLAN-aware and the plain table are read.
	got := map[string]FDBEntry{}
	for _, e := range res.FDB {
		got[e.MAC] = e
	}
	want := map[string]FDBEntry{
		"00:0c:29:aa:00:01": {MAC: "00:0c:29:aa:00:01", IfIndex: 101, VLAN: 0},
		"00:0c:29:aa:00:02": {MAC: "00:0c:29:aa:00:02", IfIndex: 102, VLAN: 20},
		"00:0c:29:aa:00:03": {MAC: "00:0c:29:aa:00:03", IfIndex: 108, VLAN: 20},
		"00:0c:29:aa:00:04": {MAC: "00:0c:29:aa:00:04", IfIndex: 108, VLAN: 20},
		"00:0c:29:aa:00:05": {MAC: "00:0c:29:aa:00:05", IfIndex: 108, VLAN: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("fdb: %+v", res.FDB)
	}
	for mac, w := range want {
		if got[mac] != w {
			t.Errorf("%s: got %+v want %+v", mac, got[mac], w)
		}
	}

	if len(res.LLDP) != 1 {
		t.Fatalf("lldp: %+v", res.LLDP)
	}
	n := res.LLDP[0]
	if n.IfIndex != 108 || n.SysName != "sw-access-2" || n.PortID != "Gi1/0/24" || n.ChassisID != "00:11:22:aa:bb:cc" {
		t.Errorf("neighbour: %+v", n)
	}
	if len(res.Truncated) != 0 {
		t.Errorf("nothing should be truncated: %v", res.Truncated)
	}
}

func TestWrongCommunityIsAnErrorThatDoesNotLeakIt(t *testing.T) {
	target := start(t, demo())
	target.Community = "wrong-community-string"
	_, err := Poll(context.Background(), target, 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "wrong-community-string") || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("error leaks the community: %v", err)
	}
}

func TestDeviceWithoutBridgeOrLLDPTables(t *testing.T) {
	a := &sim.Agent{Community: "public"}
	a.Str("1.3.6.1.2.1.1.1.0", "Plain router")
	a.Str("1.3.6.1.2.1.1.5.0", "rtr")
	a.Str("1.3.6.1.2.1.2.2.1.2.1", "eth0")
	a.Int("1.3.6.1.2.1.2.2.1.8.1", 1)
	res, err := Poll(context.Background(), start(t, a), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ports) != 1 || res.Ports[0].Name != "eth0" || !res.Ports[0].OperUp || len(res.FDB) != 0 || len(res.LLDP) != 0 {
		t.Fatalf("unexpected: %+v", res)
	}
}

func TestRejectsBadTargets(t *testing.T) {
	for _, bad := range []Target{
		{Host: "switch.example.com", Version: "2c", Community: "x"},
		{Host: "192.168.1.1", Version: "1", Community: "x"},
		{Host: "192.168.1.1", Version: "2c"},
		{Host: "192.168.1.1", Version: "3"},
		{Host: "192.168.1.1", Version: "3", Username: "u", AuthProto: "rot13", AuthPass: "x"},
	} {
		if _, err := Poll(context.Background(), bad, 100*time.Millisecond); err == nil {
			t.Errorf("%+v should be rejected", bad)
		}
	}
}
