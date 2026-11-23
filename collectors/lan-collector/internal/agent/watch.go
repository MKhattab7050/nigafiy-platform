package agent

import (
	"context"
	"encoding/json"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/snmp"
	"github.com/nigafiy/sensor/internal/watch"
)

const (
	watchTimeout     = 10 * time.Second
	watchSNMPTimeout = 3 * time.Second
)

// runWatchCheck executes one http / https / tls_expiry / snmp_oid check and queues its result.
// The connection rule (watch.Guard) uses the scopes the cloud delivered AND this collector's own
// policy accepts; an SNMP device is read only when it is in those scopes too.
func (a *Agent) runWatchCheck(ctx context.Context, chk cloud.Check, ts time.Time) {
	var res watch.Result
	switch chk.Kind {
	case "http", "https":
		if a.deps.WatchHTTP == nil {
			return
		}
		var cfg watch.HTTPConfig
		if len(chk.Config) > 0 && json.Unmarshal(chk.Config, &cfg) != nil {
			res = watch.Result{Error: "the check's settings could not be read"}
			break
		}
		port := 0
		if chk.Port != nil {
			port = *chk.Port
		}
		g := watch.Guard{Scopes: a.authorizedPrefixes(), AllowPublic: cfg.AllowPublic}
		res = a.deps.WatchHTTP(ctx, watch.HTTPSpec{Scheme: chk.Kind, Host: chk.Target, Port: port, Config: cfg, Timeout: watchTimeout}, g)
	case "tls_expiry":
		if a.deps.WatchTLS == nil {
			return
		}
		var cfg watch.TLSConfig
		if len(chk.Config) > 0 && json.Unmarshal(chk.Config, &cfg) != nil {
			res = watch.Result{Error: "the check's settings could not be read"}
			break
		}
		if chk.Port == nil {
			return
		}
		g := watch.Guard{Scopes: a.authorizedPrefixes(), AllowPublic: cfg.AllowPublic}
		res = a.deps.WatchTLS(ctx, watch.TLSSpec{Host: chk.Target, Port: *chk.Port, Config: cfg, Timeout: watchTimeout}, g)
	case "snmp_oid":
		if a.deps.SNMPGet == nil {
			return
		}
		var cfg watch.SNMPConfig
		if json.Unmarshal(chk.Config, &cfg) != nil {
			res = watch.Result{Error: "the check's settings could not be read"}
			break
		}
		target, ok := a.snmpTargetByID(chk.SNMPTargetID)
		switch {
		case !ok:
			res = watch.Result{Error: "the SNMP device's credentials have not been received (the device is disabled, outside the authorized ranges, or the collector restarted while the cloud was unreachable)"}
		case !a.snmpAllowed(target.Host):
			res = watch.Result{Error: "refused: the device is outside the ranges this collector is allowed to reach", Resolved: target.Host}
		default:
			res = watch.SNMPOID(ctx, target, cfg, a.deps.SNMPGet, watchSNMPTimeout)
		}
	default:
		return
	}
	if ctx.Err() != nil {
		return // shutting down: a cancelled request is not a failed check
	}
	a.enqueue(watchItem(chk.ID, ts, res))
}

// watchItem maps a watch result onto the check_result telemetry item.
func watchItem(checkID string, ts time.Time, res watch.Result) map[string]any {
	item := map[string]any{"type": "check_result", "check_id": checkID, "ts": ts, "ok": res.OK}
	if res.LatencyMs != nil {
		item["latency_ms"] = min(*res.LatencyMs, 120_000)
	}
	if res.Value != nil {
		item["value"] = *res.Value
	}
	if res.Error != "" {
		item["error"] = clipText(res.Error, 300)
	}
	if res.Resolved != "" {
		item["resolved_target"] = res.Resolved
	}
	if len(res.Details) > 0 {
		item["details"] = res.Details
	}
	return item
}

func (a *Agent) snmpTargetByID(id string) (snmp.Target, bool) {
	if id == "" {
		return snmp.Target{}, false
	}
	for _, t := range a.snmpTargets() {
		if t.ID == id {
			return t, true
		}
	}
	return snmp.Target{}, false
}

func clipText(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
