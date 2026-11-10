package agent

import (
	"context"
	"encoding/json"
	"net/netip"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/snmp"
)

const (
	minSNMPInterval = 60 * time.Second
	snmpTimeout     = 3 * time.Second
	snmpPollBudget  = 90 * time.Second // whole read of one device
	maxSNMPTargets  = 64
)

type snmpConfig struct {
	Targets []snmp.Target `json:"targets"`
}

func (a *Agent) snmpTargets() []snmp.Target {
	rc := a.remoteConfig()
	if rc == nil || len(rc.SNMP) == 0 {
		return nil
	}
	var c snmpConfig
	if json.Unmarshal(rc.SNMP, &c) != nil {
		return nil
	}
	if len(c.Targets) > maxSNMPTargets {
		c.Targets = c.Targets[:maxSNMPTargets]
	}
	return c.Targets
}

// snmpAllowed: a device is read only when its address is inside a scope that the cloud delivered
// and this collector's own policy accepts — the same rule as discovery.
func (a *Agent) snmpAllowed(host string) bool {
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	rc := a.remoteConfig()
	if rc == nil {
		return false
	}
	for _, sc := range rc.Discovery.Scopes {
		if prefix, err := a.policy.Check(sc.CIDR); err == nil && prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// snmpLoop reads each configured switch on its interval (Port Detective). One device at a time.
func (a *Agent) snmpLoop(ctx context.Context) {
	if a.deps.SNMPPoll == nil {
		return
	}
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	last := map[string]time.Time{}
	var refusedMu sync.Mutex
	refused := map[string]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-a.snmpNow:
			clear(last)
			a.markCompleted(id)
			continue
		case <-tick.C:
		}
		for _, t := range a.snmpTargets() {
			interval := clamp(t.IntervalSeconds, minSNMPInterval, 5*time.Minute)
			if time.Since(last[t.ID]) < interval {
				continue
			}
			last[t.ID] = time.Now()
			if !a.snmpAllowed(t.Host) {
				refusedMu.Lock()
				already := refused[t.ID]
				refused[t.ID] = true
				refusedMu.Unlock()
				if !already {
					a.log.Warn("refusing to read a device outside the authorized ranges", "host", t.Host)
				}
				a.enqueue(map[string]any{"type": "snmp_poll", "ts": time.Now().UTC(), "target_id": t.ID, "ok": false,
					"error": "the device is outside the ranges this collector is allowed to reach"})
				continue
			}
			a.pollSNMP(ctx, t)
			if ctx.Err() != nil {
				return
			}
		}
	}
}

func (a *Agent) pollSNMP(ctx context.Context, t snmp.Target) {
	started := time.Now()
	pctx, cancel := context.WithTimeout(ctx, snmpPollBudget)
	res, err := a.deps.SNMPPoll(pctx, t, snmpTimeout)
	cancel()
	if ctx.Err() != nil {
		return // shutting down: not a failed read
	}
	item := map[string]any{"type": "snmp_poll", "ts": time.Now().UTC(), "target_id": t.ID, "duration_ms": time.Since(started).Milliseconds()}
	if err != nil {
		item["ok"], item["error"] = false, err.Error()
		// Never log credentials; the host and the cleaned reason are enough.
		a.log.Warn("could not read a switch over SNMP", "host", t.Host, "error", err.Error())
	} else {
		item["ok"] = true
		item["sys_name"], item["sys_descr"] = res.SysName, res.SysDescr
		item["ports"], item["fdb"], item["lldp"] = res.Ports, res.FDB, res.LLDP
		if len(res.Truncated) > 0 {
			item["truncated"] = res.Truncated
		}
		a.log.Info("read a switch over SNMP", "host", t.Host, "ports", len(res.Ports), "addresses", len(res.FDB), "neighbours", len(res.LLDP),
			"duration", time.Since(started).Round(time.Millisecond).String())
	}
	a.enqueue(item)
	a.wakeUploader()
}
