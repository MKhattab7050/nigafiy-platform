package snmp

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/nigafiy/sensor/internal/snmp/sim"
)

const writeCommunity = "w-r1te-secret-77"

var write = Credentials{Version: "2c", Community: writeCommunity}

// qSwitch: 8 ports; VLAN 1 (default) on 3-7, VLAN 10 "Office" on 1-2, VLAN 99 "Quarantine" empty,
// port 8 a trunk (LLDP uplink, tagged in every VLAN). Devices on ports 1, 2 and 8.
func qSwitch() *sim.Agent {
	a := sim.Switch("ro-community", "sw-q", 8, []sim.Device{
		{MAC: "00:0c:29:aa:00:01", Port: 1, VLAN: 10},
		{MAC: "00:0c:29:aa:00:02", Port: 2, VLAN: 10},
		{MAC: "00:0c:29:aa:00:09", Port: 8, VLAN: 1},
	}, "sw-core")
	a.QBridge(8, []sim.VLAN{{ID: 1, Name: "default", Ports: []int{3, 4, 5, 6, 7}}, {ID: 10, Name: "Office", Ports: []int{1, 2}}, {ID: 99, Name: "Quarantine"}}, 8)
	a.WriteCommunity = writeCommunity
	return a
}

func ciscoSwitch() *sim.Agent {
	a := sim.Switch("ro-community", "c2960", 8, []sim.Device{{MAC: "00:0c:29:bb:00:01", Port: 1}}, "")
	a.Cisco(8, []sim.VLAN{{ID: 1, Name: "default"}, {ID: 20, Name: "Staff", Ports: []int{1, 2}}, {ID: 666, Name: "QUARANTINE"}}, 8)
	a.WriteCommunity = writeCommunity
	return a
}

func listHas(t *testing.T, a *sim.Agent, oid string, port int) bool {
	t.Helper()
	v, ok := a.Value(oid)
	if !ok {
		t.Fatalf("%s missing", oid)
	}
	return portListHas(v.([]byte), port)
}

func TestPollReadsQBridgeVLANs(t *testing.T) {
	res, err := Poll(context.Background(), start(t, qSwitch()), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.VLANs) != 3 || res.VLANs[1].ID != 10 || res.VLANs[1].Name != "Office" || res.VLANs[1].Source != "qbridge" {
		t.Fatalf("vlans: %+v", res.VLANs)
	}
	byIf := map[int]PortVLAN{}
	for _, p := range res.PortVLANs {
		byIf[p.IfIndex] = p
	}
	if p := byIf[101]; p.AccessVLAN != 10 || p.Mode != "access" || p.Source != "qbridge" {
		t.Errorf("port 1: %+v", p)
	}
	if p := byIf[103]; p.AccessVLAN != 1 || p.Mode != "access" {
		t.Errorf("port 3: %+v", p)
	}
	if p := byIf[108]; p.Mode != "trunk" {
		t.Errorf("port 8 is tagged in every VLAN and must read as a trunk: %+v", p)
	}
	if strings.Join(res.WriteMethods, ",") != "qbridge" {
		t.Errorf("write methods: %v", res.WriteMethods)
	}
}

func TestPollReadsCiscoVLANs(t *testing.T) {
	res, err := Poll(context.Background(), start(t, ciscoSwitch()), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !IsCisco(res.SysObjectID) {
		t.Fatalf("sysObjectID %q", res.SysObjectID)
	}
	ids := []string{}
	for _, v := range res.VLANs {
		ids = append(ids, fmt.Sprintf("%d:%s:%s", v.ID, v.Name, v.Source))
	}
	if strings.Join(ids, ",") != "1:default:cisco,20:Staff:cisco,666:QUARANTINE:cisco" {
		t.Fatalf("vlans: %v", ids)
	}
	byIf := map[int]PortVLAN{}
	for _, p := range res.PortVLANs {
		byIf[p.IfIndex] = p
	}
	if p := byIf[101]; p.AccessVLAN != 20 || p.Mode != "access" || p.Source != "cisco" {
		t.Errorf("port 1: %+v", p)
	}
	if p := byIf[108]; p.Mode != "trunk" {
		t.Errorf("port 8: %+v", p)
	}
	if strings.Join(res.WriteMethods, ",") != "cisco" {
		t.Errorf("write methods: %v", res.WriteMethods)
	}
}

func TestQBridgeAccessVLANChangeIsCompleteAndVerified(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 99, Method: "qbridge"}, 2*time.Second)
	if err != nil {
		t.Fatalf("%v (%+v)", err, res)
	}
	if !res.Verified || res.Method != "qbridge" || *res.Before.VLAN != 10 || *res.After.VLAN != 99 {
		t.Fatalf("result: %+v", res)
	}
	// The port actually carries VLAN 99: PVID, egress and untagged in 99; gone from 10.
	if v, _ := a.Value("1.3.6.1.2.1.17.7.1.4.5.1.1.1"); v != uint(99) {
		t.Errorf("pvid = %v", v)
	}
	if !listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.2.99", 1) || !listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.99", 1) {
		t.Error("port 1 must be an egress and untagged member of VLAN 99")
	}
	if listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.2.10", 1) || listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.10", 1) {
		t.Error("port 1 must have left VLAN 10")
	}
	// Port 2 (same VLAN 10) untouched.
	if !listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.10", 2) {
		t.Error("port 2 must stay in VLAN 10")
	}
	// Only allow-listed OIDs were written.
	for _, oid := range a.Sets() {
		if !allowedSetOID(oid) {
			t.Errorf("wrote %s", oid)
		}
	}
	// Moving back restores the original membership.
	if _, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 10, Method: "qbridge"}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if !listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.10", 1) || listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.99", 1) {
		t.Error("release did not restore VLAN 10")
	}
}

func TestQBridgeRefusesTrunkAndUnknownVLAN(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	_, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 108, Op: "access_vlan", VLAN: 99, Method: "qbridge"}, 2*time.Second)
	if ErrKind(err) != "not_access_port" {
		t.Fatalf("trunk: %v", err)
	}
	_, err = ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 300, Method: "qbridge"}, 2*time.Second)
	if ErrKind(err) != "vlan_not_found" {
		t.Fatalf("unknown vlan: %v", err)
	}
	if len(a.Sets()) != 0 {
		t.Fatalf("nothing may be written: %v", a.Sets())
	}
}

func TestSelfPortGuard(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	ch := PortChange{IfIndex: 102, Op: "admin_status", AdminUp: false, ProtectedMACs: []string{"00:0C:29:AA:00:02"}}
	_, err := ApplyPortChange(context.Background(), tg, write, ch, 2*time.Second)
	if ErrKind(err) != "self_port" {
		t.Fatalf("want self_port, got %v", err)
	}
	if len(a.Sets()) != 0 {
		t.Fatal("nothing may be written")
	}
	ch.Override = true
	res, err := ApplyPortChange(context.Background(), tg, write, ch, 2*time.Second)
	if err != nil || !res.Verified || *res.After.AdminUp {
		t.Fatalf("override: %v %+v", err, res)
	}
}

func TestAdminStatusAndAlias(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 103, Op: "admin_status", AdminUp: false}, 2*time.Second)
	if err != nil || !res.Verified || !*res.Before.AdminUp || *res.After.AdminUp {
		t.Fatalf("disable: %v %+v", err, res)
	}
	res, err = ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 103, Op: "alias", Alias: "Reception PC"}, 2*time.Second)
	if err != nil || !res.Verified || *res.Before.Alias != "" || *res.After.Alias != "Reception PC" {
		t.Fatalf("alias: %v %+v", err, res)
	}
	if _, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 999, Op: "admin_status", AdminUp: true}, 2*time.Second); ErrKind(err) != "port_not_found" {
		t.Fatalf("missing port: %v", err)
	}
}

func TestReadOnlyCredentialsAndIgnoredWritesAreReported(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	_, err := ApplyPortChange(context.Background(), tg, Credentials{Version: "2c", Community: "ro-community"}, PortChange{IfIndex: 103, Op: "admin_status"}, 2*time.Second)
	if ErrKind(err) != "write_rejected" {
		t.Fatalf("read community: %v", err)
	}
	if strings.Contains(err.Error(), "ro-community") {
		t.Fatal("error leaks the community")
	}
	a.IgnoreSets = true
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 103, Op: "admin_status"}, 2*time.Second)
	if ErrKind(err) != "readback_mismatch" || res == nil || res.Verified {
		t.Fatalf("ignored write must not verify: %v %+v", err, res)
	}
}

func TestQBridgeRollsBackWhenPVIDIsRejected(t *testing.T) {
	a := qSwitch()
	a.RejectSet = func(oid string) gosnmp.SNMPError {
		if strings.HasPrefix(oid, ".1.3.6.1.2.1.17.7.1.4.5.1.1.") {
			return gosnmp.InconsistentValue
		}
		return gosnmp.NoError
	}
	tg := start(t, a)
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 99, Method: "qbridge"}, 2*time.Second)
	if ErrKind(err) != "write_rejected" || res == nil || !res.RolledBack {
		t.Fatalf("want rolled-back rejection: %v %+v", err, res)
	}
	if listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.99", 1) {
		t.Error("membership of VLAN 99 must be undone")
	}
	if !listHas(t, a, "1.3.6.1.2.1.17.7.1.4.3.1.4.10", 1) {
		t.Error("VLAN 10 must be untouched")
	}
}

func TestCiscoAccessVLAN(t *testing.T) {
	a := ciscoSwitch()
	tg := start(t, a)
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 666, Method: "cisco"}, 2*time.Second)
	if err != nil || !res.Verified || res.Method != "cisco" || *res.Before.VLAN != 20 || *res.After.VLAN != 666 {
		t.Fatalf("%v %+v", err, res)
	}
	if v, _ := a.Value("1.3.6.1.4.1.9.9.68.1.2.2.1.2.101"); v != 666 {
		t.Errorf("vmVlan = %v", v)
	}
	if _, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 108, Op: "access_vlan", VLAN: 666, Method: "cisco"}, 2*time.Second); ErrKind(err) != "not_access_port" {
		t.Fatalf("trunk: %v", err)
	}
	if _, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 30, Method: "cisco"}, 2*time.Second); ErrKind(err) != "vlan_not_found" {
		t.Fatalf("unknown VLAN: %v", err)
	}
}

func TestValidationAndAllowList(t *testing.T) {
	for _, bad := range []PortChange{
		{IfIndex: 0, Op: "admin_status"},
		{IfIndex: 1, Op: "set_any_oid"},
		{IfIndex: 1, Op: "alias", Alias: strings.Repeat("x", 65)},
		{IfIndex: 1, Op: "alias", Alias: "bad\x00name"},
		{IfIndex: 1, Op: "access_vlan", VLAN: 0, Method: "qbridge"},
		{IfIndex: 1, Op: "access_vlan", VLAN: 4095, Method: "qbridge"},
		{IfIndex: 1, Op: "access_vlan", VLAN: 10, Method: "telnet"},
	} {
		if err := ValidateChange(bad); ErrKind(err) != "invalid_request" {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	for oid, ok := range map[string]bool{
		".1.3.6.1.2.1.2.2.1.7.5":              true,
		".1.3.6.1.2.1.31.1.1.1.18.5":          true,
		".1.3.6.1.4.1.9.9.68.1.2.2.1.2.10101": true,
		".1.3.6.1.2.1.2.2.1.7":                false, // column, not an instance
		".1.3.6.1.2.1.2.2.1.7.5.1":            false,
		".1.3.6.1.2.1.1.5.0":                  false, // sysName
		".1.3.6.1.4.1.9.2.1.55.10.0.0.1":      false, // Cisco tftp config write
		".1.3.6.1.2.1.2.2.1.70.5":             false,
	} {
		if allowedSetOID(oid) != ok {
			t.Errorf("allowedSetOID(%s) = %v", oid, !ok)
		}
	}
}
