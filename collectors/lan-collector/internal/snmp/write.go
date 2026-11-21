package snmp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Port control (Port Detective, Phase 5): the only SNMP SET in the collector.
//
// A request names one port operation from a closed list — never an OID:
//
//	admin_status  IF-MIB ifAdminStatus.<ifIndex>                       (1 up, 2 down)
//	alias         IF-MIB ifAlias.<ifIndex>                             (port description)
//	access_vlan   qbridge: Q-BRIDGE dot1qVlanStaticEgressPorts/UntaggedPorts.<vlan> + dot1qPvid.<bridgePort>
//	              cisco:   CISCO-VLAN-MEMBERSHIP-MIB vmVlan.<ifIndex>
//
// Every OID written is built here from those constants and checked again by allowedSetOID right
// before it is sent. Each operation reads the current value first, writes, and reads back: a
// change is "verified" only when the switch reports the new value afterwards.

const (
	opAdminStatus = "admin_status"
	opAlias       = "alias"
	opAccessVLAN  = "access_vlan"

	// ifAlias is a DisplayString of at most 64 characters (IF-MIB).
	MaxAliasLength = 64
)

// writableColumns: the complete list of table columns a SET may touch. Nothing else is ever sent.
var writableColumns = []string{oidIfAdminStatus, oidIfAlias, oidDot1qPvid, oidDot1qVlanStaticEgress, oidDot1qVlanStaticUntagged, oidVmVlan}

// allowedSetOID reports whether oid is exactly one instance of a writable column (column + one
// positive integer index).
func allowedSetOID(oid string) bool {
	for _, col := range writableColumns {
		if idx := suffix(col, oid); len(idx) == 1 && idx[0] >= 1 {
			return true
		}
	}
	return false
}

// Credentials are the switch's SNMP write credentials (separate from the read credentials).
type Credentials struct {
	Version   string `json:"version"`
	Community string `json:"community,omitempty"`
	Username  string `json:"username,omitempty"`
	AuthProto string `json:"auth_protocol,omitempty"`
	AuthPass  string `json:"auth_password,omitempty"`
	PrivProto string `json:"priv_protocol,omitempty"`
	PrivPass  string `json:"priv_password,omitempty"`
}

// withCredentials returns the target with its credentials replaced by the write credentials.
func (t Target) withCredentials(c Credentials) Target {
	t.Version, t.Community, t.Username = c.Version, c.Community, c.Username
	t.AuthProto, t.AuthPass, t.PrivProto, t.PrivPass = c.AuthProto, c.AuthPass, c.PrivProto, c.PrivPass
	return t
}

// PortChange is one requested operation on one port.
type PortChange struct {
	IfIndex int
	Op      string // admin_status | alias | access_vlan
	AdminUp bool
	Alias   string
	VLAN    int
	Method  string // access_vlan only: qbridge | cisco
	// Override: the administrator gave a reason to change a port that looks like an uplink, a trunk,
	// or the port the collector / gateway is reached through.
	Override bool
	// ProtectedMACs: the collector host's own MACs and the gateway's MAC. A disruptive change on a
	// port where one of them is learned would cut the collector off; refused without Override.
	ProtectedMACs []string
}

// PortState is what the switch reported for the values an operation touches.
type PortState struct {
	AdminUp *bool   `json:"admin_up,omitempty"`
	Alias   *string `json:"alias,omitempty"`
	VLAN    *int    `json:"vlan,omitempty"`
}

// ChangeResult is the outcome of an operation that reached the write step.
type ChangeResult struct {
	Method     string    `json:"method"`
	Before     PortState `json:"before"`
	After      PortState `json:"after"`
	Verified   bool      `json:"verified"`
	RolledBack bool      `json:"rolled_back,omitempty"`
	Steps      []string  `json:"steps,omitempty"`
}

// ChangeError is a refused or failed operation with a stable kind for the API.
type ChangeError struct {
	Kind    string
	Message string
}

func (e *ChangeError) Error() string { return e.Message }

func fail(kind, format string, args ...any) *ChangeError {
	return &ChangeError{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// ValidateChange checks a request without touching the network.
func ValidateChange(ch PortChange) error {
	if ch.IfIndex < 1 || ch.IfIndex > 2_147_483_647 {
		return fail("invalid_request", "invalid interface index")
	}
	switch ch.Op {
	case opAdminStatus:
	case opAlias:
		if len(ch.Alias) > MaxAliasLength {
			return fail("invalid_request", "a port description has at most %d characters", MaxAliasLength)
		}
		for _, r := range ch.Alias {
			if r < 0x20 || r > 0x7e {
				return fail("invalid_request", "a port description may contain printable ASCII characters only")
			}
		}
	case opAccessVLAN:
		if ch.VLAN < 1 || ch.VLAN > MaxVLANs {
			return fail("invalid_request", "a VLAN id is between 1 and %d", MaxVLANs)
		}
		if ch.Method != "qbridge" && ch.Method != "cisco" {
			return fail("invalid_request", "unknown VLAN method")
		}
	default:
		return fail("invalid_request", "unknown port operation")
	}
	return nil
}

type session struct {
	g     *gosnmp.GoSNMP
	steps []string
}

func (s *session) step(format string, args ...any) {
	if len(s.steps) < 12 {
		s.steps = append(s.steps, clip(fmt.Sprintf(format, args...), 200))
	}
}

// get reads exact instances; a missing instance comes back as nil.
func (s *session) get(oids ...string) (map[string]any, error) {
	r, err := s.g.Get(oids)
	if err != nil {
		return nil, cleanErr(err)
	}
	if r.Error != gosnmp.NoError {
		return nil, fail("no_answer", "the switch refused to read: %s", r.Error)
	}
	out := map[string]any{}
	for _, v := range r.Variables {
		if v.Type == gosnmp.NoSuchObject || v.Type == gosnmp.NoSuchInstance || v.Type == gosnmp.EndOfMibView || v.Type == gosnmp.Null {
			continue
		}
		out[strings.TrimPrefix(v.Name, ".")] = v.Value
	}
	return out, nil
}

func key(oid string) string { return strings.TrimPrefix(oid, ".") }

// set writes the given instances in one PDU, after checking every OID against the allow-list.
func (s *session) set(pdus ...gosnmp.SnmpPDU) error {
	for _, p := range pdus {
		if !allowedSetOID(p.Name) {
			return fail("internal", "refusing to write an OID outside the port-control allow-list")
		}
	}
	r, err := s.g.Set(pdus)
	if err != nil {
		return fail("no_answer", "the switch did not answer the write request (%s)", cleanErr(err).Error())
	}
	if r.Error != gosnmp.NoError {
		switch r.Error {
		case gosnmp.NoAccess, gosnmp.AuthorizationError, gosnmp.NotWritable, gosnmp.ReadOnly, gosnmp.NoCreation:
			return fail("write_rejected", "the switch refused the write (%s): the write credentials may be read-only or this object is not writable on this model", r.Error)
		default:
			return fail("write_rejected", "the switch rejected the value (%s)", r.Error)
		}
	}
	return nil
}

func inst(col string, idx int) string { return fmt.Sprintf("%s.%d", col, idx) }

// ApplyPortChange performs one validated port operation with the write credentials.
func ApplyPortChange(ctx context.Context, t Target, creds Credentials, ch PortChange, timeout time.Duration) (*ChangeResult, error) {
	if err := ValidateChange(ch); err != nil {
		return nil, err
	}
	g, err := connect(ctx, t.withCredentials(creds), timeout)
	if err != nil {
		return nil, fail("not_configured", "%s", err.Error())
	}
	defer g.Conn.Close()
	g.MaxRepetitions = 25
	s := &session{g: g}

	var res *ChangeResult
	switch ch.Op {
	case opAdminStatus:
		res, err = s.adminStatus(ctx, t, ch)
	case opAlias:
		res, err = s.alias(ch)
	case opAccessVLAN:
		if ch.Method == "cisco" {
			res, err = s.ciscoVLAN(ctx, t, ch)
		} else {
			res, err = s.qbridgeVLAN(ctx, t, ch)
		}
	}
	if res != nil {
		res.Steps = s.steps
	}
	return res, err
}

func boolp(b bool) *bool    { return &b }
func strp(v string) *string { return &v }
func intp(v int) *int       { return &v }

// guardSelf refuses a disruptive change on a port where the collector host or the gateway is
// learned, unless the administrator overrode it. "Never cut yourself off."
func (s *session) guardSelf(ch PortChange) error {
	if ch.Override || len(ch.ProtectedMACs) == 0 {
		return nil
	}
	protected := map[string]bool{}
	for _, m := range ch.ProtectedMACs {
		protected[strings.ToLower(m)] = true
	}
	w := walker{s.g}
	base := map[int]int{}
	_, _ = w.walk(oidBasePortIfIndex, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 {
			base[idx[0]] = int(num(v))
		}
	})
	toIf := func(bp int) int {
		if i, ok := base[bp]; ok {
			return i
		}
		return bp
	}
	found := ""
	check := func(mac string, bp int) {
		if found == "" && mac != "" && protected[mac] && toIf(bp) == ch.IfIndex {
			found = mac
		}
	}
	_, _ = w.walk(oidDot1qFdbPort, MaxFDB, func(idx []int, v any) {
		if len(idx) == 7 {
			check(macFrom(idx[1:]), int(num(v)))
		}
	})
	_, _ = w.walk(oidDot1dFdbPort, MaxFDB, func(idx []int, v any) {
		check(macFrom(idx), int(num(v)))
	})
	if found != "" {
		return fail("self_port", "the collector or the gateway (%s) is reached through this port; changing it would cut LAN Detective off. Give an override reason to proceed", found)
	}
	return nil
}

func (s *session) adminStatus(ctx context.Context, t Target, ch PortChange) (*ChangeResult, error) {
	oid := inst(oidIfAdminStatus, ch.IfIndex)
	cur, err := s.get(oid)
	if err != nil {
		return nil, err
	}
	v, ok := cur[key(oid)]
	if !ok {
		return nil, fail("port_not_found", "the switch has no interface %d", ch.IfIndex)
	}
	res := &ChangeResult{Method: "ifmib", Before: PortState{AdminUp: boolp(num(v) == 1)}}
	if !ch.AdminUp {
		if err := s.guardSelf(ch); err != nil {
			return nil, err
		}
	}
	want := 2
	if ch.AdminUp {
		want = 1
	}
	s.step("ifAdminStatus.%d: %d → %d", ch.IfIndex, num(v), want)
	if err := s.set(gosnmp.SnmpPDU{Name: oid, Type: gosnmp.Integer, Value: want}); err != nil {
		return res, err
	}
	after, err := s.get(oid)
	if err != nil {
		return res, fail("readback_failed", "written, but the switch did not answer the read-back: %s", err.Error())
	}
	av, ok := after[key(oid)]
	if ok {
		res.After.AdminUp = boolp(num(av) == 1)
	}
	res.Verified = ok && int(num(av)) == want
	if !res.Verified {
		return res, fail("readback_mismatch", "the switch accepted the write but still reports the port as %s", map[bool]string{true: "enabled", false: "disabled"}[num(av) == 1])
	}
	return res, nil
}

func (s *session) alias(ch PortChange) (*ChangeResult, error) {
	oid := inst(oidIfAlias, ch.IfIndex)
	cur, err := s.get(oid)
	if err != nil {
		return nil, err
	}
	v, ok := cur[key(oid)]
	if !ok {
		return nil, fail("unsupported", "the switch does not expose a description (ifAlias) for interface %d", ch.IfIndex)
	}
	res := &ChangeResult{Method: "ifmib", Before: PortState{Alias: strp(text(v))}}
	s.step("ifAlias.%d: %q → %q", ch.IfIndex, text(v), ch.Alias)
	if err := s.set(gosnmp.SnmpPDU{Name: oid, Type: gosnmp.OctetString, Value: []byte(ch.Alias)}); err != nil {
		return res, err
	}
	after, err := s.get(oid)
	if err != nil {
		return res, fail("readback_failed", "written, but the switch did not answer the read-back: %s", err.Error())
	}
	if av, ok := after[key(oid)]; ok {
		res.After.Alias = strp(text(av))
		res.Verified = text(av) == strings.TrimSpace(ch.Alias)
	}
	if !res.Verified {
		return res, fail("readback_mismatch", "the switch accepted the write but reports a different description")
	}
	return res, nil
}

// ciscoVLAN: a static access port's VLAN is vmVlan.<ifIndex>. A port without a vmVlan row is not a
// static access port (a trunk, a routed port, or dynamic VLAN membership) and is not changed.
func (s *session) ciscoVLAN(ctx context.Context, t Target, ch PortChange) (*ChangeResult, error) {
	oid := inst(oidVmVlan, ch.IfIndex)
	cur, err := s.get(oid, inst(oidVlanTrunkStat, ch.IfIndex))
	if err != nil {
		return nil, err
	}
	v, ok := cur[key(oid)]
	if !ok {
		return nil, fail("not_access_port", "interface %d is not a static access port on this Cisco switch (no vmVlan entry): trunks and routed ports are not changed", ch.IfIndex)
	}
	if tr, ok := cur[key(inst(oidVlanTrunkStat, ch.IfIndex))]; ok && num(tr) == 1 && !ch.Override {
		return nil, fail("not_access_port", "interface %d is trunking", ch.IfIndex)
	}
	old := int(num(v))
	res := &ChangeResult{Method: "cisco", Before: PortState{VLAN: intp(old)}}
	if !s.ciscoVLANExists(ch.VLAN) {
		return res, fail("vlan_not_found", "VLAN %d is not an active Ethernet VLAN in the switch's VTP table", ch.VLAN)
	}
	if err := s.guardSelf(ch); err != nil {
		return nil, err
	}
	s.step("vmVlan.%d: %d → %d", ch.IfIndex, old, ch.VLAN)
	if err := s.set(gosnmp.SnmpPDU{Name: oid, Type: gosnmp.Integer, Value: ch.VLAN}); err != nil {
		return res, err
	}
	after, err := s.get(oid)
	if err != nil {
		return res, fail("readback_failed", "written, but the switch did not answer the read-back: %s", err.Error())
	}
	if av, ok := after[key(oid)]; ok {
		res.After.VLAN = intp(int(num(av)))
		res.Verified = int(num(av)) == ch.VLAN
	}
	if !res.Verified {
		return res, fail("readback_mismatch", "the switch accepted the write but the port is not in VLAN %d", ch.VLAN)
	}
	return res, nil
}

func (s *session) ciscoVLANExists(id int) bool {
	found := false
	w := walker{s.g}
	_, _ = w.walk(oidVtpVlanState, MaxVLANs*2, func(idx []int, v any) {
		if len(idx) == 2 && idx[1] == id && num(v) == 1 {
			found = true
		}
	})
	return found
}

// qbridgeVLAN moves an access port to another VLAN the 802.1Q way, so the port actually carries it:
//
//  1. add the port to the new VLAN's egress and untagged member lists;
//  2. set the port's PVID to the new VLAN (untagged frames arriving on it join that VLAN);
//  3. remove the port from the old VLAN's untagged and egress lists.
//
// Member lists are read, modified for this one port and written back (read-modify-write). If a
// later step fails, the earlier ones are undone. A port that is a tagged member of any VLAN is a
// trunk and is not changed.
func (s *session) qbridgeVLAN(ctx context.Context, t Target, ch PortChange) (*ChangeResult, error) {
	w := walker{s.g}
	bp := 0
	_, _ = w.walk(oidBasePortIfIndex, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 && int(num(v)) == ch.IfIndex && bp == 0 {
			bp = idx[0]
		}
	})
	if bp == 0 {
		// Without a bridge-port table the bridge port is taken as the ifIndex (as when reading).
		bp = ch.IfIndex
	}
	pvidOID := inst(oidDot1qPvid, bp)
	cur, err := s.get(pvidOID)
	if err != nil {
		return nil, err
	}
	pv, ok := cur[key(pvidOID)]
	if !ok {
		return nil, fail("not_access_port", "the switch reports no 802.1Q PVID for interface %d (bridge port %d)", ch.IfIndex, bp)
	}
	old := int(num(pv))
	res := &ChangeResult{Method: "qbridge", Before: PortState{VLAN: intp(old)}}

	// Trunk check over every static VLAN: tagged membership anywhere = the port carries several VLANs.
	egress, untagged := map[int][]byte{}, map[int][]byte{}
	_, _ = w.walk(oidDot1qVlanStaticEgress, MaxVLANs, func(idx []int, v any) {
		if len(idx) == 1 {
			egress[idx[0]] = octets(v)
		}
	})
	_, _ = w.walk(oidDot1qVlanStaticUntagged, MaxVLANs, func(idx []int, v any) {
		if len(idx) == 1 {
			untagged[idx[0]] = octets(v)
		}
	})
	if _, ok := egress[ch.VLAN]; !ok {
		return res, fail("vlan_not_found", "VLAN %d is not in the switch's static VLAN table", ch.VLAN)
	}
	if !ch.Override {
		for id, eg := range egress {
			if portListHas(eg, bp) && !portListHas(untagged[id], bp) {
				return res, fail("not_access_port", "interface %d is a tagged member of VLAN %d: it is a trunk", ch.IfIndex, id)
			}
		}
	}
	if err := s.guardSelf(ch); err != nil {
		return nil, err
	}

	newEg, newUn := egress[ch.VLAN], untagged[ch.VLAN]
	egN, unN := inst(oidDot1qVlanStaticEgress, ch.VLAN), inst(oidDot1qVlanStaticUntagged, ch.VLAN)
	undoNew := func() bool {
		return s.set(gosnmp.SnmpPDU{Name: egN, Type: gosnmp.OctetString, Value: newEg}, gosnmp.SnmpPDU{Name: unN, Type: gosnmp.OctetString, Value: newUn}) == nil
	}

	// 1. Member of the new VLAN (egress + untagged). Some agents want two PDUs; try one first.
	s.step("VLAN %d: add bridge port %d to egress and untagged members", ch.VLAN, bp)
	addEg, addUn := portListWith(newEg, bp, true), portListWith(newUn, bp, true)
	if err := s.set(gosnmp.SnmpPDU{Name: egN, Type: gosnmp.OctetString, Value: addEg}, gosnmp.SnmpPDU{Name: unN, Type: gosnmp.OctetString, Value: addUn}); err != nil {
		if err2 := s.set(gosnmp.SnmpPDU{Name: egN, Type: gosnmp.OctetString, Value: addEg}); err2 != nil {
			return res, err
		}
		if err2 := s.set(gosnmp.SnmpPDU{Name: unN, Type: gosnmp.OctetString, Value: addUn}); err2 != nil {
			res.RolledBack = undoNew()
			return res, err2
		}
	}
	// 2. PVID.
	s.step("dot1qPvid.%d: %d → %d", bp, old, ch.VLAN)
	if err := s.set(gosnmp.SnmpPDU{Name: pvidOID, Type: gosnmp.Gauge32, Value: uint32(ch.VLAN)}); err != nil {
		res.RolledBack = undoNew()
		return res, err
	}
	// 3. Leave the old VLAN.
	if old != ch.VLAN && old >= 1 {
		if oldEg, ok := egress[old]; ok {
			egO, unO := inst(oidDot1qVlanStaticEgress, old), inst(oidDot1qVlanStaticUntagged, old)
			s.step("VLAN %d: remove bridge port %d from untagged and egress members", old, bp)
			oldUn := untagged[old]
			if err := s.set(
				gosnmp.SnmpPDU{Name: unO, Type: gosnmp.OctetString, Value: portListWith(oldUn, bp, false)},
				gosnmp.SnmpPDU{Name: egO, Type: gosnmp.OctetString, Value: portListWith(oldEg, bp, false)},
			); err != nil {
				back := s.set(gosnmp.SnmpPDU{Name: pvidOID, Type: gosnmp.Gauge32, Value: uint32(old)}) == nil
				res.RolledBack = back && undoNew()
				return res, err
			}
		}
	}

	// Read back everything the change touched.
	oids := []string{pvidOID, egN, unN}
	if old != ch.VLAN && old >= 1 {
		oids = append(oids, inst(oidDot1qVlanStaticUntagged, old), inst(oidDot1qVlanStaticEgress, old))
	}
	after, err := s.get(oids...)
	if err != nil {
		return res, fail("readback_failed", "written, but the switch did not answer the read-back: %s", err.Error())
	}
	if v, ok := after[key(pvidOID)]; ok {
		res.After.VLAN = intp(int(num(v)))
	}
	inNew := portListHas(octets(after[key(egN)]), bp) && portListHas(octets(after[key(unN)]), bp)
	leftOld := true
	if old != ch.VLAN && old >= 1 {
		if _, had := egress[old]; had {
			leftOld = !portListHas(octets(after[key(inst(oidDot1qVlanStaticUntagged, old))]), bp)
		}
	}
	res.Verified = res.After.VLAN != nil && *res.After.VLAN == ch.VLAN && inNew && leftOld
	if !res.Verified {
		var why []string
		if res.After.VLAN == nil || *res.After.VLAN != ch.VLAN {
			why = append(why, "the PVID is not the new VLAN")
		}
		if !inNew {
			why = append(why, "the port is not an untagged member of the new VLAN")
		}
		if !leftOld {
			why = append(why, "the port is still an untagged member of the old VLAN")
		}
		return res, fail("readback_mismatch", "the switch accepted the writes but %s", strings.Join(why, ", "))
	}
	return res, nil
}

// ErrKind extracts the stable kind of an error from ApplyPortChange.
func ErrKind(err error) string {
	var ce *ChangeError
	if errors.As(err, &ce) {
		return ce.Kind
	}
	return "internal"
}
