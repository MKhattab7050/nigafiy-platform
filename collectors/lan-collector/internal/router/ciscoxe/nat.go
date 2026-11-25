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

// Port forwards: static NAT with ports (Cisco-IOS-XE-nat, list nat-static-transport-list-with-vrf):
//
//	ip nat inside source static {tcp|udp} <LAN address> <port> <outside address> <port>
//
// IOS XE maps one port per entry, so a rule is one external port ("both" is a tcp and a udp entry,
// written in one transaction). The outside address is the static IPv4 address of the interface with
// "ip nat outside"; NAT itself ("ip nat inside" on the LAN, "ip nat outside" on the WAN) must already
// be set up by the administrator — Nigafiy never turns NAT on. IOS XE static NAT has no description,
// so Nigafiy cannot tell its own entries from the administrator's: every entry is shown as the
// administrator's, and removal deletes exactly the entry the operator saw (keys re-checked).

const (
	natPath   = nativePath + "/ip/Cisco-IOS-XE-nat:nat"
	natList   = "nat-static-transport-list-with-vrf"
	mechNAT   = "IOS XE static NAT (ip nat inside source static tcp/udp), RESTCONF"
	natListPa = natPath + "/inside/source/static/" + natList
)

type natEntry struct {
	Proto      string
	LocalIP    string
	LocalPort  int
	GlobalIP   string
	GlobalPort int
}

func (e natEntry) key() string {
	return strings.Join([]string{e.Proto, e.LocalIP, strconv.Itoa(e.LocalPort), e.GlobalIP, strconv.Itoa(e.GlobalPort)}, ",")
}

func (d *Driver) natEntries(ctx context.Context, op string) ([]natEntry, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, natPath, nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound || st == http.StatusNoContent {
		return []natEntry{}, nil
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "reading NAT returned HTTP %d", st)
	}
	var rep struct {
		NAT struct {
			Inside struct {
				Source struct {
					Static map[string][]map[string]any `json:"static"`
				} `json:"source"`
			} `json:"inside"`
		} `json:"Cisco-IOS-XE-nat:nat"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "not an IOS XE NAT payload")
	}
	out := []natEntry{}
	for _, e := range rep.NAT.Inside.Source.Static[natList] {
		lp, _ := strconv.Atoi(jsonScalar(e["local-port"]))
		gp, _ := strconv.Atoi(jsonScalar(e["global-port"]))
		ne := natEntry{Proto: strings.ToLower(str(e["proto"])), LocalIP: str(e["local-ip"]), LocalPort: lp, GlobalIP: str(e["global-ip"]), GlobalPort: gp}
		if (ne.Proto == "tcp" || ne.Proto == "udp") && lp > 0 && gp > 0 && ne.LocalIP != "" && ne.GlobalIP != "" {
			out = append(out, ne)
		}
	}
	return out, nil
}

// forwards groups NAT entries into rules (a tcp and a udp entry with the same addresses and ports is "both").
func forwards(es []natEntry) []router.PortForward {
	type k struct {
		lip, gip string
		lp, gp   int
	}
	protos := map[k][]string{}
	var order []k
	for _, e := range es {
		kk := k{e.LocalIP, e.GlobalIP, e.LocalPort, e.GlobalPort}
		if protos[kk] == nil {
			order = append(order, kk)
		}
		protos[kk] = append(protos[kk], e.Proto)
	}
	out := make([]router.PortForward, 0, len(order))
	for _, kk := range order {
		ps := protos[kk]
		sort.Strings(ps)
		proto := ps[0]
		if len(ps) > 1 {
			proto = router.ProtoBoth
		}
		out = append(out, router.PortForward{
			ID: fmt.Sprintf("%s:%d>%s:%d", proto, kk.gp, kk.lip, kk.lp), Enabled: true,
			Description: fmt.Sprintf("static NAT %s %s:%d", proto, kk.gip, kk.gp), Protocol: proto,
			ExternalStart: kk.gp, ExternalEnd: kk.gp, InternalStart: kk.lp, InternalEnd: kk.lp, InternalIP: kk.lip, Owner: router.OwnerAdmin,
		})
	}
	return out
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	es, err := d.natEntries(ctx, "settings")
	if err != nil {
		return nil, err
	}
	return forwards(es), nil
}

// natInterfaces returns the LAN (must have "ip nat inside") and the outside address.
func (d *Driver) natInterfaces(ctx context.Context, op string) (iface, netip.Addr, error) {
	all, err := d.interfaces(ctx, op)
	if err != nil {
		return iface{}, netip.Addr{}, err
	}
	var lan iface
	var outside netip.Addr
	found := false
	for _, i := range all {
		if i.Addr == d.target.Address && i.Prefix.IsValid() {
			lan, found = i, true
		}
		if i.NATOut && i.Addr.IsValid() && !outside.IsValid() {
			outside = i.Addr
		}
	}
	if !found {
		return iface{}, netip.Addr{}, router.Errorf(router.ErrUnsupported, op, "no interface has the router address %s as its primary address", d.target.Address)
	}
	if !lan.NATIn || !outside.IsValid() {
		return iface{}, netip.Addr{}, router.Errorf(router.ErrUnsupported, op, "NAT is not set up on this router (\"ip nat inside\" on the LAN interface and \"ip nat outside\" on an interface with a static IPv4 address); Nigafiy never turns NAT on")
	}
	return lan, outside, nil
}

func natBody(es []natEntry) map[string]any {
	list := make([]any, 0, len(es))
	for _, e := range es {
		list = append(list, map[string]any{"proto": e.Proto, "local-ip": e.LocalIP, "local-port": e.LocalPort, "global-ip": e.GlobalIP, "global-port": e.GlobalPort})
	}
	return map[string]any{"Cisco-IOS-XE-nat:nat": map[string]any{"inside": map[string]any{"source": map[string]any{"static": map[string]any{natList: list}}}}}
}

func expand(rule router.PortForward, global string) []natEntry {
	protos := []string{rule.Protocol}
	if rule.Protocol == router.ProtoBoth {
		protos = []string{router.ProtoTCP, router.ProtoUDP}
	}
	out := make([]natEntry, 0, len(protos))
	for _, p := range protos {
		out = append(out, natEntry{Proto: p, LocalIP: rule.InternalIP, LocalPort: rule.InternalStart, GlobalIP: global, GlobalPort: rule.ExternalStart})
	}
	return out
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	const op = "port_forward"
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	if rule.ExternalEnd != 0 && rule.ExternalEnd != rule.ExternalStart || rule.InternalEnd != 0 && rule.InternalEnd != rule.InternalStart {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, op, "IOS XE static NAT maps one port per rule; add one rule per port")
	}
	lan, outside, err := d.natInterfaces(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	es, err := d.natEntries(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	// Overlap is checked against the outside address used here; entries for other outside addresses do not collide.
	var same []router.PortForward
	for _, f := range forwards(es) {
		for _, e := range es {
			if e.GlobalIP == outside.String() && e.GlobalPort == f.ExternalStart && e.LocalIP == f.InternalIP {
				same = append(same, f)
				break
			}
		}
	}
	r, err := router.ValidatePortForward(rule, same, lan.Prefix, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	add := expand(r, outside.String())
	if err := d.write(ctx, op, "static NAT", http.MethodPatch, natPath, natBody(add)); err != nil {
		return router.Change{}, err
	}
	after, err := d.natEntries(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	have := map[string]bool{}
	for _, e := range after {
		have[e.key()] = true
	}
	for _, e := range add {
		if !have[e.key()] {
			return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the rule but it is missing when read back")
		}
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "port_forward", Mechanism: mechNAT, Applied: true,
		Detail: fmt.Sprintf("ip nat inside source static %s %s %d %s %d; saved with write memory", r.Protocol, r.InternalIP, r.InternalStart, outside, r.ExternalStart),
		Undo:   fmt.Sprintf("Remove the rule in Nigafiy, or on the router: no ip nat inside source static %s %s %d %s %d, then write memory", r.Protocol, r.InternalIP, r.InternalStart, outside, r.ExternalStart)}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	const op = "port_forward"
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	es, err := d.natEntries(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	var target *router.PortForward
	for _, f := range forwards(es) {
		if f.ID == rule.ID {
			f := f
			target = &f
		}
	}
	if target == nil {
		return router.Change{Action: "remove_port_forward", Mechanism: mechNAT, Detail: "the rule is no longer on the router"}, nil
	}
	if !router.SameRule(*target, rule) {
		return router.Change{}, router.Errorf(router.ErrRejected, op, "the router's rule %s changed since it was read; read the settings again", rule.ID)
	}
	var del []natEntry
	for _, e := range es {
		if e.LocalIP == target.InternalIP && e.LocalPort == target.InternalStart && e.GlobalPort == target.ExternalStart &&
			(target.Protocol == router.ProtoBoth || e.Proto == target.Protocol) {
			del = append(del, e)
		}
	}
	for _, e := range del {
		if err := d.write(ctx, op, "static NAT", http.MethodDelete, natListPa+"="+strings.ReplaceAll(e.key(), "/", "%2F"), nil); err != nil {
			return router.Change{}, err
		}
	}
	after, err := d.natEntries(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	for _, f := range forwards(after) {
		if f.ID == rule.ID {
			return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the removal but the rule is still there when read back")
		}
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechNAT, Applied: true, Detail: "removed " + rule.ID + "; saved with write memory", Undo: "Add the rule again in Nigafiy"}, nil
}
