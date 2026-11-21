package zyxel

// Per-device speed limit and blocking schedule, built from what the router's own web UI sends
// (static/js/app.js; field shapes confirmed against a VMG3625-T50B):
//
//   - rate limit (upload only): one QoS queue on the WAN side with a shaping rate, plus one QoS
//     class that sends traffic coming from the device's MAC (ingress LAN) to that queue.
//       POST DAL?oid=qos_queue {Index:"", Name, RateLimit, ShapingRate, BufferManagement:"DT",
//                               DropAlgorithm:"DT", Interface:"WAN", Priority, Weight, Enable}
//       POST DAL?oid=qos_class {Enable, Name, Order, Interface:"LAN", Ethertype:"NA",
//                               SourceMACEnable, SourceMACAddress, SourceMACMask, ..., Queue, defaultQ:false}
//       PUT  DAL?oid=qos {Enable:true, AutoMapType:"None", UpRate, DownRate} (QoS must be on)
//     This firmware offers queues on the WAN side only and classes match traffic entering from the
//     LAN, so download cannot be limited per device; a download limit is refused, not faked.
//   - schedule: one parental-control profile whose "Internet Access Schedule" holds the times the
//     device MAY use the internet (the complement of the blocked windows).
//       POST DAL?oid=paren_ctl {Index:"", pcpName, pcpEnable:1, MACAddressList, TimeRangeList
//                               "HH:MM-HH:MM,...", Days "Mon,Tue,...", ServicePolicy:"Block",
//                               UrlPolicy:"Block", WebRedirect:0, URLFilter:"", NetworkServiceList:""}
//       PUT  DAL?oid=paren_ctl {PrentalCtlEnable:true} (the global switch)
//
// Objects made by LAN Detective are named "LD-<mac without colons>" so they are recognisable on the
// router's pages and are the only ones this driver changes or deletes.

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	mechanismRateLimit = "QoS upload queue + class (Network Setting > QoS)"
	mechanismSchedule  = "parental control profile (Security > Parental Control)"
	ldObjectPrefix     = "LD-"
	qosMaxQueues       = 8   // the web UI refuses a 9th queue
	qosMaxKbps         = 1024000
	pcpMaxRanges       = 3   // the web UI allows three time ranges per profile
	pcpMaxProfiles     = 20
)

// ldName is the router-side name of the objects LAN Detective makes for one device.
func ldName(mac string) string { return ldObjectPrefix + strings.ReplaceAll(mac, ":", "") }

// isLDObject reports whether a router object name belongs to LAN Detective.
func isLDObject(name string) bool {
	if !strings.HasPrefix(name, ldObjectPrefix) || len(name) != len(ldObjectPrefix)+12 {
		return false
	}
	_, err := strconv.ParseUint(name[len(ldObjectPrefix):], 16, 64)
	return err == nil
}

// dalDeleteBy sends DELETE DAL?oid=<oid>&<key>=<n>; qos_class keys on iid, qos_queue on idx.
func (d *Driver) dalDeleteBy(ctx context.Context, op, oid, key string, n int) error {
	_, err := d.dal(ctx, op, http.MethodDelete, oid+"&"+key+"="+url.QueryEscape(strconv.Itoa(n)), nil)
	return err
}

func (d *Driver) list(ctx context.Context, op, oid string) ([]host, error) {
	rep, err := d.dal(ctx, op, http.MethodGet, oid, nil)
	if err != nil {
		return nil, err
	}
	return objects(rep), nil
}

func named(objs []host, key, name string) host {
	for _, o := range objs {
		if o.str(key) == name {
			return o
		}
	}
	return nil
}

// ---- QoS (rate limit) ----

type qosState struct {
	global           host
	queues, classes  []host
}

func (d *Driver) qosRead(ctx context.Context, op string) (qosState, error) {
	var st qosState
	g, err := d.list(ctx, op, "qos")
	if err != nil {
		return st, err
	}
	if len(g) == 0 {
		return st, router.Errorf(router.ErrProtocol, op, "the router returned no QoS settings")
	}
	st.global = g[0]
	if st.queues, err = d.list(ctx, op, "qos_queue"); err != nil {
		return st, err
	}
	if st.classes, err = d.list(ctx, op, "qos_class"); err != nil {
		return st, err
	}
	return st, nil
}

func (d *Driver) setQoSEnabled(ctx context.Context, op string, g host, on bool) error {
	up, _ := g.integer("UpRate")
	down, _ := g.integer("DownRate")
	auto := g.str("AutoMapType")
	if auto == "" {
		auto = "None"
	}
	_, err := d.dal(ctx, op, http.MethodPut, "qos", map[string]any{"Enable": on, "AutoMapType": auto, "UpRate": up, "DownRate": down})
	return err
}

func queueRate(q host) int {
	if r, ok := q.integer("ShapingRate"); ok && r > 0 {
		return r
	}
	r, _ := q.integer("RateLimit")
	return r
}

// SetRateLimit limits the device's upload speed. Download limits are refused: see the file comment.
func (d *Driver) SetRateLimit(ctx context.Context, mac string, limit router.RateLimit) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	if limit.DownKbps > 0 {
		return router.Change{}, router.Errorf(router.ErrUnsupported, "rate_limit",
			"this router can only limit a device's upload: its QoS queues exist on the WAN side only; leave download empty (no limit)")
	}
	if limit.UpKbps <= 0 || limit.UpKbps > qosMaxKbps {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "rate_limit", "upload limit must be between 1 and %d kbit/s", qosMaxKbps)
	}
	name := ldName(norm)
	ch := router.Change{Action: "rate_limit", MAC: norm, Mechanism: mechanismRateLimit}
	err = d.withSession(ctx, func() error {
		h, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		st, err := d.qosRead(ctx, "rate_limit")
		if err != nil {
			return err
		}
		if a := st.global.str("AutoMapType"); a != "" && a != "None" {
			return router.Errorf(router.ErrRejected, "rate_limit",
				"the router's QoS is in automatic priority mode (%s), which ignores per-device rules; the administrator must set it to None first", a)
		}
		q, c := named(st.queues, "Name", name), named(st.classes, "Name", name)
		qosOn := truthy(st.global["Enable"])
		if q != nil && c != nil && queueRate(q) == limit.UpKbps && truthy(c["Enable"]) && qosOn {
			ch.AlreadyInEffect = true
			return nil
		}
		createdQueue := false
		if q == nil {
			if len(st.queues) >= qosMaxQueues {
				return router.Errorf(router.ErrRejected, "rate_limit",
					"all %d QoS queues of the router are in use; remove a speed limit or a queue first", qosMaxQueues)
			}
			if _, err := d.dal(ctx, "rate_limit", http.MethodPost, "qos_queue", map[string]any{
				"Index": "", "Name": name, "RateLimit": limit.UpKbps, "ShapingRate": limit.UpKbps,
				"BufferManagement": "DT", "DropAlgorithm": "DT", "Interface": "WAN",
				// Same priority and weight as the router's default queue: the device is never favoured.
				"Priority": 8, "Weight": 1, "Enable": true,
			}); err != nil {
				return err
			}
			createdQueue = true
		} else if queueRate(q) != limit.UpKbps || !truthy(q["Enable"]) {
			upd := map[string]any{}
			for k, v := range q {
				upd[k] = v
			}
			upd["RateLimit"], upd["ShapingRate"], upd["Enable"] = limit.UpKbps, limit.UpKbps, true
			if _, err := d.dal(ctx, "rate_limit", http.MethodPut, "qos_queue", upd); err != nil {
				return err
			}
		}
		queues, err := d.list(ctx, "rate_limit", "qos_queue")
		if err != nil {
			return err
		}
		q = named(queues, "Name", name)
		if q == nil || queueRate(q) != limit.UpKbps {
			return router.Errorf(router.ErrRejected, "rate_limit", "the router accepted the queue but does not show it with the new rate")
		}
		undoQueue := func() {
			if n, ok := q.integer("idx"); ok && createdQueue {
				_ = d.dalDeleteBy(ctx, "rate_limit", "qos_queue", "idx", n)
			}
		}
		qIndex, _ := q.integer("Index")
		if c == nil {
			if _, err := d.dal(ctx, "rate_limit", http.MethodPost, "qos_class", classBody(name, h.str("PhysAddress"), norm, len(st.classes)+1, qIndex)); err != nil {
				undoQueue()
				return err
			}
		} else if cq, _ := c.integer("Queue"); cq != qIndex || !truthy(c["Enable"]) {
			iid, _ := c.integer("iid")
			body := classBody(name, h.str("PhysAddress"), norm, 0, qIndex)
			body["iid"] = iid
			if o, ok := c.integer("Order"); ok {
				body["Order"] = o
			}
			if _, err := d.dal(ctx, "rate_limit", http.MethodPut, "qos_class", body); err != nil {
				return err
			}
		}
		classes, err := d.list(ctx, "rate_limit", "qos_class")
		if err != nil {
			return err
		}
		if c = named(classes, "Name", name); c == nil || !truthy(c["Enable"]) {
			undoQueue()
			return router.Errorf(router.ErrRejected, "rate_limit", "the router accepted the QoS class but does not show it")
		}
		if !qosOn {
			if err := d.setQoSEnabled(ctx, "rate_limit", st.global, true); err != nil {
				return err
			}
			g, err := d.list(ctx, "rate_limit", "qos")
			if err != nil {
				return err
			}
			if len(g) == 0 || !truthy(g[0]["Enable"]) {
				return router.Errorf(router.ErrRejected, "rate_limit", "the router did not turn QoS on")
			}
			ch.Detail = "; QoS was off and has been turned on"
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.AlreadyInEffect {
		ch.Detail = fmt.Sprintf("upload of %s is already limited to %d kbit/s on the router; nothing changed", norm, limit.UpKbps)
		return ch, nil
	}
	ch.Detail = fmt.Sprintf("limited upload of %s to %d kbit/s (QoS queue and class %q); download is not limited: this router cannot limit download per device", norm, limit.UpKbps, name) + ch.Detail
	ch.Undo = fmt.Sprintf("remove the speed limit in LAN Detective, or delete the class and the queue named %q in the router's Network Setting > QoS", name)
	return ch, nil
}

func classBody(name, physMAC, norm string, order, queue int) map[string]any {
	m := strings.ToUpper(physMAC)
	if m == "" {
		m = strings.ToUpper(norm)
	}
	body := map[string]any{
		"Enable": true, "Name": name, "Interface": "LAN", "TargetInterface": "", "Ethertype": "NA",
		"SourceIPEnable": false, "SourcePortEnable": false,
		"SourceMACEnable": true, "SourceMACAddress": m, "SourceMACMask": "FF:FF:FF:FF:FF:FF", "SourceMACExclude": false,
		"DestIPEnable": false, "DestPortEnable": false, "DestMACEnable": false, "ServiceEnable": false,
		"ProtocolEnable": false, "DhcpEnable": false, "IPLengthEnable": false, "DSCPCheckEnable": false,
		"EthernetPriorityEnable": false, "VLANIDCheckEnable": false, "TCPACK": false,
		"DSCPMark": -1, "VLANIDAction": 0, "ForwardingPolicy": 0, "defaultQ": false, "Queue": queue,
	}
	if order > 0 {
		body["Order"] = order
	}
	return body
}

// ClearRateLimit removes the class and queue LAN Detective made for the device. QoS is turned off
// again when no classification rule is left (the router's state before the first limit).
func (d *Driver) ClearRateLimit(ctx context.Context, mac string) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	name := ldName(norm)
	ch := router.Change{Action: "clear_rate_limit", MAC: norm, Mechanism: mechanismRateLimit}
	extra := ""
	err = d.withSession(ctx, func() error {
		st, err := d.qosRead(ctx, "clear_rate_limit")
		if err != nil {
			return err
		}
		q, c := named(st.queues, "Name", name), named(st.classes, "Name", name)
		if q == nil && c == nil {
			ch.AlreadyInEffect = true
			return nil
		}
		if c != nil {
			iid, _ := c.integer("iid")
			if err := d.dalDeleteBy(ctx, "clear_rate_limit", "qos_class", "iid", iid); err != nil {
				return err
			}
		}
		if q != nil {
			idx, ok := q.integer("idx")
			if !ok {
				idx, _ = q.integer("Index")
			}
			if err := d.dalDeleteBy(ctx, "clear_rate_limit", "qos_queue", "idx", idx); err != nil {
				return err
			}
		}
		after, err := d.qosRead(ctx, "clear_rate_limit")
		if err != nil {
			return err
		}
		if named(after.queues, "Name", name) != nil || named(after.classes, "Name", name) != nil {
			return router.Errorf(router.ErrRejected, "clear_rate_limit", "the router still shows the QoS class or queue %q", name)
		}
		if len(after.classes) == 0 && truthy(after.global["Enable"]) {
			if err := d.setQoSEnabled(ctx, "clear_rate_limit", after.global, false); err == nil {
				extra = "; QoS turned off again (no classification rule is left)"
			}
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.AlreadyInEffect {
		ch.Detail = "no speed limit from LAN Detective on the router for " + norm + "; nothing changed"
		return ch, nil
	}
	ch.Detail = "removed the upload limit of " + norm + extra
	ch.Undo = "set the speed limit again in LAN Detective"
	return ch, nil
}

// ---- parental control (schedule) ----

var zyDays = [...]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"} // index = time.Weekday

func hhmm(s string) (int, bool) {
	t, err := time.Parse("15:04", strings.TrimSpace(s))
	if err != nil {
		if strings.TrimSpace(s) == "24:00" {
			return 1440, true
		}
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

func fmtMin(m int) string {
	if m >= 1440 {
		return "23:59" // the router stores the end of the day as 23:59 (its UI shows it as 24:00)
	}
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

// allowedRanges turns blocked windows (all on the same days) into the router's allowed-time list.
func allowedRanges(blocked []router.Window) (days string, ranges []string, err error) {
	if len(blocked) == 0 {
		return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule", "no blocked window given")
	}
	key := func(ds []time.Weekday) string {
		seen := map[time.Weekday]bool{}
		for _, d := range ds {
			if d >= time.Sunday && d <= time.Saturday {
				seen[d] = true
			}
		}
		var names []string
		for _, d := range []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday, time.Saturday, time.Sunday} {
			if seen[d] {
				names = append(names, zyDays[d])
			}
		}
		return strings.Join(names, ",")
	}
	days = key(blocked[0].Days)
	if days == "" {
		return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule", "a window has no days")
	}
	var minutes [1440]bool // true = blocked
	for _, w := range blocked {
		if key(w.Days) != days {
			return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule",
				"this router applies one set of days to all times of a device; give every window the same days")
		}
		s, ok1 := hhmm(w.Start)
		e, ok2 := hhmm(w.End)
		if !ok1 || !ok2 || s == e || s >= 1440 {
			return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule", "bad window %s-%s", w.Start, w.End)
		}
		mark := func(a, b int) {
			for m := a; m < b; m++ {
				minutes[m] = true
			}
		}
		if e > s {
			mark(s, e)
		} else { // crosses midnight, e.g. 22:00-07:00
			mark(s, 1440)
			mark(0, e)
		}
	}
	for m := 0; m < 1440; {
		if minutes[m] {
			m++
			continue
		}
		start := m
		for m < 1440 && !minutes[m] {
			m++
		}
		ranges = append(ranges, fmtMin(start)+"-"+fmtMin(m))
	}
	switch {
	case len(ranges) == 0:
		return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule", "the windows block the whole day; block the device instead")
	case len(ranges) > pcpMaxRanges:
		return "", nil, router.Errorf(router.ErrInvalidArgument, "schedule",
			"the windows leave %d separate allowed periods in a day; this router allows at most %d", len(ranges), pcpMaxRanges)
	}
	sort.Strings(ranges)
	return days, ranges, nil
}

// SetSchedule blocks the device's internet during the given weekly windows.
func (d *Driver) SetSchedule(ctx context.Context, mac string, blocked []router.Window) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	days, ranges, err := allowedRanges(blocked)
	if err != nil {
		return router.Change{}, err
	}
	name := ldName(norm)
	timeList := strings.Join(ranges, ",")
	ch := router.Change{Action: "schedule", MAC: norm, Mechanism: mechanismSchedule}
	err = d.withSession(ctx, func() error {
		h, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		if what, err := d.parentalBlocker(ctx); err != nil {
			return err
		} else if what != "" {
			return router.Errorf(router.ErrRejected, "schedule", "%s", parentalBlockedNote(what))
		}
		global, profiles, err := d.parentalProfiles(ctx)
		if err != nil {
			return err
		}
		var mine *pcpProfile
		for i := range profiles {
			if profiles[i].Name == name {
				mine = &profiles[i]
			}
		}
		if mine != nil && global && truthy(mine.Enable) && mine.Days == days && mine.TimeRangeList == timeList {
			ch.AlreadyInEffect = true
			return nil
		}
		body := map[string]any{
			"ServicePolicy": "Block", "UrlPolicy": "Block", "pcpName": name, "pcpEnable": 1, "WebRedirect": 0,
			"MACAddressList": strings.ToUpper(h.str("PhysAddress")), "URLFilter": "", "NetworkServiceList": "",
			"TimeRangeList": timeList, "Days": days,
		}
		if body["MACAddressList"] == "" {
			body["MACAddressList"] = strings.ToUpper(norm)
		}
		method := http.MethodPost
		if mine != nil {
			method = http.MethodPut
			body["Index"] = mine.Index
		} else {
			if len(profiles) >= pcpMaxProfiles {
				return router.Errorf(router.ErrRejected, "schedule", "the router already has %d parental-control profiles (its maximum)", pcpMaxProfiles)
			}
			body["Index"] = ""
		}
		if _, err := d.dal(ctx, "schedule", method, "paren_ctl", body); err != nil {
			return err
		}
		if !global {
			if _, err := d.dal(ctx, "schedule", http.MethodPut, "paren_ctl", map[string]any{"PrentalCtlEnable": true}); err != nil {
				return err
			}
			ch.Detail = "; parental control was off and has been turned on"
		}
		global, profiles, err = d.parentalProfiles(ctx)
		if err != nil {
			return err
		}
		ok := false
		for _, p := range profiles {
			if p.Name == name && p.Days == days && p.TimeRangeList == timeList && truthy(p.Enable) {
				ok = true
			}
		}
		if !ok || !global {
			return router.Errorf(router.ErrRejected, "schedule", "the router accepted the schedule but does not show it as active")
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.AlreadyInEffect {
		ch.Detail = "the same schedule is already active on the router for " + norm + "; nothing changed"
		return ch, nil
	}
	ch.Detail = fmt.Sprintf("internet of %s allowed only %s on %s (parental control profile %q)", norm, strings.Join(ranges, ", "), days, name) + ch.Detail
	ch.Undo = fmt.Sprintf("remove the schedule in LAN Detective, or delete the profile %q in the router's Security > Parental Control", name)
	return ch, nil
}

// ClearSchedule deletes the device's profile. Parental control is switched off again when no
// profile is left (the router's state before the first schedule).
func (d *Driver) ClearSchedule(ctx context.Context, mac string) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	name := ldName(norm)
	ch := router.Change{Action: "clear_schedule", MAC: norm, Mechanism: mechanismSchedule}
	extra := ""
	err = d.withSession(ctx, func() error {
		_, profiles, err := d.parentalProfiles(ctx)
		if err != nil {
			return err
		}
		var mine *pcpProfile
		for i := range profiles {
			if profiles[i].Name == name {
				mine = &profiles[i]
			}
		}
		if mine == nil {
			ch.AlreadyInEffect = true
			return nil
		}
		idx, ok := host{"i": mine.Index}.integer("i")
		if !ok {
			return router.Errorf(router.ErrProtocol, "clear_schedule", "the router's profile %q has no index", name)
		}
		if err := d.dalDelete(ctx, "clear_schedule", "paren_ctl", idx); err != nil {
			return err
		}
		global, left, err := d.parentalProfiles(ctx)
		if err != nil {
			return err
		}
		for _, p := range left {
			if p.Name == name {
				return router.Errorf(router.ErrRejected, "clear_schedule", "the router still shows the profile %q", name)
			}
		}
		if len(left) == 0 && global {
			if _, err := d.dal(ctx, "clear_schedule", http.MethodPut, "paren_ctl", map[string]any{"PrentalCtlEnable": false}); err == nil {
				extra = "; parental control turned off again (no profile is left)"
			}
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.AlreadyInEffect {
		ch.Detail = "no schedule from LAN Detective on the router for " + norm + "; nothing changed"
		return ch, nil
	}
	ch.Detail = "removed the internet schedule of " + norm + extra
	ch.Undo = "set the schedule again in LAN Detective"
	return ch, nil
}

// rateLimitCapability probes the QoS objects. Errors other than an expired session only mark the
// capability unsupported.
func (d *Driver) rateLimitCapability(ctx context.Context) (router.CapabilityStatus, error) {
	cs := router.CapabilityStatus{Capability: router.CapRateLimit, Mechanism: mechanismRateLimit}
	st, err := d.qosRead(ctx, "capabilities")
	switch {
	case isExpired(err):
		return cs, err
	case err != nil:
		cs.Note = "this firmware does not answer the QoS settings (DAL qos, qos_queue, qos_class)"
		return cs, nil
	}
	if a := st.global.str("AutoMapType"); a != "" && a != "None" {
		cs.Note = "the router's QoS is in automatic priority mode (" + a + "), which ignores per-device rules"
		return cs, nil
	}
	used := 0
	for _, q := range st.queues {
		if isLDObject(q.str("Name")) {
			used++
		}
	}
	free := qosMaxQueues - len(st.queues)
	cs.Supported = free > 0 || used > 0
	cs.Note = fmt.Sprintf("upload only (this router cannot limit download per device); %d of %d QoS queues free, one per limited device; QoS is turned on with the first limit", free, qosMaxQueues)
	return cs, nil
}

// parentalBlocker names the router feature that stops parental control from working, or "". The
// router's own page says parental control needs Mesh (EasyMesh) and One Connect off; with either on
// it accepts profiles but does not enforce them (seen on a VMG3625-T50B with EasyMesh on).
func (d *Driver) parentalBlocker(ctx context.Context) (string, error) {
	for _, p := range []struct{ oid, field, name string }{
		{"WIFI_EasyMesh", "EasyMeshEnable", "Wi-Fi Mesh (EasyMesh, Network Setting > Wireless)"},
		{"one_connect", "one_connect_Enable", "One Connect (Network Setting > Home Connectivity)"},
	} {
		objs, err := d.list(ctx, "schedule", p.oid)
		switch {
		case isExpired(err):
			return "", err
		case err != nil || len(objs) == 0:
			continue // this firmware has no such feature
		}
		if truthy(objs[0][p.field]) {
			return p.name, nil
		}
	}
	return "", nil
}

func parentalBlockedNote(what string) string {
	return "the router does not enforce parental-control schedules while " + what + " is on; the administrator must turn it off first"
}

func (d *Driver) scheduleCapability(ctx context.Context) (router.CapabilityStatus, error) {
	cs := router.CapabilityStatus{Capability: router.CapSchedule, Mechanism: mechanismSchedule}
	_, profiles, err := d.parentalProfiles(ctx)
	switch {
	case isExpired(err):
		return cs, err
	case err != nil:
		cs.Note = "this firmware does not answer DAL paren_ctl"
		return cs, nil
	}
	what, err := d.parentalBlocker(ctx)
	if err != nil {
		return cs, err
	}
	if what != "" {
		cs.Note = parentalBlockedNote(what)
		for _, p := range profiles {
			if isLDObject(p.Name) {
				// Keep the control open so a schedule made earlier can still be removed; setting a
				// new one is refused by SetSchedule with the same reason.
				cs.Supported = true
				cs.Note += "; a schedule set earlier can still be removed"
				break
			}
		}
		return cs, nil
	}
	cs.Supported = true
	cs.Note = fmt.Sprintf("one parental-control profile per device: the same windows on the chosen days, at most %d allowed periods a day; %d of %d profiles used",
		pcpMaxRanges, len(profiles), pcpMaxProfiles)
	return cs, nil
}

var (
	_ router.RateLimiter = (*Driver)(nil)
	_ router.Scheduler   = (*Driver)(nil)
)
