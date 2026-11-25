package ciscoxe

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/nigafiy/sensor/internal/router"
)

// Rate limits: Modular QoS CLI through RESTCONF (Cisco-IOS-XE-policy). Per device, for each limited
// direction:
//
//	ip access-list extended NIGAFIY-RL-<MAC>-UP   permit ip host <address> any      (upload)
//	ip access-list extended NIGAFIY-RL-<MAC>-DN   permit ip any host <address>      (download)
//	class-map match-all NIGAFIY-RL-<MAC>-UP|DN    match access-group name <that ACL>
//	policy-map NIGAFIY-RL-IN  class …-UP  police <bit/s>   (service-policy input on the LAN interface)
//	policy-map NIGAFIY-RL-OUT class …-DN  police <bit/s>   (service-policy output on the LAN interface)
//
// Upload is policed as it enters the router from the LAN, download as it leaves the router towards
// the LAN. A LAN interface that already has the administrator's service policy in that direction is
// refused. Platforms that cannot police on that interface (or in that direction) refuse the
// service-policy; Nigafiy reports the refusal and the change is not kept.

const (
	policyIn  = productPrefix + "RL-IN"
	policyOut = productPrefix + "RL-OUT"
	mechRate  = "IOS XE policy-maps " + policyIn + " / " + policyOut + " (police per device ACL class) on the LAN interface, RESTCONF"
)

func rlName(mac, dir string) string { return productPrefix + "RL-" + macKey(mac) + "-" + dir }

func policyPath(p string) string { return nativePath + "/policy/Cisco-IOS-XE-policy:policy-map=" + p }

func classMapPath(c string) string { return nativePath + "/policy/Cisco-IOS-XE-policy:class-map=" + c }

func extACLPath(n string) string {
	return nativePath + "/ip/access-list/Cisco-IOS-XE-acl:extended=" + n
}

// policeRates reads the classes of a Nigafiy policy-map and their police rate (bit/s).
func (d *Driver) policeRates(ctx context.Context, op, policy string) (map[string]int64, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, policyPath(policy), nil)
	if err != nil {
		return nil, err
	}
	out := map[string]int64{}
	if st == http.StatusNotFound || st == http.StatusNoContent {
		return out, nil
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "reading %s returned HTTP %d", policy, st)
	}
	var rep struct {
		PM []struct {
			Class []struct {
				Name    string `json:"name"`
				Actions []struct {
					Type   string `json:"action-type"`
					Target struct {
						Police struct {
							BitRate any `json:"bit-rate"`
						} `json:"police"`
					} `json:"police-target-bitrate"`
				} `json:"action-list"`
			} `json:"class"`
		} `json:"Cisco-IOS-XE-policy:policy-map"`
	}
	if json.Unmarshal(raw, &rep) != nil || len(rep.PM) == 0 {
		return nil, router.Errorf(router.ErrProtocol, op, "%s is not an IOS XE policy-map payload", policy)
	}
	for _, c := range rep.PM[0].Class {
		for _, a := range c.Actions {
			if a.Type == "police" {
				n, _ := strconv.ParseInt(jsonScalar(a.Target.Police.BitRate), 10, 64)
				out[c.Name] = n
			}
		}
	}
	return out, nil
}

// removeClass deletes one device direction (policy class, class-map, ACL); missing parts are fine.
func (d *Driver) removeClass(ctx context.Context, op, policy, class string) (bool, error) {
	removed := false
	for _, p := range []string{policyPath(policy) + "/class=" + class, classMapPath(class), extACLPath(class)} {
		st, raw, err := d.do(ctx, op, http.MethodDelete, p, nil)
		if err != nil {
			return removed, err
		}
		switch {
		case st >= 200 && st < 300:
			removed = true
		case st == http.StatusNotFound:
		default:
			_, msg := restconfError(raw)
			return removed, router.Errorf(router.ErrRejected, op, "the router refused to remove %s (%s)", class, first(msg, "HTTP "+strconv.Itoa(st)))
		}
	}
	return removed, nil
}

func (d *Driver) addClass(ctx context.Context, op, policy, class, ip string, up bool, kbps int) error {
	ace := map[string]any{"action": "permit", "protocol": "ip", "host": ip, "dst-any": []any{nil}}
	if !up {
		ace = map[string]any{"action": "permit", "protocol": "ip", "any": []any{nil}, "dst-host": ip}
	}
	acl := map[string]any{"Cisco-IOS-XE-acl:extended": []any{map[string]any{"name": class, "access-list-seq-rule": []any{map[string]any{"sequence": "10", "ace-rule": ace}}}}}
	if err := d.write(ctx, op, "extended access lists", http.MethodPut, extACLPath(class), acl); err != nil {
		return err
	}
	cm := map[string]any{"Cisco-IOS-XE-policy:class-map": []any{map[string]any{"name": class, "prematch": "match-all", "match": map[string]any{"access-group": map[string]any{"name": []string{class}}}}}}
	if err := d.write(ctx, op, "QoS class-maps", http.MethodPut, classMapPath(class), cm); err != nil {
		return err
	}
	pm := map[string]any{"Cisco-IOS-XE-policy:policy-map": []any{map[string]any{"name": policy, "class": []any{map[string]any{
		"name":        class,
		"action-list": []any{map[string]any{"action-type": "police", "police-target-bitrate": map[string]any{"police": map[string]any{"bit-rate": int64(kbps) * 1000}}}},
	}}}}}
	return d.write(ctx, op, "QoS policy-maps (police)", http.MethodPatch, policyPath(policy), pm)
}

func (d *Driver) attachPolicy(ctx context.Context, op string, lan iface, input bool) error {
	sp := map[string]any{}
	switch {
	case input && lan.PolicyI != policyIn:
		sp["input"] = policyIn
	case !input && lan.PolicyO != policyOut:
		sp["output"] = policyOut
	default:
		return nil
	}
	body := map[string]any{"Cisco-IOS-XE-native:" + lan.Type: []any{map[string]any{"name": lan.Name, "Cisco-IOS-XE-policy:service-policy": sp}}}
	return d.write(ctx, op, "interface service policies", http.MethodPatch, lan.path(), body)
}

func (d *Driver) SetRateLimit(ctx context.Context, mac string, limit router.RateLimit) (router.Change, error) {
	const op = "rate_limit"
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	if err := router.ValidateRateLimit(limit); err != nil {
		return router.Change{}, err
	}
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	lan, err := d.lan(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	ip, err := d.clientIP(ctx, op, m)
	if err != nil {
		return router.Change{}, err
	}
	if limit.UpKbps > 0 && lan.PolicyI != "" && lan.PolicyI != policyIn {
		return router.Change{}, router.Errorf(router.ErrRejected, op, "the LAN interface %s already has the administrator's input service policy %q; Nigafiy never replaces it", lan.label(), lan.PolicyI)
	}
	if limit.DownKbps > 0 && lan.PolicyO != "" && lan.PolicyO != policyOut {
		return router.Change{}, router.Errorf(router.ErrRejected, op, "the LAN interface %s already has the administrator's output service policy %q; Nigafiy never replaces it", lan.label(), lan.PolicyO)
	}
	for _, dir := range []struct {
		policy, class string
		up            bool
		kbps          int
	}{{policyIn, rlName(m, "UP"), true, limit.UpKbps}, {policyOut, rlName(m, "DN"), false, limit.DownKbps}} {
		if dir.kbps == 0 {
			if _, err := d.removeClass(ctx, op, dir.policy, dir.class); err != nil {
				return router.Change{}, err
			}
			continue
		}
		if err := d.addClass(ctx, op, dir.policy, dir.class, ip.String(), dir.up, dir.kbps); err != nil {
			return router.Change{}, err
		}
		if err := d.attachPolicy(ctx, op, lan, dir.up); err != nil {
			// Not attached: take this device's parts out again so nothing half-made stays behind.
			_, _ = d.removeClass(ctx, op, dir.policy, dir.class)
			return router.Change{}, err
		}
		rates, err := d.policeRates(ctx, op, dir.policy)
		if err != nil {
			return router.Change{}, err
		}
		if rates[dir.class] != int64(dir.kbps)*1000 {
			return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the limit but %s does not show it when read back", dir.policy)
		}
	}
	if l2, err := d.lan(ctx, op); err != nil || (limit.UpKbps > 0 && l2.PolicyI != policyIn) || (limit.DownKbps > 0 && l2.PolicyO != policyOut) {
		return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the limit but the LAN interface does not carry the Nigafiy service policy when read back")
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "rate_limit", MAC: m, Mechanism: mechRate, Applied: true,
		Detail: fmt.Sprintf("%s for %s (police on the LAN interface); saved with write memory", router.DescribeLimit(limit), ip),
		Undo:   "Remove the limit in Nigafiy, or on the router delete the classes " + rlName(m, "UP") + " / " + rlName(m, "DN") + " from " + policyIn + " / " + policyOut + ", their class-maps and ACLs, then write memory"}, nil
}

func (d *Driver) ClearRateLimit(ctx context.Context, mac string) (router.Change, error) {
	const op = "rate_limit"
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	up, err := d.removeClass(ctx, op, policyIn, rlName(m, "UP"))
	if err != nil {
		return router.Change{}, err
	}
	down, err := d.removeClass(ctx, op, policyOut, rlName(m, "DN"))
	if err != nil {
		return router.Change{}, err
	}
	applied := up || down
	if applied {
		if err := d.save(ctx, op); err != nil {
			return router.Change{}, err
		}
	}
	return router.Change{Action: "clear_rate_limit", MAC: m, Mechanism: mechRate, Applied: applied,
		Detail: "removed this device's police classes, class-maps and ACLs", Undo: "Set the limit again in Nigafiy"}, nil
}
