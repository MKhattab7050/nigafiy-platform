package sim

import (
	"fmt"
	"strings"

	"github.com/gosnmp/gosnmp"
)

// Writable registers column prefixes on which SET is accepted (with the write community only).
func (a *Agent) Writable(prefixes ...string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, p := range prefixes {
		a.writable = append(a.writable, "."+strings.TrimPrefix(p, "."))
	}
}

// Sets returns the OIDs written so far, in order (one entry per varbind applied).
func (a *Agent) Sets() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.sets...)
}

// Value returns the current value of an exact OID.
func (a *Agent) Value(oid string) (any, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	e, ok := a.exact("." + strings.TrimPrefix(oid, "."))
	return e.value, ok
}

func (a *Agent) isWritable(name string) bool {
	for _, p := range a.writable {
		if strings.HasPrefix(name, p+".") {
			return true
		}
	}
	return false
}

// handleSet applies a SET PDU atomically, like an agent following RFC 3416: every varbind is
// checked first (access, existence, type); only if all pass are they applied. Called with a.mu held.
func (a *Agent) handleSet(req *gosnmp.SnmpPacket, resp *gosnmp.SnmpPacket) {
	resp.Variables = append(resp.Variables, req.Variables...)
	failAt := func(i int, status gosnmp.SNMPError) {
		resp.Error, resp.ErrorIndex = status, uint8(i+1)
	}
	if req.Community != a.WriteCommunity || a.WriteCommunity == "" {
		failAt(0, gosnmp.NoAccess)
		return
	}
	for i, v := range req.Variables {
		name := "." + strings.TrimPrefix(v.Name, ".")
		if a.RejectSet != nil {
			if st := a.RejectSet(name); st != gosnmp.NoError {
				failAt(i, st)
				return
			}
		}
		if !a.isWritable(name) {
			failAt(i, gosnmp.NotWritable)
			return
		}
		e, ok := a.exact(name)
		if !ok {
			failAt(i, gosnmp.NoCreation)
			return
		}
		if e.typ != v.Type {
			failAt(i, gosnmp.WrongType)
			return
		}
	}
	if a.IgnoreSets {
		return
	}
	for _, v := range req.Variables {
		name := "." + strings.TrimPrefix(v.Name, ".")
		for j := range a.entries {
			if a.entries[j].name == name {
				val := v.Value
				if b, ok := val.([]byte); ok {
					val = append([]byte(nil), b...) // the decoder may alias the receive buffer
				}
				if a.MangleSet != nil {
					val = a.MangleSet(name, val)
				}
				if a.entries[j].typ == gosnmp.Gauge32 {
					if u, ok := val.(uint32); ok {
						val = uint(u)
					}
				}
				a.entries[j].value = val
			}
		}
		a.sets = append(a.sets, name)
	}
}

// VLAN is one VLAN of a VLAN-aware demo switch: its id, name and access ports (port numbers).
type VLAN struct {
	ID    int
	Name  string
	Ports []int
}

// portList builds an 802.1Q PortList with the given 1-based bridge ports set.
func portList(n int, ports []int) []byte {
	out := make([]byte, (n+7)/8)
	for _, p := range ports {
		if p >= 1 && p <= n {
			out[(p-1)/8] |= 0x80 >> uint((p-1)%8)
		}
	}
	return out
}

// QBridge adds an 802.1Q static VLAN table and PVIDs to a Switch-built agent with `ports` ports.
// Every port is an untagged member of exactly one VLAN (its access VLAN); `trunk` ports are tagged
// members of every VLAN (and untagged in VLAN 1). The write community, when set, may change the
// PVIDs, the member lists, ifAdminStatus and ifAlias.
func (a *Agent) QBridge(ports int, vlans []VLAN, trunk ...int) {
	access := map[int]int{}
	for _, v := range vlans {
		for _, p := range v.Ports {
			access[p] = v.ID
		}
	}
	isTrunk := map[int]bool{}
	for _, p := range trunk {
		isTrunk[p] = true
	}
	for _, v := range vlans {
		egress, untagged := append([]int{}, v.Ports...), append([]int{}, v.Ports...)
		for _, p := range trunk {
			egress = append(egress, p)
			if v.ID == 1 {
				untagged = append(untagged, p)
			}
		}
		a.Str(fmt.Sprintf("1.3.6.1.2.1.17.7.1.4.3.1.1.%d", v.ID), v.Name)
		a.Set(fmt.Sprintf("1.3.6.1.2.1.17.7.1.4.3.1.2.%d", v.ID), gosnmp.OctetString, portList(ports, egress))
		a.Set(fmt.Sprintf("1.3.6.1.2.1.17.7.1.4.3.1.4.%d", v.ID), gosnmp.OctetString, portList(ports, untagged))
	}
	for p := 1; p <= ports; p++ {
		pvid := access[p]
		if pvid == 0 {
			pvid = 1
		}
		a.Gauge(fmt.Sprintf("1.3.6.1.2.1.17.7.1.4.5.1.1.%d", p), uint(pvid))
	}
	a.Writable("1.3.6.1.2.1.17.7.1.4.5.1.1", "1.3.6.1.2.1.17.7.1.4.3.1.2", "1.3.6.1.2.1.17.7.1.4.3.1.4",
		"1.3.6.1.2.1.2.2.1.7", "1.3.6.1.2.1.31.1.1.1.18")
}

// Cisco makes a Switch-built agent look like a Cisco IOS switch: Cisco sysObjectID, a VTP VLAN
// table (management domain 1) and vmVlan for access ports (ifIndex = 100 + port). `trunk` ports have
// no vmVlan row and report trunking. Writable: vmVlan, ifAdminStatus, ifAlias.
func (a *Agent) Cisco(ports int, vlans []VLAN, trunk ...int) {
	a.Set("1.3.6.1.2.1.1.2.0", gosnmp.ObjectIdentifier, ".1.3.6.1.4.1.9.1.1208")
	a.Str("1.3.6.1.2.1.1.1.0", "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E (LAN Detective test agent)")
	access := map[int]int{}
	for _, v := range vlans {
		a.Int(fmt.Sprintf("1.3.6.1.4.1.9.9.46.1.3.1.1.2.1.%d", v.ID), 1)
		a.Int(fmt.Sprintf("1.3.6.1.4.1.9.9.46.1.3.1.1.3.1.%d", v.ID), 1)
		a.Str(fmt.Sprintf("1.3.6.1.4.1.9.9.46.1.3.1.1.4.1.%d", v.ID), v.Name)
		for _, p := range v.Ports {
			access[p] = v.ID
		}
	}
	isTrunk := map[int]bool{}
	for _, p := range trunk {
		isTrunk[p] = true
	}
	for p := 1; p <= ports; p++ {
		i := 100 + p
		if isTrunk[p] {
			a.Int(fmt.Sprintf("1.3.6.1.4.1.9.9.46.1.6.1.1.14.%d", i), 1)
			continue
		}
		a.Int(fmt.Sprintf("1.3.6.1.4.1.9.9.46.1.6.1.1.14.%d", i), 2)
		vlan := access[p]
		if vlan == 0 {
			vlan = 1
		}
		a.Int(fmt.Sprintf("1.3.6.1.4.1.9.9.68.1.2.2.1.2.%d", i), vlan)
	}
	a.Writable("1.3.6.1.4.1.9.9.68.1.2.2.1.2", "1.3.6.1.2.1.2.2.1.7", "1.3.6.1.2.1.31.1.1.1.18")
}
