package snmp

import (
	"sort"
	"strings"
)

// VLAN reading for Port Detective's port control. Two standards are read, both read-only here:
//
//   - IEEE 802.1Q (Q-BRIDGE-MIB): the static VLAN table (name, egress and untagged member ports, as
//     PortLists indexed by bridge port) and each bridge port's PVID — the VLAN untagged frames
//     arriving on the port are put in, which for an access port is its access VLAN.
//   - Cisco (CISCO-VTP-MIB / CISCO-VLAN-MEMBERSHIP-MIB): the VTP VLAN table (state, type, name)
//     and vmVlan, the VLAN of a static access port; vlanTrunkPortDynamicStatus says whether a port
//     is trunking.
//
// A switch that implements neither yields no VLAN data; the API then shows VLAN changes as "not
// supported on this switch" instead of guessing.

const (
	oidSysObjectID = ".1.3.6.1.2.1.1.2.0"

	oidDot1qVlanStaticName     = ".1.3.6.1.2.1.17.7.1.4.3.1.1"
	oidDot1qVlanStaticEgress   = ".1.3.6.1.2.1.17.7.1.4.3.1.2"
	oidDot1qVlanStaticUntagged = ".1.3.6.1.2.1.17.7.1.4.3.1.4"
	oidDot1qPvid               = ".1.3.6.1.2.1.17.7.1.4.5.1.1"

	oidVtpVlanState  = ".1.3.6.1.4.1.9.9.46.1.3.1.1.2"
	oidVtpVlanType   = ".1.3.6.1.4.1.9.9.46.1.3.1.1.3"
	oidVtpVlanName   = ".1.3.6.1.4.1.9.9.46.1.3.1.1.4"
	oidVmVlan        = ".1.3.6.1.4.1.9.9.68.1.2.2.1.2"
	oidVlanTrunkStat = ".1.3.6.1.4.1.9.9.46.1.6.1.1.14"

	// MaxVLANs is the 802.1Q VLAN id space; nothing beyond it is read.
	MaxVLANs = 4094
)

// VLAN is one VLAN the switch defines.
type VLAN struct {
	ID     int    `json:"id"`
	Name   string `json:"name,omitempty"`
	Source string `json:"source"` // "qbridge" | "cisco"
}

// PortVLAN is the VLAN membership of one interface as the switch reports it.
type PortVLAN struct {
	IfIndex    int    `json:"if_index"`
	AccessVLAN int    `json:"access_vlan,omitempty"`
	Mode       string `json:"mode"`   // "access" | "trunk" | "unknown"
	Source     string `json:"source"` // "qbridge" | "cisco"
}

// portListHas reports whether 1-based bridge port p is set in an 802.1Q PortList (first octet =
// ports 1-8, most significant bit = lowest port).
func portListHas(list []byte, p int) bool {
	if p < 1 {
		return false
	}
	i := (p - 1) / 8
	return i < len(list) && list[i]&(0x80>>uint((p-1)%8)) != 0
}

// portListWith returns a copy of list with bridge port p set or cleared, extended as needed.
func portListWith(list []byte, p int, on bool) []byte {
	need := (p-1)/8 + 1
	out := make([]byte, max(len(list), need))
	copy(out, list)
	bit := byte(0x80 >> uint((p-1)%8))
	if on {
		out[(p-1)/8] |= bit
	} else {
		out[(p-1)/8] &^= bit
	}
	return out
}

func octets(v any) []byte {
	if b, ok := v.([]byte); ok {
		return b
	}
	return nil
}

// readVLANs fills res.VLANs, res.PortVLANs and res.WriteMethods. base maps bridge ports to ifIndex.
func readVLANs(w walker, base map[int]int, res *Result) {
	toIf := func(bridgePort int) int {
		if i, ok := base[bridgePort]; ok {
			return i
		}
		return bridgePort
	}
	vlans := map[int]*VLAN{}
	ports := map[int]*PortVLAN{}

	// ── Q-BRIDGE ──
	_, _ = w.walk(oidDot1qVlanStaticName, MaxVLANs, func(idx []int, v any) {
		if len(idx) == 1 && idx[0] >= 1 && idx[0] <= MaxVLANs {
			vlans[idx[0]] = &VLAN{ID: idx[0], Name: clip(text(v), 64), Source: "qbridge"}
		}
	})
	egress, untagged := map[int][]byte{}, map[int][]byte{}
	_, _ = w.walk(oidDot1qVlanStaticEgress, MaxVLANs, func(idx []int, v any) {
		if len(idx) == 1 && idx[0] >= 1 && idx[0] <= MaxVLANs {
			egress[idx[0]] = octets(v)
			if vlans[idx[0]] == nil {
				vlans[idx[0]] = &VLAN{ID: idx[0], Source: "qbridge"}
			}
		}
	})
	_, _ = w.walk(oidDot1qVlanStaticUntagged, MaxVLANs, func(idx []int, v any) {
		if len(idx) == 1 && idx[0] >= 1 && idx[0] <= MaxVLANs {
			untagged[idx[0]] = octets(v)
		}
	})
	qbridge := false
	_, _ = w.walk(oidDot1qPvid, MaxPorts, func(idx []int, v any) {
		if len(idx) != 1 || idx[0] < 1 {
			return
		}
		qbridge = true
		bp := idx[0]
		pv := &PortVLAN{IfIndex: toIf(bp), Mode: "access", Source: "qbridge"}
		if n := int(num(v)); n >= 1 && n <= MaxVLANs {
			pv.AccessVLAN = n
		}
		// A port that is a tagged member of any VLAN carries several VLANs: a trunk.
		for id, eg := range egress {
			if portListHas(eg, bp) && !portListHas(untagged[id], bp) {
				pv.Mode = "trunk"
				break
			}
		}
		ports[pv.IfIndex] = pv
	})
	if qbridge && len(egress) > 0 {
		res.WriteMethods = append(res.WriteMethods, "qbridge")
	}

	// ── Cisco VTP / VLAN membership ──
	ciscoVLANs := map[int]*VLAN{}
	state, typ := map[int]int{}, map[int]int{}
	_, _ = w.walk(oidVtpVlanState, MaxVLANs*2, func(idx []int, v any) {
		if len(idx) == 2 && idx[1] >= 1 && idx[1] <= MaxVLANs {
			state[idx[1]] = int(num(v))
		}
	})
	_, _ = w.walk(oidVtpVlanType, MaxVLANs*2, func(idx []int, v any) {
		if len(idx) == 2 && idx[1] >= 1 && idx[1] <= MaxVLANs {
			typ[idx[1]] = int(num(v))
		}
	})
	_, _ = w.walk(oidVtpVlanName, MaxVLANs*2, func(idx []int, v any) {
		if len(idx) != 2 || idx[1] < 1 || idx[1] > MaxVLANs {
			return
		}
		id := idx[1]
		// Only operational Ethernet VLANs can be given to a port (1002-1005 are the FDDI/Token Ring defaults).
		if (state[id] != 0 && state[id] != 1) || (typ[id] != 0 && typ[id] != 1) || (id >= 1002 && id <= 1005) {
			return
		}
		ciscoVLANs[id] = &VLAN{ID: id, Name: clip(text(v), 64), Source: "cisco"}
	})
	trunking := map[int]bool{}
	_, _ = w.walk(oidVlanTrunkStat, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 && num(v) == 1 {
			trunking[idx[0]] = true
		}
	})
	cisco := false
	_, _ = w.walk(oidVmVlan, MaxPorts, func(idx []int, v any) {
		if len(idx) != 1 || idx[0] < 1 {
			return
		}
		cisco = true
		pv := &PortVLAN{IfIndex: idx[0], Mode: "access", Source: "cisco"}
		if n := int(num(v)); n >= 1 && n <= MaxVLANs {
			pv.AccessVLAN = n
		}
		if trunking[idx[0]] {
			pv.Mode = "trunk"
		}
		ports[idx[0]] = pv // vmVlan is authoritative for a Cisco access port
	})
	for i := range trunking {
		if ports[i] == nil {
			ports[i] = &PortVLAN{IfIndex: i, Mode: "trunk", Source: "cisco"}
		} else if ports[i].Source == "cisco" {
			ports[i].Mode = "trunk"
		}
	}
	if cisco && len(ciscoVLANs) > 0 {
		res.WriteMethods = append(res.WriteMethods, "cisco")
		for id, v := range ciscoVLANs {
			if q := vlans[id]; q == nil || q.Name == "" {
				vlans[id] = v
			}
		}
	}

	for _, v := range vlans {
		res.VLANs = append(res.VLANs, *v)
	}
	sort.Slice(res.VLANs, func(i, j int) bool { return res.VLANs[i].ID < res.VLANs[j].ID })
	for _, p := range ports {
		res.PortVLANs = append(res.PortVLANs, *p)
	}
	sort.Slice(res.PortVLANs, func(i, j int) bool { return res.PortVLANs[i].IfIndex < res.PortVLANs[j].IfIndex })
}

// IsCisco reports whether a sysObjectID belongs to Cisco's enterprise tree (1.3.6.1.4.1.9).
func IsCisco(sysObjectID string) bool {
	s := "." + strings.TrimPrefix(sysObjectID, ".")
	return strings.HasPrefix(s, ".1.3.6.1.4.1.9.")
}
