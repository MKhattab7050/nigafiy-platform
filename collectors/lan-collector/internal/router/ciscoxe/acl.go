package ciscoxe

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Block, unblock and schedules: one Nigafiy ACL, "ip access-list extended NIGAFIY-LAN-IN", applied
// inbound on the LAN interface ("ip access-group NIGAFIY-LAN-IN in"). Each controlled device has a
// pair of entries: a remark that names its MAC ("nigafiy block aa:bb:…" / "nigafiy schedule aa:bb:…")
// and, one sequence number later, "deny ip host <its address> any" (with "time-range NIGAFIY-S-<MAC>"
// for a schedule). The ACL always ends with "permit ip any any", and it is written (PUT, one
// transaction) before it is attached, so attaching it never cuts the LAN off. An interface that
// already has the administrator's inbound ACL is refused: Nigafiy never edits or replaces it.
//
// IOS XE ACLs match IP addresses, not MAC addresses (MAC ACLs only filter on layer-2 switch ports), so
// the block uses the address the router has for the device right now (ARP / DHCP). A device that
// changes its address escapes the block: give it a DHCP reservation first (reservations below).

const (
	aclName      = productPrefix + "LAN-IN"
	aclPath      = nativePath + "/ip/access-list/Cisco-IOS-XE-acl:extended=" + aclName
	permitSeq    = 2147483000
	firstPairSeq = 100
	pairStep     = 10
	remarkBlock  = "nigafiy block "
	remarkSched  = "nigafiy schedule "
	remarkPermit = "nigafiy: permit everything else"
	mechBlock    = "IOS XE ACL " + aclName + " (deny ip host <address> any) inbound on the LAN interface, RESTCONF"
	mechSchedule = "IOS XE time-range NIGAFIY-S-<MAC> bound to a deny entry of " + aclName + ", RESTCONF"
)

type aclEntry struct {
	Seq    int
	Remark string
	Ace    map[string]any
}

type aclPair struct {
	Kind string // "block" or "schedule"
	MAC  string
	Seq  int // remark; the deny entry is Seq+1
	IP   string
	TR   string // time-range of a schedule
}

func (d *Driver) readACL(ctx context.Context, op string) ([]aclEntry, bool, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, aclPath, nil)
	if err != nil {
		return nil, false, err
	}
	if st == http.StatusNotFound || st == http.StatusNoContent {
		return nil, false, nil
	}
	if st != http.StatusOK {
		return nil, false, router.Errorf(router.ErrProtocol, op, "reading %s returned HTTP %d", aclName, st)
	}
	var rep struct {
		Ext []struct {
			Rules []struct {
				Seq    any            `json:"sequence"`
				Remark string         `json:"remark"`
				Ace    map[string]any `json:"ace-rule"`
			} `json:"access-list-seq-rule"`
		} `json:"Cisco-IOS-XE-acl:extended"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil || len(rep.Ext) == 0 {
		return nil, false, router.Errorf(router.ErrProtocol, op, "%s is not an IOS XE extended ACL payload", aclName)
	}
	var out []aclEntry
	for _, r := range rep.Ext[0].Rules {
		n, err := strconv.Atoi(strings.TrimSpace(jsonScalar(r.Seq)))
		if err != nil {
			continue
		}
		out = append(out, aclEntry{Seq: n, Remark: r.Remark, Ace: r.Ace})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, true, nil
}

func pairs(es []aclEntry) []aclPair {
	bySeq := map[int]aclEntry{}
	for _, e := range es {
		bySeq[e.Seq] = e
	}
	var out []aclPair
	for _, e := range es {
		kind, rest := "", ""
		switch {
		case strings.HasPrefix(e.Remark, remarkBlock):
			kind, rest = "block", strings.TrimPrefix(e.Remark, remarkBlock)
		case strings.HasPrefix(e.Remark, remarkSched):
			kind, rest = "schedule", strings.TrimPrefix(e.Remark, remarkSched)
		default:
			continue
		}
		mac, err := router.NormalizeMAC(rest)
		if err != nil {
			continue
		}
		p := aclPair{Kind: kind, MAC: mac, Seq: e.Seq}
		if ace, ok := bySeq[e.Seq+1]; ok && ace.Ace != nil {
			p.IP = str(ace.Ace["host"])
			p.TR = str(ace.Ace["time-range"])
		}
		out = append(out, p)
	}
	return out
}

func remarkEntry(seq int, text string) map[string]any {
	return map[string]any{"sequence": strconv.Itoa(seq), "remark": text}
}

func denyEntry(seq int, ip, timeRange string) map[string]any {
	ace := map[string]any{"action": "deny", "protocol": "ip", "host": ip, "dst-any": []any{nil}}
	if timeRange != "" {
		ace["time-range"] = timeRange
	}
	return map[string]any{"sequence": strconv.Itoa(seq), "ace-rule": ace}
}

// putACL replaces the whole Nigafiy ACL with ps (plus the closing permit) in one transaction.
func (d *Driver) putACL(ctx context.Context, op string, ps []aclPair) error {
	sort.Slice(ps, func(i, j int) bool { return ps[i].Seq < ps[j].Seq })
	rules := make([]map[string]any, 0, 2*len(ps)+2)
	for _, p := range ps {
		prefix := remarkBlock
		if p.Kind == "schedule" {
			prefix = remarkSched
		}
		rules = append(rules, remarkEntry(p.Seq, prefix+p.MAC), denyEntry(p.Seq+1, p.IP, p.TR))
	}
	rules = append(rules, remarkEntry(permitSeq-1, remarkPermit),
		map[string]any{"sequence": strconv.Itoa(permitSeq), "ace-rule": map[string]any{"action": "permit", "protocol": "ip", "any": []any{nil}, "dst-any": []any{nil}}})
	body := map[string]any{"Cisco-IOS-XE-acl:extended": []any{map[string]any{"name": aclName, "access-list-seq-rule": rules}}}
	return d.write(ctx, op, "extended access lists", http.MethodPut, aclPath, body)
}

// attachACL puts NIGAFIY-LAN-IN inbound on the LAN interface (once).
func (d *Driver) attachACL(ctx context.Context, op string, lan iface) error {
	if lan.ACLIn == aclName {
		return nil
	}
	body := map[string]any{"Cisco-IOS-XE-native:" + lan.Type: []any{map[string]any{
		"name": lan.Name,
		"ip":   map[string]any{"access-group": map[string]any{"in": map[string]any{"acl": map[string]any{"acl-name": aclName, "in": []any{nil}}}}},
	}}}
	return d.write(ctx, op, "interface access groups", http.MethodPatch, lan.path(), body)
}

// aclLAN returns the LAN interface, refusing one that carries the administrator's inbound ACL.
func (d *Driver) aclLAN(ctx context.Context, op string) (iface, error) {
	if err := d.writable(ctx, op); err != nil {
		return iface{}, err
	}
	lan, err := d.lan(ctx, op)
	if err != nil {
		return iface{}, err
	}
	if lan.ACLIn != "" && lan.ACLIn != aclName {
		return iface{}, router.Errorf(router.ErrRejected, op, "the LAN interface %s already has the administrator's inbound ACL %q; Nigafiy never replaces or edits it (add the deny entries to that ACL yourself, or remove it)", lan.label(), lan.ACLIn)
	}
	return lan, nil
}

func nextSeq(ps []aclPair) int {
	seq := firstPairSeq
	for _, p := range ps {
		if p.Seq+pairStep > seq {
			seq = p.Seq + pairStep
		}
	}
	return seq
}

// changePair adds (ip valid) or removes (ip zero) the pair of kind for mac, then verifies, attaches
// and saves. It returns whether the ACL changed and whether the requested state existed before.
func (d *Driver) changePair(ctx context.Context, op, kind, mac string, ip netip.Addr, timeRange string) (applied, existed bool, err error) {
	lan, err := d.aclLAN(ctx, op)
	if err != nil {
		return false, false, err
	}
	es, _, err := d.readACL(ctx, op)
	if err != nil {
		return false, false, err
	}
	all := pairs(es)
	var keep []aclPair
	var mine *aclPair
	for i := range all {
		if all[i].Kind == kind && all[i].MAC == mac {
			mine = &all[i]
			continue
		}
		keep = append(keep, all[i])
	}
	if ip.IsValid() {
		if mine != nil && mine.IP == ip.String() && mine.TR == timeRange {
			return false, true, d.attachACL(ctx, op, lan)
		}
		p := aclPair{Kind: kind, MAC: mac, IP: ip.String(), TR: timeRange, Seq: nextSeq(keep)}
		if mine != nil {
			p.Seq = mine.Seq
		}
		keep = append(keep, p)
	} else if mine == nil {
		return false, false, nil
	}
	if err := d.putACL(ctx, op, keep); err != nil {
		return false, false, err
	}
	if err := d.attachACL(ctx, op, lan); err != nil {
		return false, false, err
	}
	// Read back: the pair is there (or gone) and the ACL is on the LAN interface.
	es, _, err = d.readACL(ctx, op)
	if err != nil {
		return false, false, err
	}
	found := false
	for _, p := range pairs(es) {
		if p.Kind == kind && p.MAC == mac && (!ip.IsValid() || p.IP == ip.String()) {
			found = true
		}
	}
	if found != ip.IsValid() {
		return false, false, router.Errorf(router.ErrProtocol, op, "the router accepted the change but %s does not show it when read back", aclName)
	}
	if l2, err := d.lan(ctx, op); err != nil || l2.ACLIn != aclName {
		return false, false, router.Errorf(router.ErrProtocol, op, "the router accepted the change but %s is not on the LAN interface when read back", aclName)
	}
	return true, false, d.save(ctx, op)
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	es, _, err := d.readACL(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	out := []router.BlockEntry{}
	for _, p := range pairs(es) {
		e := router.BlockEntry{MAC: p.MAC, Owner: router.OwnerProduct, Managed: true, Mechanism: mechBlock, Detail: "deny ip host " + p.IP + " any"}
		if p.Kind == "schedule" {
			e.Partial, e.Mechanism, e.Detail = true, mechSchedule, "deny ip host "+p.IP+" any time-range "+p.TR
		}
		out = append(out, e)
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, mac string) (router.Change, error) {
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	if _, err := d.aclLAN(ctx, "block"); err != nil {
		return router.Change{}, err
	}
	ip, err := d.clientIP(ctx, "block", m)
	if err != nil {
		return router.Change{}, err
	}
	if ip == d.routerAddr() {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "block", "%s is the router itself", ip)
	}
	applied, existed, err := d.changePair(ctx, "block", "block", m, ip, "")
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: m, Mechanism: mechBlock, Applied: applied, AlreadyInEffect: existed,
		Detail: fmt.Sprintf("deny ip host %s any in %s (inbound on the LAN interface); saved with write memory", ip, aclName),
		Undo:   "Unblock in Nigafiy, or on the router: ip access-list extended " + aclName + " / no <sequence> (the remark \"" + remarkBlock + m + "\" and the entry after it), then write memory"}, nil
}

func (d *Driver) Unblock(ctx context.Context, mac string) (router.Change, error) {
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	applied, _, err := d.changePair(ctx, "unblock", "block", m, netip.Addr{}, "")
	if err != nil {
		return router.Change{}, err
	}
	detail := "no Nigafiy block entry for this device in " + aclName
	if applied {
		detail = "removed the deny entry for this device from " + aclName + "; saved with write memory"
	}
	return router.Change{Action: "unblock", MAC: m, Mechanism: mechBlock, Applied: applied, Detail: detail, Undo: "Block the device again in Nigafiy"}, nil
}

var iosDays = [7]string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

func timeRangeName(mac string) string { return productPrefix + "S-" + macKey(mac) }

func timeRangePath(name string) string { return nativePath + "/time-range=" + name }

func (d *Driver) SetSchedule(ctx context.Context, mac string, blocked []router.Window) (router.Change, error) {
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	segs, err := router.SplitWindows(blocked)
	if err != nil {
		return router.Change{}, err
	}
	if _, err := d.aclLAN(ctx, "schedule"); err != nil {
		return router.Change{}, err
	}
	ip, err := d.clientIP(ctx, "schedule", m)
	if err != nil {
		return router.Change{}, err
	}
	// "periodic <day> hh:mm to hh:mm" entries; IOS has no 24:00, a segment to midnight ends at 23:59.
	var periodic []map[string]any
	for _, s := range segs {
		end := s.End
		if end == router.EndOfDay {
			end = "23:59"
		}
		for _, day := range s.Days {
			periodic = append(periodic, map[string]any{"days": iosDays[day], "start": s.Start, "end": end})
		}
	}
	name := timeRangeName(m)
	body := map[string]any{"Cisco-IOS-XE-native:time-range": []any{map[string]any{"name": name, "periodic": periodic}}}
	if err := d.write(ctx, "schedule", "time ranges", http.MethodPut, timeRangePath(name), body); err != nil {
		return router.Change{}, err
	}
	applied, existed, err := d.changePair(ctx, "schedule", "schedule", m, ip, name)
	if err != nil {
		return router.Change{}, err
	}
	if !applied {
		// The ACL entry was already in place: the PUT above replaced the windows; save that.
		if err := d.save(ctx, "schedule"); err != nil {
			return router.Change{}, err
		}
	}
	return router.Change{Action: "schedule", MAC: m, Mechanism: mechSchedule, Applied: true, AlreadyInEffect: existed,
		Detail: fmt.Sprintf("blocked %s (router time; a window to midnight ends at 23:59) via time-range %s on deny ip host %s any; saved with write memory", router.DescribeWindows(blocked), name, ip),
		Undo:   "Clear the schedule in Nigafiy, or on the router remove the \"" + remarkSched + m + "\" entries from " + aclName + " and \"no time-range " + name + "\", then write memory"}, nil
}

func (d *Driver) ClearSchedule(ctx context.Context, mac string) (router.Change, error) {
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	applied, _, err := d.changePair(ctx, "schedule", "schedule", m, netip.Addr{}, "")
	if err != nil {
		return router.Change{}, err
	}
	name := timeRangeName(m)
	st, _, err := d.do(ctx, "schedule", http.MethodDelete, timeRangePath(name), nil)
	if err != nil {
		return router.Change{}, err
	}
	if st >= 200 && st < 300 {
		applied = true
		if err := d.save(ctx, "schedule"); err != nil {
			return router.Change{}, err
		}
	}
	return router.Change{Action: "clear_schedule", MAC: m, Mechanism: mechSchedule, Applied: applied,
		Detail: "removed the scheduled deny entry and time-range " + name, Undo: "Set the schedule again in Nigafiy"}, nil
}
