package pfsense

// Blocking schedules on pfSense (Built: R2, docs/features/router-controls.md), through the REST API
// v2 package the driver already uses (pfSense-pkg-RESTAPI 2.x):
//
//   - a firewall schedule: GET /api/v2/firewall/schedules, POST / DELETE /api/v2/firewall/schedule
//     (Models/FirewallSchedule.inc: name, descr, timerange; Models/FirewallScheduleTimeRange.inc:
//     position = weekdays 1 Monday … 7 Sunday, hour "HH:MM-HH:MM" with minutes 00/15/30/45/59 and the
//     start not after the end);
//   - a floating, quick block rule on the LAN interface (direction in) for the device's IPv4 with
//     `sched` naming that schedule: GET /api/v2/firewall/rules, POST / DELETE /api/v2/firewall/rule
//     (Models/FirewallRule.inc), then POST /api/v2/firewall/apply. pfSense evaluates floating quick
//     rules before the interface rules (pfSense documentation, "Floating Rules"), and a block rule
//     with a schedule only matches inside it ("Time Based Rules"), so the administrator's own rule
//     order is never touched.
//
// Rate limits are not offered: pfSense applies limiters only through `dnpipe`/`pdnpipe` on a pass
// rule or a floating "match" rule. The REST API's rule type is pass/block/reject only and has no
// placement, so a Nigafiy pass rule would sit below the administrator's LAN rules (never matching)
// or, as a floating quick pass rule, would let the device past the administrator's own LAN block
// rules. Neither is acceptable, so the capability stays off with that reason.
//
// Ids in the REST API v2 are list positions and shift after a delete, so every delete re-reads the
// list first. Objects Nigafiy makes: schedule LD_<mac hex>_<n> with descr "LAN Detective: schedule
// <mac>" and a rule with that descr; nothing else is changed or deleted.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechSchedule = "pfSense floating block rule with a firewall schedule (REST API v2 /firewall/rule sched, /firewall/schedule)"
	scheduleNote = "Adds a pfSense firewall schedule and a floating quick block rule on LAN for the device's current IPv4 (evaluated before the interface rules); pfSense schedules accept only times on the quarter hour, and a window ending at midnight ends at 23:59. Give the device a DHCP reservation so the schedule keeps following it"
	rateNote     = "Not offered: pfSense applies limiters only on pass or floating match rules; the REST API v2 cannot create match rules or place a rule above the administrator's LAN rules, and a floating pass rule would bypass the administrator's own block rules. Set limiters under Firewall → Traffic Shaper → Limiters"
)

var _ router.Scheduler = (*Driver)(nil)

func schedPrefix(mac string) string { return "LD_" + strings.ReplaceAll(mac, ":", "") + "_" }
func schedDescr(mac string) string  { return router.ProductRulePrefix + "schedule " + mac }

type pfSched struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Descr string `json:"descr"`
}

type pfRule struct {
	ID       int    `json:"id"`
	Type     string `json:"type"`
	Descr    string `json:"descr"`
	Sched    string `json:"sched"`
	Source   string `json:"source"`
	Floating bool   `json:"floating"`
	Quick    bool   `json:"quick"`
	Disabled bool   `json:"disabled"`
}

func (d *Driver) schedules(ctx context.Context, op string) ([]pfSched, error) {
	_, data, err := d.do(ctx, op, http.MethodGet, "/api/v2/firewall/schedules", nil)
	if err != nil {
		return nil, err
	}
	var out []pfSched
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable pfSense schedule list")
	}
	return out, nil
}

func (d *Driver) rules(ctx context.Context, op string) ([]pfRule, error) {
	_, data, err := d.do(ctx, op, http.MethodGet, "/api/v2/firewall/rules", nil)
	if err != nil {
		return nil, err
	}
	var out []pfRule
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable pfSense rule list")
	}
	return out, nil
}

func ownRule(r pfRule, mac string) bool {
	return r.Descr == schedDescr(mac) && strings.HasPrefix(r.Sched, schedPrefix(mac))
}

// deleteOwn removes, one at a time (ids shift), every Nigafiy rule and schedule of the device for
// which keep returns false. Rules go first: a schedule in use cannot be deleted.
func (d *Driver) deleteOwn(ctx context.Context, op, mac string, keep func(sched string) bool) (int, error) {
	removed := 0
	for i := 0; i < 64; i++ {
		rules, err := d.rules(ctx, op)
		if err != nil {
			return removed, err
		}
		id := -1
		for _, r := range rules {
			if ownRule(r, mac) && !keep(r.Sched) {
				id = r.ID
				break
			}
		}
		if id < 0 {
			break
		}
		if _, _, err := d.do(ctx, op, http.MethodDelete, "/api/v2/firewall/rule?id="+strconv.Itoa(id), nil); err != nil {
			return removed, err
		}
		removed++
	}
	for i := 0; i < 64; i++ {
		scheds, err := d.schedules(ctx, op)
		if err != nil {
			return removed, err
		}
		id := -1
		for _, s := range scheds {
			if strings.HasPrefix(s.Name, schedPrefix(mac)) && s.Descr == schedDescr(mac) && !keep(s.Name) {
				id = s.ID
				break
			}
		}
		if id < 0 {
			break
		}
		if _, _, err := d.do(ctx, op, http.MethodDelete, "/api/v2/firewall/schedule?id="+url.QueryEscape(strconv.Itoa(id)), nil); err != nil {
			return removed, err
		}
	}
	return removed, nil
}

func quarter(hhmm string, end bool) bool {
	m := hhmm[3:]
	return m == "00" || m == "15" || m == "30" || m == "45" || (end && m == "59")
}

// SetSchedule replaces the device's schedule. The new schedule and rule are created first; if
// pfSense refuses either, what was just created is removed and the previous schedule stays.
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
	ranges := make([]map[string]any, 0, len(segs))
	for _, s := range segs {
		end := s.End
		if end == router.EndOfDay {
			end = "23:59"
		}
		if !quarter(s.Start, false) || !quarter(end, true) {
			return router.Change{}, router.Errorf(router.ErrInvalidArgument, "schedule", "pfSense schedules accept only times on the quarter hour (:00, :15, :30, :45); %s-%s is not", s.Start, s.End)
		}
		pos := make([]int, len(s.Days))
		for i, d := range s.Days {
			pos[i] = (int(d)+6)%7 + 1 // time.Weekday Sunday=0 → pfSense 1 Monday … 7 Sunday
		}
		ranges = append(ranges, map[string]any{"position": pos, "hour": s.Start + "-" + end, "rangedescr": "Nigafiy"})
	}
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return router.Change{}, err
	}
	var ip string
	for _, c := range clients {
		if c.MAC == mac && c.IP != "" {
			ip = c.IP
			break
		}
	}
	if ip == "" {
		return router.Change{}, router.Errorf(router.ErrNotFound, "schedule", "pfSense has no IPv4 address for %s in ARP/DHCP", mac)
	}
	scheds, err := d.schedules(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	used := map[string]bool{}
	for _, s := range scheds {
		used[s.Name] = true
	}
	gen := 1
	for used[schedPrefix(mac)+strconv.Itoa(gen)] {
		gen++
	}
	name := schedPrefix(mac) + strconv.Itoa(gen)
	isNew := func(s string) bool { return s == name }
	if _, _, err := d.do(ctx, "schedule", http.MethodPost, "/api/v2/firewall/schedule", map[string]any{"name": name, "descr": schedDescr(mac), "timerange": ranges}); err != nil {
		return router.Change{}, err
	}
	if _, _, err := d.do(ctx, "schedule", http.MethodPost, "/api/v2/firewall/rule", map[string]any{
		"type": "block", "interface": []string{"lan"}, "ipprotocol": "inet", "protocol": nil,
		"source": ip, "destination": "any", "descr": schedDescr(mac), "sched": name,
		"floating": true, "quick": true, "direction": "in", "disabled": false,
	}); err != nil {
		_, _ = d.deleteOwn(ctx, "schedule", mac, func(s string) bool { return !isNew(s) })
		return router.Change{}, err
	}
	old, err := d.deleteOwn(ctx, "schedule", mac, isNew)
	if err != nil {
		return router.Change{}, err
	}
	if _, _, err := d.do(ctx, "schedule", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	rules, err := d.rules(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	n := 0
	for _, r := range rules {
		if ownRule(r, mac) {
			if r.Sched != name || r.Type != "block" || !r.Floating || !r.Quick || r.Disabled {
				return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "pfSense shows the Nigafiy rule for the device differently after the change (type %s, schedule %s)", r.Type, r.Sched)
			}
			n++
		}
	}
	if n != 1 {
		return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "pfSense shows %d Nigafiy schedule rules for the device after the change, expected 1", n)
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("pfSense blocks %s %s (schedule %s, %d range(s); %d previous rule(s) replaced)", ip, router.DescribeWindows(windows), name, len(ranges), old),
		Undo:      fmt.Sprintf("Remove the schedule in Nigafiy, or delete the floating rule %q and the schedule %s on pfSense", schedDescr(mac), name),
	}, nil
}

// ClearSchedule deletes the device's Nigafiy rule and schedule.
func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	removed, err := d.deleteOwn(ctx, "clear_schedule", mac, func(string) bool { return false })
	if err != nil {
		return router.Change{}, err
	}
	if removed == 0 {
		return router.Change{Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy schedule rule for this device on pfSense"}, nil
	}
	if _, _, err := d.do(ctx, "clear_schedule", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	rules, err := d.rules(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range rules {
		if ownRule(r, mac) {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "pfSense still lists a Nigafiy schedule rule for the device")
		}
	}
	return router.Change{
		Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: true,
		Detail: fmt.Sprintf("deleted %d Nigafiy rule(s) and their schedule on pfSense", removed),
		Undo:   "Set the schedule again in Nigafiy",
	}, nil
}
