package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/snmp"
)

// Port Detective port control: the `set_switch_port` command (closed list, see agent.go).
//
// The collector does not trust the command: it re-validates everything itself before touching the
// switch —
//   - the request has not expired and was never executed before (a ledger on disk survives restarts:
//     a command re-sent after a crash is never run twice);
//   - the switch is in the configuration the cloud delivered, with write credentials;
//   - the switch's address is inside a scope the cloud delivered AND this collector's own policy accepts;
//   - the operation is one of the closed list (snmp.ValidateChange); OIDs are built by the snmp
//     package, never taken from the request;
//   - a disruptive change on the port the collector itself or its gateway is learned on is refused
//     unless the administrator gave an override reason ("never cut yourself off").
//
// The result (before / after values read from the switch, verified or not) is reported as a
// `switch_port_result` telemetry item. Write credentials are never logged or reported.

const (
	cmdSetSwitchPort     = "set_switch_port"
	switchWriteBudget    = 60 * time.Second
	switchLedgerFile     = "switch-requests.json"
	switchLedgerKeepDays = 7
)

var (
	// One switch write at a time per collector process: two changes never interleave on a switch.
	switchWriteMu  sync.Mutex
	switchLedgerMu sync.Mutex
	requestIDRe    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type switchPortPayload struct {
	RequestID string    `json:"request_id"`
	TargetID  string    `json:"target_id"`
	IfIndex   int       `json:"if_index"`
	Op        string    `json:"op"`
	AdminUp   *bool     `json:"admin_up,omitempty"`
	Alias     *string   `json:"alias,omitempty"`
	VLAN      int       `json:"vlan,omitempty"`
	Method    string    `json:"method,omitempty"`
	Override  bool      `json:"override,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
}

// claimSwitchRequest records the request id in the on-disk ledger and reports whether this is its
// first execution. It is recorded BEFORE the switch is touched: a crash mid-change never leads to a
// second attempt (at most once).
func (a *Agent) claimSwitchRequest(id string, now time.Time) (bool, error) {
	switchLedgerMu.Lock()
	defer switchLedgerMu.Unlock()
	path := filepath.Join(a.cfg.StateDir, switchLedgerFile)
	ledger := map[string]time.Time{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &ledger)
	}
	if _, seen := ledger[id]; seen {
		return false, nil
	}
	for k, at := range ledger {
		if now.Sub(at) > switchLedgerKeepDays*24*time.Hour {
			delete(ledger, k)
		}
	}
	ledger[id] = now
	raw, _ := json.Marshal(ledger)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func (a *Agent) switchTarget(id string) (snmp.Target, bool) {
	for _, t := range a.snmpTargets() {
		if t.ID == id {
			return t, true
		}
	}
	return snmp.Target{}, false
}

// protectedMACs: this host's own MACs and the gateway's MAC (from the neighbour table).
func (a *Agent) protectedMACs(ctx context.Context) []string {
	var out []string
	if a.deps.LocalMACs != nil {
		for _, mac := range a.deps.LocalMACs() {
			if mac != "" {
				out = append(out, strings.ToLower(mac))
			}
		}
	}
	if a.deps.Gateway != nil && a.deps.Neighbors != nil {
		if gw := a.deps.Gateway(ctx); gw != "" {
			if nb, err := a.deps.Neighbors(ctx); err == nil {
				if n, ok := nb[gw]; ok && n.MAC != "" {
					out = append(out, strings.ToLower(n.MAC))
				}
			}
		}
	}
	return out
}

func (a *Agent) setSwitchPort(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	var p switchPortPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !requestIDRe.MatchString(p.RequestID) || p.TargetID == "" {
		a.log.Warn("switch port request ignored: malformed payload")
		return
	}
	started := time.Now()
	item := map[string]any{"type": "switch_port_result", "request_id": p.RequestID, "target_id": p.TargetID, "if_index": p.IfIndex, "op": p.Op}
	report := func(res *snmp.ChangeResult, err error) {
		item["ts"] = time.Now().UTC()
		item["duration_ms"] = time.Since(started).Milliseconds()
		item["ok"] = err == nil
		item["verified"] = res != nil && res.Verified && err == nil
		if res != nil {
			item["method"] = res.Method
			item["before"], item["after"] = res.Before, res.After
			item["rolled_back"] = res.RolledBack
			if len(res.Steps) > 0 {
				item["steps"] = res.Steps
			}
		}
		if err != nil {
			item["error"] = map[string]any{"kind": snmp.ErrKind(err), "message": clip(err.Error(), 400)}
			a.log.Warn("switch port change not done", "target_id", p.TargetID, "if_index", p.IfIndex, "op", p.Op, "kind", snmp.ErrKind(err), "error", clip(err.Error(), 300))
		} else {
			a.log.Info("switch port changed and verified", "target_id", p.TargetID, "if_index", p.IfIndex, "op", p.Op, "method", res.Method)
		}
		a.enqueue(item)
		a.wakeUploader()
	}
	refuse := func(kind, msg string) { report(nil, &snmp.ChangeError{Kind: kind, Message: msg}) }

	now := time.Now()
	if p.ExpiresAt.IsZero() || now.After(p.ExpiresAt) {
		refuse("expired", "the request expired before the collector received it; nothing was changed")
		return
	}
	first, err := a.claimSwitchRequest(p.RequestID, now)
	if err != nil {
		refuse("internal", "the collector could not record the request, so it did not run it")
		return
	}
	if !first {
		a.log.Warn("switch port request already executed; not running it again", "request_id", p.RequestID)
		return
	}
	ch := snmp.PortChange{IfIndex: p.IfIndex, Op: p.Op, VLAN: p.VLAN, Method: p.Method, Override: p.Override}
	switch p.Op {
	case "admin_status":
		if p.AdminUp == nil {
			refuse("invalid_request", "admin_up is missing")
			return
		}
		ch.AdminUp = *p.AdminUp
	case "alias":
		if p.Alias == nil {
			refuse("invalid_request", "alias is missing")
			return
		}
		ch.Alias = *p.Alias
	}
	if err := snmp.ValidateChange(ch); err != nil {
		report(nil, err)
		return
	}
	t, ok := a.switchTarget(p.TargetID)
	if !ok || t.Write == nil {
		refuse("not_configured", "this switch or its write credentials are not in the collector's current configuration")
		return
	}
	if !a.snmpAllowed(t.Host) {
		refuse("out_of_scope", "the switch is outside the ranges this collector is allowed to reach")
		return
	}
	if a.deps.SNMPPoll == nil {
		refuse("unsupported", "Port Detective is not available on this collector")
		return
	}
	disruptive := (p.Op == "admin_status" && !ch.AdminUp) || p.Op == "access_vlan"
	if disruptive && !p.Override {
		ch.ProtectedMACs = a.protectedMACs(ctx)
	}
	switchWriteMu.Lock()
	defer switchWriteMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, switchWriteBudget)
	defer cancel()
	res, err := snmp.ApplyPortChange(wctx, t, *t.Write, ch, snmpTimeout)
	if ctx.Err() != nil {
		return // shutting down; the request expires on the server
	}
	report(res, err)
}
