package fortigate

// Rate limits and blocking schedules on FortiGate (Built: R2, docs/features/router-controls.md),
// through the FortiOS 6.4–7.4 CMDB REST API (/api/v2/cmdb/<path>, POST answers "mkey"; a table
// entry is moved with PUT ...?action=move&before=<id>):
//
// Rate limit — a traffic shaping policy (config firewall shaping-policy: srcaddr, dstaddr, service,
// dstintf, traffic-shaper = shaper for traffic the device sends, traffic-shaper-reverse = shaper for
// the replies it receives) with two shared shapers (config firewall shaper traffic-shaper:
// maximum-bandwidth, bandwidth-unit kbps, per-policy enable). Source: FortiOS Administration Guide
// "Traffic shaping policies" and the CLI reference for firewall shaping-policy / shaper
// traffic-shaper (6.4, 7.0, 7.2, 7.4). Only the directions asked for get a shaper.
//
// Schedule — a recurring schedule per same-day segment (config firewall schedule recurring: day
// "sunday monday ...", start/end "HH:MM"; FortiOS ends a schedule whose end is not after its start on
// the next day, and runs one whose start equals its end all day) and a deny firewall policy per
// schedule (config firewall policy: action deny, schedule <name>). Source: FortiOS Administration
// Guide "Schedules" and CLI reference firewall schedule recurring / firewall policy.
//
// Both match the device by an address object holding its current IPv4 (FortiOS quarantine, which
// the block already uses, is also IP based). Objects Nigafiy makes are named ld-lim-<mac hex> /
// ld-sch-<mac hex>-<n> and carry the comment "LAN Detective: ..."; policies are moved to the top of
// their table so the administrator's broader policies do not match first. Only objects with those
// names are ever changed or deleted. Not verified on a real FortiGate: every request below.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechLimit    = "FortiGate traffic shaping policy with shared shapers (firewall/shaping-policy, firewall.shaper/traffic-shaper)"
	mechSchedule = "FortiGate deny policies with recurring schedules (firewall/policy, firewall.schedule/recurring)"

	pathAddress  = "/api/v2/cmdb/firewall/address"
	pathShaper   = "/api/v2/cmdb/firewall.shaper/traffic-shaper"
	pathShapePol = "/api/v2/cmdb/firewall/shaping-policy"
	pathSchedule = "/api/v2/cmdb/firewall.schedule/recurring"
	pathPolicy   = "/api/v2/cmdb/firewall/policy"
)

var (
	_ router.RateLimiter = (*Driver)(nil)
	_ router.Scheduler   = (*Driver)(nil)
)

func hexMAC(mac string) string { return strings.ReplaceAll(mac, ":", "") }

func limName(mac string) string    { return "ld-lim-" + hexMAC(mac) }
func schName(mac string) string    { return "ld-sch-" + hexMAC(mac) }
func limComment(mac string) string { return router.ProductRulePrefix + "limit " + mac }
func schComment(mac string) string { return router.ProductRulePrefix + "schedule " + mac }

func fgError(raw []byte, st int) string {
	var e struct {
		Error any    `json:"error"`
		CLI   string `json:"cli_error"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error != nil {
		s := fmt.Sprintf("HTTP %d, FortiOS error %v", st, e.Error)
		if e.CLI != "" {
			s += " " + strings.TrimSpace(e.CLI)
		}
		return s
	}
	return fmt.Sprintf("HTTP %d", st)
}

func (d *Driver) cmdbList(ctx context.Context, op, path string) ([]map[string]any, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound {
		return nil, nil
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "reading %s: %s", path, fgError(raw, st))
	}
	var rep struct {
		Results []map[string]any `json:"results"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable %s JSON", path)
	}
	return rep.Results, nil
}

// cmdbWrite sends one change and returns the new entry's mkey (POST) when FortiOS reports it.
func (d *Driver) cmdbWrite(ctx context.Context, op, method, path string, body any) (string, error) {
	st, raw, err := d.do(ctx, op, method, path, body)
	if err != nil {
		return "", err
	}
	if st != http.StatusOK {
		return "", router.Errorf(router.ErrRejected, op, "FortiOS refused %s %s (%s)", method, strings.TrimPrefix(path, "/api/v2/cmdb/"), fgError(raw, st))
	}
	var rep struct {
		Mkey any `json:"mkey"`
	}
	_ = json.Unmarshal(raw, &rep)
	if rep.Mkey == nil {
		return "", nil
	}
	return str(rep.Mkey), nil
}

func (d *Driver) cmdbDelete(ctx context.Context, op, path, key string) error {
	st, raw, err := d.do(ctx, op, http.MethodDelete, path+"/"+url.PathEscape(key), nil)
	if err != nil {
		return err
	}
	if st != http.StatusOK && st != http.StatusNotFound {
		return router.Errorf(router.ErrRejected, op, "FortiOS refused to delete %s %s (%s)", strings.TrimPrefix(path, "/api/v2/cmdb/"), key, fgError(raw, st))
	}
	return nil
}

// moveFirst moves policy id to the top of its table (before the first other entry).
func (d *Driver) moveFirst(ctx context.Context, op, path, id string, idField string) error {
	rows, err := d.cmdbList(ctx, op, path)
	if err != nil {
		return err
	}
	if len(rows) == 0 || str(rows[0][idField]) == id {
		return nil
	}
	_, err = d.cmdbWrite(ctx, op, http.MethodPut, path+"/"+url.PathEscape(id)+"?action=move&before="+url.QueryEscape(str(rows[0][idField])), nil)
	return err
}

func named(rows []map[string]any, field, value string) map[string]any {
	for _, r := range rows {
		if str(r[field]) == value {
			return r
		}
	}
	return nil
}

func (d *Driver) deviceIP(ctx context.Context, op, mac string) (string, error) {
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return "", err
	}
	for _, c := range clients {
		if c.MAC == mac && c.IP != "" {
			return c.IP, nil
		}
	}
	return "", router.Errorf(router.ErrNotFound, op, "FortiGate has no IPv4 address for %s", mac)
}

// ensureAddress creates or updates the address object name → ip/32.
func (d *Driver) ensureAddress(ctx context.Context, op, name, ip, comment string) error {
	addrs, err := d.cmdbList(ctx, op, pathAddress)
	if err != nil {
		return err
	}
	body := map[string]any{"name": name, "type": "ipmask", "subnet": ip + " 255.255.255.255", "comment": comment}
	if a := named(addrs, "name", name); a != nil {
		if strings.HasPrefix(str(a["subnet"]), ip+" ") {
			return nil
		}
		_, err = d.cmdbWrite(ctx, op, http.MethodPut, pathAddress+"/"+url.PathEscape(name), body)
		return err
	}
	_, err = d.cmdbWrite(ctx, op, http.MethodPost, pathAddress, body)
	return err
}

func refName(n string) []map[string]string { return []map[string]string{{"name": n}} }

// ---------- rate limit ----------

// SetRateLimit shapes the device's traffic through its own shaping policy and shapers.
func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if err := router.ValidateRateLimit(limit); err != nil {
		return router.Change{}, err
	}
	ip, err := d.deviceIP(ctx, "rate_limit", mac)
	if err != nil {
		return router.Change{}, err
	}
	base := limName(mac)
	if err := d.ensureAddress(ctx, "rate_limit", base, ip, limComment(mac)); err != nil {
		return router.Change{}, err
	}
	shapers, err := d.cmdbList(ctx, "rate_limit", pathShaper)
	if err != nil {
		return router.Change{}, err
	}
	shaper := func(name string, kbps int) error {
		body := map[string]any{"name": name, "maximum-bandwidth": kbps, "guaranteed-bandwidth": 0, "bandwidth-unit": "kbps", "per-policy": "enable"}
		if named(shapers, "name", name) != nil {
			_, err := d.cmdbWrite(ctx, "rate_limit", http.MethodPut, pathShaper+"/"+url.PathEscape(name), body)
			return err
		}
		_, err := d.cmdbWrite(ctx, "rate_limit", http.MethodPost, pathShaper, body)
		return err
	}
	pol := map[string]any{
		"name": base, "comment": limComment(mac), "status": "enable",
		"srcaddr": refName(base), "dstaddr": refName("all"), "service": refName("ALL"), "dstintf": refName("any"),
		"traffic-shaper": "", "traffic-shaper-reverse": "",
	}
	if limit.UpKbps > 0 {
		if err := shaper(base+"-up", limit.UpKbps); err != nil {
			return router.Change{}, err
		}
		pol["traffic-shaper"] = base + "-up"
	}
	if limit.DownKbps > 0 {
		if err := shaper(base+"-dn", limit.DownKbps); err != nil {
			return router.Change{}, err
		}
		pol["traffic-shaper-reverse"] = base + "-dn"
	}
	pols, err := d.cmdbList(ctx, "rate_limit", pathShapePol)
	if err != nil {
		return router.Change{}, err
	}
	var id string
	if p := named(pols, "name", base); p != nil {
		id = str(p["id"])
		if _, err := d.cmdbWrite(ctx, "rate_limit", http.MethodPut, pathShapePol+"/"+url.PathEscape(id), pol); err != nil {
			return router.Change{}, err
		}
	} else {
		if id, err = d.cmdbWrite(ctx, "rate_limit", http.MethodPost, pathShapePol, pol); err != nil {
			return router.Change{}, err
		}
		if id == "" {
			return router.Change{}, router.Errorf(router.ErrProtocol, "rate_limit", "FortiOS did not report the new shaping policy id")
		}
	}
	if err := d.moveFirst(ctx, "rate_limit", pathShapePol, id, "id"); err != nil {
		return router.Change{}, err
	}
	// A direction that is no longer limited loses its shaper (now unreferenced).
	for dir, kbps := range map[string]int{"-up": limit.UpKbps, "-dn": limit.DownKbps} {
		if kbps == 0 && named(shapers, "name", base+dir) != nil {
			if err := d.cmdbDelete(ctx, "rate_limit", pathShaper, base+dir); err != nil {
				return router.Change{}, err
			}
		}
	}
	if err := d.verifyLimit(ctx, base, limit); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("FortiGate shaping policy %q (first in the list) shapes %s: %s", base, ip, router.DescribeLimit(limit)),
		Undo:      fmt.Sprintf("Remove the limit in Nigafiy, or delete the shaping policy %q, the shapers %s-up / %s-dn and the address %q on the FortiGate", base, base, base, base),
	}, nil
}

func (d *Driver) verifyLimit(ctx context.Context, base string, limit router.RateLimit) error {
	pols, err := d.cmdbList(ctx, "rate_limit", pathShapePol)
	if err != nil {
		return err
	}
	shapers, err := d.cmdbList(ctx, "rate_limit", pathShaper)
	if err != nil {
		return err
	}
	p := named(pols, "name", base)
	bad := p == nil || str(p["status"]) == "disable"
	check := func(field, name string, kbps int) {
		if bad {
			return
		}
		if kbps == 0 {
			bad = str(p[field]) != ""
			return
		}
		s := named(shapers, "name", name)
		bad = str(p[field]) != name || s == nil || str(s["maximum-bandwidth"]) != strconv.Itoa(kbps)
	}
	check("traffic-shaper", base+"-up", limit.UpKbps)
	check("traffic-shaper-reverse", base+"-dn", limit.DownKbps)
	if bad {
		return router.Errorf(router.ErrRejected, "rate_limit", "FortiOS accepted the change but the shaping policy %q does not show the new limits", base)
	}
	return nil
}

// ClearRateLimit deletes the device's shaping policy, shapers and address object.
func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	base := limName(mac)
	pols, err := d.cmdbList(ctx, "clear_rate_limit", pathShapePol)
	if err != nil {
		return router.Change{}, err
	}
	shapers, err := d.cmdbList(ctx, "clear_rate_limit", pathShaper)
	if err != nil {
		return router.Change{}, err
	}
	addrs, err := d.cmdbList(ctx, "clear_rate_limit", pathAddress)
	if err != nil {
		return router.Change{}, err
	}
	p := named(pols, "name", base)
	removed := 0
	if p != nil {
		if err := d.cmdbDelete(ctx, "clear_rate_limit", pathShapePol, str(p["id"])); err != nil {
			return router.Change{}, err
		}
		removed++
	}
	for _, s := range []string{base + "-up", base + "-dn"} {
		if named(shapers, "name", s) != nil {
			if err := d.cmdbDelete(ctx, "clear_rate_limit", pathShaper, s); err != nil {
				return router.Change{}, err
			}
			removed++
		}
	}
	if named(addrs, "name", base) != nil {
		if err := d.cmdbDelete(ctx, "clear_rate_limit", pathAddress, base); err != nil {
			return router.Change{}, err
		}
		removed++
	}
	if removed == 0 {
		return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy shaping policy for this device on the FortiGate"}, nil
	}
	if pols, err = d.cmdbList(ctx, "clear_rate_limit", pathShapePol); err != nil {
		return router.Change{}, err
	}
	if named(pols, "name", base) != nil {
		return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "the FortiGate still lists the shaping policy %q", base)
	}
	return router.Change{
		Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: true,
		Detail: fmt.Sprintf("deleted %d Nigafiy object(s) named %s* on the FortiGate", removed, base),
		Undo:   "Set the limit again in Nigafiy",
	}, nil
}

// ---------- schedule ----------

var fgDay = [7]string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}

func fgDays(ds []time.Weekday) string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = fgDay[d]
	}
	return strings.Join(out, " ")
}

func isOwnSchedule(name, mac string) bool { return strings.HasPrefix(name, schName(mac)+"-") }

// SetSchedule replaces the device's deny policies. New policies are added first (with new
// schedule names); if FortiOS refuses one, what was just added is removed again and the previous
// schedule stays. An empty schedule clears it.
func (d *Driver) SetSchedule(ctx context.Context, rawMAC string, windows []router.Window) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if len(windows) == 0 {
		return d.ClearSchedule(ctx, mac)
	}
	segs, err := router.SplitWindows(windows)
	if err != nil {
		return router.Change{}, err
	}
	ip, err := d.deviceIP(ctx, "schedule", mac)
	if err != nil {
		return router.Change{}, err
	}
	addr := schName(mac)
	if err := d.ensureAddress(ctx, "schedule", addr, ip, schComment(mac)); err != nil {
		return router.Change{}, err
	}
	scheds, err := d.cmdbList(ctx, "schedule", pathSchedule)
	if err != nil {
		return router.Change{}, err
	}
	pols, err := d.cmdbList(ctx, "schedule", pathPolicy)
	if err != nil {
		return router.Change{}, err
	}
	// Pick a generation suffix not in use, so the new objects never collide with the old ones.
	used := map[string]bool{}
	for _, s := range scheds {
		used[str(s["name"])] = true
	}
	gen := 1
	for used[fmt.Sprintf("%s-%d-1", addr, gen)] {
		gen++
	}
	var newPols, newScheds []string
	rollback := func() {
		for _, id := range newPols {
			_ = d.cmdbDelete(ctx, "schedule", pathPolicy, id)
		}
		for _, n := range newScheds {
			_ = d.cmdbDelete(ctx, "schedule", pathSchedule, n)
		}
	}
	for i, s := range segs {
		name := fmt.Sprintf("%s-%d-%d", addr, gen, i+1)
		end := s.End
		if end == router.EndOfDay {
			end = "00:00" // FortiOS: an end not after the start ends on the next day; equal = all day
		}
		if _, err := d.cmdbWrite(ctx, "schedule", http.MethodPost, pathSchedule, map[string]any{"name": name, "day": fgDays(s.Days), "start": s.Start, "end": end}); err != nil {
			rollback()
			return router.Change{}, err
		}
		newScheds = append(newScheds, name)
		id, err := d.cmdbWrite(ctx, "schedule", http.MethodPost, pathPolicy, map[string]any{
			"name": name, "comments": schComment(mac), "status": "enable", "action": "deny", "schedule": name, "logtraffic": "all",
			"srcintf": refName("any"), "dstintf": refName("any"), "srcaddr": refName(addr), "dstaddr": refName("all"), "service": refName("ALL"),
		})
		if err != nil {
			rollback()
			return router.Change{}, err
		}
		if id == "" {
			rollback()
			return router.Change{}, router.Errorf(router.ErrProtocol, "schedule", "FortiOS did not report the new policy id; nothing was changed")
		}
		newPols = append(newPols, id)
		if err := d.moveFirst(ctx, "schedule", pathPolicy, id, "policyid"); err != nil {
			rollback()
			return router.Change{}, err
		}
	}
	// Remove the previous generation: policies first (they reference the schedules).
	old := 0
	for _, p := range pols {
		if isOwnSchedule(str(p["name"]), mac) {
			if err := d.cmdbDelete(ctx, "schedule", pathPolicy, str(p["policyid"])); err != nil {
				return router.Change{}, err
			}
			old++
		}
	}
	for _, s := range scheds {
		if isOwnSchedule(str(s["name"]), mac) {
			if err := d.cmdbDelete(ctx, "schedule", pathSchedule, str(s["name"])); err != nil {
				return router.Change{}, err
			}
		}
	}
	// Re-read.
	pols, err = d.cmdbList(ctx, "schedule", pathPolicy)
	if err != nil {
		return router.Change{}, err
	}
	n := 0
	for _, p := range pols {
		if isOwnSchedule(str(p["name"]), mac) && str(p["action"]) == "deny" && str(p["status"]) != "disable" {
			n++
		}
	}
	if n != len(segs) {
		return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "the FortiGate shows %d Nigafiy deny policies for the device after the change, expected %d", n, len(segs))
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("FortiGate denies %s %s (%d policy/schedule pair(s) at the top of the policy list, %d previous replaced)", ip, router.DescribeWindows(windows), n, old),
		Undo:      fmt.Sprintf("Remove the schedule in Nigafiy, or delete the firewall policies and recurring schedules named %s-* and the address %q on the FortiGate", addr, addr),
	}, nil
}

// ClearSchedule deletes the device's deny policies, schedules and address object.
func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	pols, err := d.cmdbList(ctx, "clear_schedule", pathPolicy)
	if err != nil {
		return router.Change{}, err
	}
	scheds, err := d.cmdbList(ctx, "clear_schedule", pathSchedule)
	if err != nil {
		return router.Change{}, err
	}
	addrs, err := d.cmdbList(ctx, "clear_schedule", pathAddress)
	if err != nil {
		return router.Change{}, err
	}
	removed := 0
	for _, p := range pols {
		if isOwnSchedule(str(p["name"]), mac) {
			if err := d.cmdbDelete(ctx, "clear_schedule", pathPolicy, str(p["policyid"])); err != nil {
				return router.Change{}, err
			}
			removed++
		}
	}
	for _, s := range scheds {
		if isOwnSchedule(str(s["name"]), mac) {
			if err := d.cmdbDelete(ctx, "clear_schedule", pathSchedule, str(s["name"])); err != nil {
				return router.Change{}, err
			}
		}
	}
	if named(addrs, "name", schName(mac)) != nil {
		if err := d.cmdbDelete(ctx, "clear_schedule", pathAddress, schName(mac)); err != nil {
			return router.Change{}, err
		}
	}
	if removed == 0 {
		return router.Change{Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy deny policy for this device on the FortiGate"}, nil
	}
	if pols, err = d.cmdbList(ctx, "clear_schedule", pathPolicy); err != nil {
		return router.Change{}, err
	}
	for _, p := range pols {
		if isOwnSchedule(str(p["name"]), mac) {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "the FortiGate still lists the policy %q", str(p["name"]))
		}
	}
	return router.Change{
		Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: true,
		Detail: fmt.Sprintf("deleted %d Nigafiy deny policy(ies) and their schedules on the FortiGate", removed),
		Undo:   "Set the schedule again in Nigafiy",
	}, nil
}
