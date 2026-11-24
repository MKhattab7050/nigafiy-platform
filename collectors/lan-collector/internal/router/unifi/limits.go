package unifi

// Rate limits and blocking schedules on UniFi Network (Built: R2, docs/features/router-controls.md).
//
// Rate limit — user groups. UniFi limits a client's speed through the user group it belongs to
// (Settings → Profiles → Bandwidth / "User Groups"): GET/POST/PUT/DELETE {api}/rest/usergroup with
// `name`, `qos_rate_max_down`, `qos_rate_max_up` in kbit/s (-1 = unlimited), and the client's
// `usergroup_id` on PUT {api}/rest/user/<id>. Source: Art-of-WiFi UniFi-API-client
// (create_usergroup, edit_usergroup, set_usergroup, delete_usergroup), UniFi Network 5.x–8.x.
// Nigafiy makes one group per device, named "LAN Detective: limit <mac>", so it is recognisable and
// removable. A client that sits in a group the administrator made is never moved: the change is
// refused and says so. Clearing moves the client back to the site's Default group and deletes the
// Nigafiy group.
//
// Schedule — traffic rules (UniFi Network 7.x and newer, v2 API): GET/POST/DELETE
// {v2}/trafficrules[/<id>] where {v2} is /proxy/network/v2/api/site/<site> on UniFi OS and
// /v2/api/site/<site> on a self-hosted controller. A rule has action BLOCK, matching_target
// INTERNET, target_devices [{client_mac, type: CLIENT}] and a schedule {mode, repeat_on_days,
// time_all_day, time_range_start, time_range_end}. Source: aiounifi models/traffic_rule.py (the
// library behind Home Assistant's UniFi integration). One rule per same-day segment (a window that
// crosses midnight is split, router.SplitWindows); the rule description is
// "LAN Detective: schedule <mac>". Rules the administrator made are listed nowhere as ours and never
// touched. Not verified on a real controller: whether "EVERY_WEEK" with repeat_on_days is the mode
// the UI writes for a weekly schedule, and whether time_range_end "23:59" includes that minute.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechLimit    = "UniFi user group bandwidth limit (/rest/usergroup, client usergroup_id)"
	mechSchedule = "UniFi traffic rules with a weekly schedule (v2 /trafficrules, action BLOCK)"

	limitGroupPrefix = router.ProductRulePrefix + "limit "
	scheduleDescPfx  = router.ProductRulePrefix + "schedule "
)

var (
	_ router.RateLimiter = (*Driver)(nil)
	_ router.Scheduler   = (*Driver)(nil)
)

const limitNote = "Puts the device in its own UniFi user group with the download/upload limits (kbit/s). UniFi applies user-group limits at its access points and gateway; on older controllers they reach wireless clients only. A device in a user group the administrator made is not moved."

// ---------- rate limit ----------

type userGroup struct {
	ID       string
	Name     string
	Down, Up int
	Default  bool
}

func (d *Driver) userGroups(ctx context.Context, op string) ([]userGroup, error) {
	rows, err := d.call(ctx, op, http.MethodGet, "/rest/usergroup", nil)
	if err != nil {
		return nil, err
	}
	out := make([]userGroup, 0, len(rows))
	for _, r := range rows {
		g := userGroup{ID: str(r["_id"]), Name: str(r["name"]), Down: -1, Up: -1}
		if v, ok := intOf(r["qos_rate_max_down"]); ok {
			g.Down = v
		}
		if v, ok := intOf(r["qos_rate_max_up"]); ok {
			g.Up = v
		}
		g.Default = str(r["attr_hidden_id"]) == "Default" || (g.Name == "Default" && boolOf(r["attr_no_delete"]))
		out = append(out, g)
	}
	return out, nil
}

func (d *Driver) userRecord(ctx context.Context, op, mac string) (map[string]any, error) {
	users, err := d.call(ctx, op, http.MethodGet, "/rest/user", nil)
	if err != nil {
		return nil, err
	}
	for _, u := range users {
		if m, err := router.NormalizeMAC(str(u["mac"])); err == nil && m == mac {
			return u, nil
		}
	}
	return nil, nil
}

func kbpsField(v int) int {
	if v <= 0 {
		return -1
	}
	return v
}

func findGroup(gs []userGroup, pred func(userGroup) bool) *userGroup {
	for i := range gs {
		if pred(gs[i]) {
			return &gs[i]
		}
	}
	return nil
}

// SetRateLimit puts the device in its own Nigafiy user group with the limits.
func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if err := router.ValidateRateLimit(limit); err != nil {
		return router.Change{}, err
	}
	user, err := d.userRecord(ctx, "rate_limit", mac)
	if err != nil {
		return router.Change{}, err
	}
	if user == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rate_limit", "UniFi has no client record for %s", mac)
	}
	groups, err := d.userGroups(ctx, "rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	name := limitGroupPrefix + mac
	current := str(user["usergroup_id"])
	if cur := findGroup(groups, func(g userGroup) bool { return g.ID == current }); current != "" && cur != nil && !cur.Default && cur.Name != name {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "the device is in the administrator's UniFi user group %q (down %d, up %d kbit/s); Nigafiy does not move it out of a group it did not make. Change that group in UniFi, or move the device to Default first", cur.Name, cur.Down, cur.Up)
	}
	down, up := kbpsField(limit.DownKbps), kbpsField(limit.UpKbps)
	own := findGroup(groups, func(g userGroup) bool { return g.Name == name })
	if own != nil && own.Down == down && own.Up == up && current == own.ID {
		return router.Change{Action: "rate_limit", MAC: mac, Mechanism: mechLimit, Applied: false, AlreadyInEffect: true,
			Detail: "the device's UniFi user group already has " + router.DescribeLimit(limit), Undo: undoLimit(mac)}, nil
	}
	body := map[string]any{"name": name, "qos_rate_max_down": down, "qos_rate_max_up": up}
	var gid string
	if own != nil {
		if _, err := d.call(ctx, "rate_limit", http.MethodPut, "/rest/usergroup/"+url.PathEscape(own.ID), body); err != nil {
			return router.Change{}, err
		}
		gid = own.ID
	} else {
		rows, err := d.call(ctx, "rate_limit", http.MethodPost, "/rest/usergroup", body)
		if err != nil {
			return router.Change{}, err
		}
		if len(rows) > 0 {
			gid = str(rows[0]["_id"])
		}
		if gid == "" {
			// Some controllers answer an empty data list: find the group by its name.
			gs, err := d.userGroups(ctx, "rate_limit")
			if err != nil {
				return router.Change{}, err
			}
			if g := findGroup(gs, func(g userGroup) bool { return g.Name == name }); g != nil {
				gid = g.ID
			}
		}
		if gid == "" {
			return router.Change{}, router.Errorf(router.ErrProtocol, "rate_limit", "UniFi did not report the new user group")
		}
	}
	if current != gid {
		if _, err := d.call(ctx, "rate_limit", http.MethodPut, "/rest/user/"+url.PathEscape(str(user["_id"])), map[string]any{"usergroup_id": gid}); err != nil {
			return router.Change{}, err
		}
	}
	// Re-read: the client must be in the group and the group must carry the limits.
	user, err = d.userRecord(ctx, "rate_limit", mac)
	if err != nil {
		return router.Change{}, err
	}
	groups, err = d.userGroups(ctx, "rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	g := findGroup(groups, func(g userGroup) bool { return g.ID == gid })
	if user == nil || str(user["usergroup_id"]) != gid || g == nil || g.Down != down || g.Up != up {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "UniFi accepted the change but the client's user group does not show the new limits")
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("UniFi user group %q: %s; the client is in it", name, router.DescribeLimit(limit)),
		Undo:      undoLimit(mac),
	}, nil
}

func undoLimit(mac string) string {
	return fmt.Sprintf("Remove the limit in Nigafiy, or in UniFi move the client back to the Default user group and delete the group %q", limitGroupPrefix+mac)
}

// ClearRateLimit moves the device back to the Default group and deletes the Nigafiy group.
func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	groups, err := d.userGroups(ctx, "clear_rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	name := limitGroupPrefix + mac
	own := findGroup(groups, func(g userGroup) bool { return g.Name == name })
	if own == nil {
		return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: false, AlreadyInEffect: true,
			Detail: "no Nigafiy user group for this device in UniFi (limits from the administrator's groups are left as they are)"}, nil
	}
	user, err := d.userRecord(ctx, "clear_rate_limit", mac)
	if err != nil {
		return router.Change{}, err
	}
	if user != nil && str(user["usergroup_id"]) == own.ID {
		def := findGroup(groups, func(g userGroup) bool { return g.Default })
		if def == nil {
			return router.Change{}, router.Errorf(router.ErrProtocol, "clear_rate_limit", "UniFi reported no Default user group to move the client back to")
		}
		if _, err := d.call(ctx, "clear_rate_limit", http.MethodPut, "/rest/user/"+url.PathEscape(str(user["_id"])), map[string]any{"usergroup_id": def.ID}); err != nil {
			return router.Change{}, err
		}
	}
	if _, err := d.call(ctx, "clear_rate_limit", http.MethodDelete, "/rest/usergroup/"+url.PathEscape(own.ID), nil); err != nil {
		return router.Change{}, err
	}
	groups, err = d.userGroups(ctx, "clear_rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	if findGroup(groups, func(g userGroup) bool { return g.ID == own.ID }) != nil {
		return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "UniFi still lists the user group %q after deleting it", name)
	}
	return router.Change{
		Action:    "clear_rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("moved the client to the Default user group and deleted %q (it had down %d, up %d kbit/s; -1 = unlimited)", name, own.Down, own.Up),
		Undo:      "Set the limit again in Nigafiy",
	}, nil
}

// ---------- schedule (traffic rules) ----------

func (d *Driver) v2Prefix() string {
	if d.unifiOS {
		return "/proxy/network/v2/api/site/" + d.site
	}
	return "/v2/api/site/" + d.site
}

// v2 calls the v2 API, which answers plain JSON (no meta envelope) and reports errors by HTTP status.
func (d *Driver) v2(ctx context.Context, op, method, rel string, payload any) (int, []byte, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return 0, nil, err
		}
	}
	var body []byte
	if payload != nil {
		body, _ = json.Marshal(payload)
	}
	st, raw, _, err := d.rawDo(ctx, op, method, d.v2Prefix()+rel, body)
	if err != nil {
		return 0, nil, err
	}
	if st == http.StatusUnauthorized {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return 0, nil, err
		}
		if st, raw, _, err = d.rawDo(ctx, op, method, d.v2Prefix()+rel, body); err != nil {
			return 0, nil, err
		}
	}
	if st == http.StatusForbidden {
		return st, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "insufficient UniFi permissions (HTTP 403)"}
	}
	return st, raw, nil
}

func v2Error(raw []byte, st int) string {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && (e.Message != "" || e.Code != "") {
		return strings.TrimSpace(e.Code + " " + e.Message)
	}
	return fmt.Sprintf("HTTP %d", st)
}

type trafficRule struct {
	ID          string `json:"_id"`
	Action      string `json:"action"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Target      []struct {
		ClientMAC string `json:"client_mac"`
		Type      string `json:"type"`
	} `json:"target_devices"`
	Schedule struct {
		Mode   string   `json:"mode"`
		Days   []string `json:"repeat_on_days"`
		AllDay bool     `json:"time_all_day"`
		Start  string   `json:"time_range_start"`
		End    string   `json:"time_range_end"`
	} `json:"schedule"`
}

// errNoTrafficRules: the controller has no v2 traffic-rule API (UniFi Network before 7.x).
var errNoTrafficRules = router.Errorf(router.ErrUnsupported, "schedule", "this UniFi Network version has no traffic rules (they need UniFi Network 7.x or newer); use Nigafiy's own schedule")

func (d *Driver) trafficRules(ctx context.Context, op string) ([]trafficRule, error) {
	st, raw, err := d.v2(ctx, op, http.MethodGet, "/trafficrules", nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound {
		return nil, errNoTrafficRules
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrRejected, op, "UniFi refused to list traffic rules (%s)", v2Error(raw, st))
	}
	var rules []trafficRule
	if err := json.Unmarshal(raw, &rules); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable UniFi traffic-rule list")
	}
	return rules, nil
}

func ownSchedule(r trafficRule, mac string) bool {
	return r.Description == scheduleDescPfx+mac
}

var ufDay = [7]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func segmentRule(mac string, s router.Segment) map[string]any {
	days := make([]string, len(s.Days))
	for i, d := range s.Days {
		days[i] = ufDay[d]
	}
	end := s.End
	if end == router.EndOfDay {
		end = "23:59" // UniFi has no 24:00 (see the file comment)
	}
	mode := "EVERY_WEEK"
	if len(s.Days) == 7 {
		mode = "EVERY_DAY"
	}
	return map[string]any{
		"action":           "BLOCK",
		"description":      scheduleDescPfx + mac,
		"enabled":          true,
		"matching_target":  "INTERNET",
		"target_devices":   []map[string]any{{"client_mac": mac, "type": "CLIENT"}},
		"app_category_ids": []string{},
		"app_ids":          []string{},
		"domains":          []string{},
		"ip_addresses":     []any{},
		"ip_ranges":        []any{},
		"network_ids":      []string{},
		"regions":          []string{},
		"bandwidth_limit":  map[string]any{"enabled": false, "download_limit_kbps": 1024, "upload_limit_kbps": 1024},
		"schedule": map[string]any{
			"mode":             mode,
			"repeat_on_days":   days,
			"time_all_day":     s.AllDay(),
			"time_range_start": s.Start,
			"time_range_end":   end,
		},
	}
}

func (d *Driver) deleteRule(ctx context.Context, op, id string) error {
	st, raw, err := d.v2(ctx, op, http.MethodDelete, "/trafficrules/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	if st != http.StatusOK && st != http.StatusNoContent && st != http.StatusNotFound {
		return router.Errorf(router.ErrRejected, op, "UniFi refused to delete traffic rule %s (%s)", id, v2Error(raw, st))
	}
	return nil
}

// SetSchedule replaces the device's Nigafiy traffic rules with one BLOCK rule per same-day segment.
// The new rules are added first; if UniFi refuses one, the ones just added are deleted again and
// the previous schedule stays as it was. An empty schedule clears it.
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
	before, err := d.trafficRules(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	var added []string
	rollback := func() {
		for _, id := range added {
			_ = d.deleteRule(ctx, "schedule", id)
		}
	}
	for _, s := range segs {
		st, raw, err := d.v2(ctx, "schedule", http.MethodPost, "/trafficrules", segmentRule(mac, s))
		if err != nil {
			rollback()
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusCreated {
			rollback()
			return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "UniFi refused the traffic rule (%s); nothing was changed", v2Error(raw, st))
		}
		var r trafficRule
		if json.Unmarshal(raw, &r) == nil && r.ID != "" {
			added = append(added, r.ID)
		}
	}
	isNew := map[string]bool{}
	for _, id := range added {
		isNew[id] = true
	}
	old := 0
	for _, r := range before {
		if ownSchedule(r, mac) && !isNew[r.ID] {
			if err := d.deleteRule(ctx, "schedule", r.ID); err != nil {
				return router.Change{}, err
			}
			old++
		}
	}
	after, err := d.trafficRules(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	n := 0
	for _, r := range after {
		if ownSchedule(r, mac) && r.Action == "BLOCK" && r.Enabled {
			n++
		}
	}
	if n != len(segs) {
		return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "UniFi shows %d Nigafiy schedule rule(s) for the device after the change, expected %d", n, len(segs))
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("UniFi blocks the device's internet %s (%d traffic rule(s), %d previous Nigafiy rule(s) replaced)", router.DescribeWindows(windows), n, old),
		Undo:      fmt.Sprintf("Remove the schedule in Nigafiy, or delete the traffic rules described %q in UniFi Network → Settings → Security / Traffic Rules", scheduleDescPfx+mac),
	}, nil
}

// ClearSchedule deletes the device's Nigafiy traffic rules (never the administrator's).
func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rules, err := d.trafficRules(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	var removed []string
	for _, r := range rules {
		if !ownSchedule(r, mac) {
			continue
		}
		if err := d.deleteRule(ctx, "clear_schedule", r.ID); err != nil {
			return router.Change{}, err
		}
		removed = append(removed, fmt.Sprintf("%s %s-%s", strings.Join(r.Schedule.Days, ","), r.Schedule.Start, r.Schedule.End))
	}
	if len(removed) == 0 {
		return router.Change{Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy traffic rule for this device in UniFi"}, nil
	}
	after, err := d.trafficRules(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range after {
		if ownSchedule(r, mac) {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "UniFi still lists a Nigafiy schedule rule for the device after deleting it")
		}
	}
	return router.Change{
		Action:    "clear_schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("deleted %d UniFi traffic rule(s): %s", len(removed), strings.Join(removed, "; ")),
		Undo:      "Set the schedule again in Nigafiy",
	}, nil
}

// scheduleCapability probes the v2 traffic-rule list so a controller without it reports why.
func (d *Driver) scheduleCapability(ctx context.Context) router.CapabilityStatus {
	_, err := d.trafficRules(ctx, "capabilities")
	switch {
	case err == nil:
		return router.CapabilityStatus{Capability: router.CapSchedule, Supported: true, Mechanism: mechSchedule,
			Note: "Adds UniFi traffic rules that block the device's internet during the windows (UniFi Network 7.x or newer); a window crossing midnight becomes two rules and a window ending at midnight ends at 23:59"}
	case err == errNoTrafficRules:
		return router.CapabilityStatus{Capability: router.CapSchedule, Supported: false, Note: "Not offered: this UniFi Network version has no traffic rules (v2 /trafficrules answered 404; they need UniFi Network 7.x or newer)" + d.versionSuffix()}
	default:
		return router.CapabilityStatus{Capability: router.CapSchedule, Supported: false, Note: "Not offered: the UniFi traffic-rule list could not be read (" + err.Error() + ")"}
	}
}

func (d *Driver) versionSuffix() string {
	if d.info != nil && d.info.Firmware != "" {
		return "; detected version " + d.info.Firmware
	}
	return ""
}
