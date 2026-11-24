package opnsense

// Rate limits on OPNsense (Built: R2, docs/features/router-controls.md): the traffic shaper
// (Firewall → Shaper, ipfw/dummynet), through its API (docs.opnsense.org development/api/core/
// trafficshaper: settings/addPipe, setPipe, delPipe, searchPipes, addRule, setRule, delRule,
// searchRules, service/reconfigure; model OPNsense/TrafficShaper/TrafficShaper.xml: pipe bandwidth,
// bandwidthMetric, mask, description; rule interface, proto, source, destination, target,
// description). Present in every OPNsense release the driver targets (24.1+).
//
// One pipe per limited direction with mask "none" (the whole pipe is the device's), and one rule on
// the LAN interface per pipe: traffic from the device's IPv4 → upload pipe, traffic to it → download
// pipe. Pipes and rules carry the description "LAN Detective: limit <mac> down|up" and are the only
// shaper entries Nigafiy changes or deletes.
//
// Schedules are not offered: OPNsense filter rules can reference a schedule (MVC Filter.xml rule
// field `sched`), but the schedules themselves live only in the legacy configuration
// (ScheduleField reads config schedules/schedule; Firewall → Settings → Schedules is a legacy page
// with no API), so a schedule cannot be created through the API. Nigafiy enforces the schedule
// itself through the block alias instead.

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
	mechLimit    = "OPNsense traffic shaper pipes and rules on the LAN interface (/api/trafficshaper)"
	limitNote    = "Adds a traffic-shaper pipe and rule per limited direction for the device's current IPv4 on the LAN interface; give the device a DHCP reservation so the limit keeps following it"
	scheduleNote = "Not offered by the firewall: OPNsense rules can use a schedule, but schedules (Firewall → Settings → Schedules) are a legacy page with no API in 24.x–26.x, so Nigafiy cannot create one; Nigafiy enforces the schedule itself with the block alias"
)

var _ router.RateLimiter = (*Driver)(nil)

func limitDesc(mac, dir string) string { return router.ProductRulePrefix + "limit " + mac + " " + dir }

type shaperRow struct {
	UUID, Description, Bandwidth, Metric, Source, Destination, Target string
}

func (d *Driver) shaperSearch(ctx context.Context, op, what string) ([]shaperRow, error) {
	st, raw, err := d.do(ctx, op, http.MethodPost, "/api/trafficshaper/settings/search"+what, map[string]any{"current": 1, "rowCount": -1, "searchPhrase": ""})
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound {
		return nil, router.Errorf(router.ErrUnsupported, op, "this OPNsense has no traffic shaper API")
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "trafficshaper search%s answered HTTP %d", what, st)
	}
	var rep struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable trafficshaper search%s JSON", what)
	}
	out := make([]shaperRow, 0, len(rep.Rows))
	for _, r := range rep.Rows {
		out = append(out, shaperRow{UUID: str(r["uuid"]), Description: str(r["description"]), Bandwidth: optVal(r["bandwidth"]), Metric: optVal(r["bandwidthMetric"]),
			Source: optVal(r["source"]), Destination: optVal(r["destination"]), Target: optVal(r["target"])})
	}
	return out, nil
}

func byDesc(rows []shaperRow, desc string) *shaperRow {
	for i := range rows {
		if rows[i].Description == desc {
			return &rows[i]
		}
	}
	return nil
}

func (d *Driver) reconfigureShaper(ctx context.Context, op string) error {
	st, raw, err := d.do(ctx, op, http.MethodPost, "/api/trafficshaper/service/reconfigure", map[string]any{})
	if err != nil {
		return err
	}
	var res struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(raw, &res)
	if st != http.StatusOK || (res.Status != "" && !strings.EqualFold(strings.TrimSpace(res.Status), "ok")) {
		return router.Errorf(router.ErrRejected, op, "OPNsense trafficshaper/service/reconfigure answered HTTP %d", st)
	}
	return nil
}

func (d *Driver) clientIP(ctx context.Context, op, mac string) (string, error) {
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return "", err
	}
	for _, c := range clients {
		if c.MAC == mac && c.IP != "" {
			return c.IP, nil
		}
	}
	return "", router.Errorf(router.ErrNotFound, op, "OPNsense has no IPv4 address for %s in ARP/DHCP", mac)
}

// SetRateLimit creates or updates one pipe and one rule per limited direction.
func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if err := router.ValidateRateLimit(limit); err != nil {
		return router.Change{}, err
	}
	ip, err := d.clientIP(ctx, "rate_limit", mac)
	if err != nil {
		return router.Change{}, err
	}
	pipes, err := d.shaperSearch(ctx, "rate_limit", "Pipes")
	if err != nil {
		return router.Change{}, err
	}
	rules, err := d.shaperSearch(ctx, "rate_limit", "Rules")
	if err != nil {
		return router.Change{}, err
	}
	for _, dir := range []struct {
		name string
		kbps int
		src  string
		dst  string
	}{{"down", limit.DownKbps, "any", ip}, {"up", limit.UpKbps, ip, "any"}} {
		desc := limitDesc(mac, dir.name)
		pipe, rule := byDesc(pipes, desc), byDesc(rules, desc)
		if dir.kbps == 0 {
			// No limit in this direction: remove what an earlier limit left (rule first, it references the pipe).
			if rule != nil {
				if _, err := d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/delRule/"+url.PathEscape(rule.UUID), map[string]any{}, "deleted"); err != nil {
					return router.Change{}, err
				}
			}
			if pipe != nil {
				if _, err := d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/delPipe/"+url.PathEscape(pipe.UUID), map[string]any{}, "deleted"); err != nil {
					return router.Change{}, err
				}
			}
			continue
		}
		pbody := map[string]any{"pipe": map[string]any{"enabled": "1", "bandwidth": strconv.Itoa(dir.kbps), "bandwidthMetric": "Kbit", "mask": "none", "description": desc}}
		var pipeUUID string
		if pipe != nil {
			if _, err := d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/setPipe/"+url.PathEscape(pipe.UUID), pbody, "saved"); err != nil {
				return router.Change{}, err
			}
			pipeUUID = pipe.UUID
		} else {
			res, err := d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/addPipe", pbody, "saved")
			if err != nil {
				return router.Change{}, err
			}
			pipeUUID = res.UUID
		}
		rbody := map[string]any{"rule": map[string]any{"enabled": "1", "sequence": "1", "interface": "lan", "proto": "ip", "source": dir.src, "destination": dir.dst, "target": pipeUUID, "description": desc}}
		if rule != nil {
			_, err = d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/setRule/"+url.PathEscape(rule.UUID), rbody, "saved")
		} else {
			_, err = d.mvcPost(ctx, "rate_limit", "/api/trafficshaper/settings/addRule", rbody, "saved")
		}
		if err != nil {
			return router.Change{}, err
		}
	}
	if err := d.reconfigureShaper(ctx, "rate_limit"); err != nil {
		return router.Change{}, err
	}
	// Re-read.
	if pipes, err = d.shaperSearch(ctx, "rate_limit", "Pipes"); err != nil {
		return router.Change{}, err
	}
	if rules, err = d.shaperSearch(ctx, "rate_limit", "Rules"); err != nil {
		return router.Change{}, err
	}
	for dir, kbps := range map[string]int{"down": limit.DownKbps, "up": limit.UpKbps} {
		p, r := byDesc(pipes, limitDesc(mac, dir)), byDesc(rules, limitDesc(mac, dir))
		if (kbps > 0) != (p != nil && r != nil) || (p != nil && kbps > 0 && p.Bandwidth != strconv.Itoa(kbps)) {
			return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "OPNsense accepted the change but the %s pipe does not show %d kbit/s", dir, kbps)
		}
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("OPNsense shaper limits %s: %s", ip, router.DescribeLimit(limit)),
		Undo:      fmt.Sprintf("Remove the limit in Nigafiy, or delete the shaper rules and pipes described %q / %q under Firewall → Shaper", limitDesc(mac, "down"), limitDesc(mac, "up")),
	}, nil
}

// ClearRateLimit deletes the device's shaper rules and pipes.
func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	pipes, err := d.shaperSearch(ctx, "clear_rate_limit", "Pipes")
	if err != nil {
		return router.Change{}, err
	}
	rules, err := d.shaperSearch(ctx, "clear_rate_limit", "Rules")
	if err != nil {
		return router.Change{}, err
	}
	removed := 0
	for _, dir := range []string{"down", "up"} {
		desc := limitDesc(mac, dir)
		if r := byDesc(rules, desc); r != nil {
			if _, err := d.mvcPost(ctx, "clear_rate_limit", "/api/trafficshaper/settings/delRule/"+url.PathEscape(r.UUID), map[string]any{}, "deleted"); err != nil {
				return router.Change{}, err
			}
			removed++
		}
		if p := byDesc(pipes, desc); p != nil {
			if _, err := d.mvcPost(ctx, "clear_rate_limit", "/api/trafficshaper/settings/delPipe/"+url.PathEscape(p.UUID), map[string]any{}, "deleted"); err != nil {
				return router.Change{}, err
			}
			removed++
		}
	}
	if removed == 0 {
		return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy shaper entries for this device on OPNsense"}, nil
	}
	if err := d.reconfigureShaper(ctx, "clear_rate_limit"); err != nil {
		return router.Change{}, err
	}
	if pipes, err = d.shaperSearch(ctx, "clear_rate_limit", "Pipes"); err != nil {
		return router.Change{}, err
	}
	for _, dir := range []string{"down", "up"} {
		if byDesc(pipes, limitDesc(mac, dir)) != nil {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "OPNsense still lists the %s pipe", dir)
		}
	}
	return router.Change{
		Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: true,
		Detail: fmt.Sprintf("deleted %d Nigafiy shaper entries on OPNsense", removed),
		Undo:   "Set the limit again in Nigafiy",
	}, nil
}
