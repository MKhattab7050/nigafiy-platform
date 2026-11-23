package agent

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nigafiy/sensor/internal/mndp"
)

// Passive MikroTik neighbour discovery (MNDP). The listener only receives: the collector never
// sends a discovery request or announces itself. It runs when this collector's configuration
// allows it (mndp_listen, default ":5678") and the site has not turned it off; a bind failure
// (port in use, not permitted) is reported in the heartbeat and retried every few minutes. No
// firewall rule is ever created: on a host whose firewall drops inbound UDP 5678 nothing arrives,
// which the status shows as "listening, 0 received".

var (
	mndpTick   = 15 * time.Second
	mndpRetry  = 5 * time.Minute
	mndpReport = 60 * time.Second
)

const maxMNDPReport = 1024

type mndpState struct {
	table    *mndp.Table
	prefixes atomic.Pointer[[]netip.Prefix]

	mu       sync.Mutex
	stop     context.CancelFunc
	done     chan struct{}
	failedAt time.Time
	warned   atomic.Bool
}

// mndpAllowed accepts announcements only from addresses inside the authorized scopes.
func (a *Agent) mndpAllowed(ip netip.Addr) bool {
	ps := a.mndp.prefixes.Load()
	if ps == nil {
		return false
	}
	for _, p := range *ps {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// mndpSiteEnabled: the site setting delivered with the configuration (absent = allowed).
func (a *Agent) mndpSiteEnabled() bool {
	rc := a.remoteConfig()
	if rc == nil {
		return false // no scopes yet either; wait for the first configuration
	}
	return rc.MNDP == nil || rc.MNDP.Enabled
}

func (a *Agent) mndpStatus() any {
	if a.mndp.table == nil {
		return nil
	}
	_, st := a.mndp.table.Snapshot(time.Now())
	return st
}

func (a *Agent) mndpLoop(ctx context.Context) {
	st := &a.mndp
	if a.deps.MNDPListen == "" {
		st.table.SetState("disabled", "", "turned off in this collector's configuration (mndp_listen: off)", time.Now())
		return
	}
	tick := time.NewTicker(mndpTick)
	defer tick.Stop()
	reportAt := time.Now()
	for {
		a.applyMNDP(ctx)
		if time.Since(reportAt) >= mndpReport {
			reportAt = time.Now()
			a.reportMNDP()
		}
		select {
		case <-ctx.Done():
			st.mu.Lock()
			if st.stop != nil {
				st.stop()
				<-st.done
			}
			st.mu.Unlock()
			return
		case <-tick.C:
		}
	}
}

func (a *Agent) applyMNDP(ctx context.Context) {
	st := &a.mndp
	prefixes := a.authorizedPrefixes()
	st.prefixes.Store(&prefixes)
	enabled := a.mndpSiteEnabled()

	st.mu.Lock()
	defer st.mu.Unlock()
	if st.done != nil {
		select {
		case <-st.done: // the listener ended on its own: bind failure or receive error
			st.stop, st.done = nil, nil
			st.failedAt = time.Now()
		default:
		}
	}
	running := st.done != nil
	switch {
	case enabled && !running && time.Since(st.failedAt) >= mndpRetry:
		lctx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		st.stop, st.done = cancel, done
		go func() {
			defer close(done)
			if err := st.table.Serve(lctx, a.deps.MNDPListen, a.deps.MNDPOpen); err != nil {
				if !st.warned.Swap(true) {
					a.log.Warn("MikroTik neighbour listener is not running; retrying in a few minutes", "listen", a.deps.MNDPListen, "error", err.Error())
				}
				return
			}
			st.warned.Store(false)
		}()
	case !enabled && running:
		st.stop()
		<-st.done
		st.stop, st.done = nil, nil
		st.table.SetState("disabled", "", "turned off for this site", time.Now())
		a.log.Info("MikroTik neighbour listener stopped: turned off for this site")
	case !enabled:
		st.table.SetState("disabled", "", "turned off for this site", time.Now())
	}
}

// reportMNDP uploads what was heard (only when something was).
func (a *Agent) reportMNDP() {
	list, _ := a.mndp.table.Snapshot(time.Now())
	if len(list) == 0 {
		return
	}
	if len(list) > maxMNDPReport {
		list = list[:maxMNDPReport]
	}
	out := make([]map[string]any, 0, len(list))
	for _, n := range list {
		item := map[string]any{
			"mac": n.MAC, "source_ip": n.SourceIP,
			"first_seen_at": n.FirstSeen.UTC(), "last_seen_at": n.LastSeen.UTC(),
		}
		for k, v := range map[string]string{"identity": n.Identity, "platform": n.Platform, "version": n.Version, "board": n.Board, "interface_name": n.InterfaceName, "ipv4": n.IPv4, "ipv6": n.IPv6} {
			if v != "" {
				item[k] = v
			}
		}
		if n.UptimeSeconds != nil {
			item["uptime_seconds"] = *n.UptimeSeconds
		}
		out = append(out, item)
	}
	a.enqueue(map[string]any{"type": "mndp_neighbors", "ts": time.Now().UTC(), "neighbors": out})
}
