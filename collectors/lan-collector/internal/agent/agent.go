// Package agent wires the collector together: enrollment, heartbeat/config polling, scheduled
// discovery, monitoring checks, and buffered upload. Every loop honours context cancellation.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/config"
	"github.com/lan-detective/lan-collector/internal/dhcp"
	"github.com/lan-detective/lan-collector/internal/discovery"
	"github.com/lan-detective/lan-collector/internal/identify"
	"github.com/lan-detective/lan-collector/internal/netinfo"
	"github.com/lan-detective/lan-collector/internal/probe"
	"github.com/lan-detective/lan-collector/internal/scope"
	"github.com/lan-detective/lan-collector/internal/spool"
	"github.com/lan-detective/lan-collector/internal/wol"
)

const (
	autoGateway   = "auto:gateway"
	maxQueueItems = 5000 // in-memory items awaiting the next flush to disk
	batchSize     = 200
	maxChecks     = 200
	checkWorkers  = 8
)

// Deps are the collector's contacts with the outside world, injectable for tests.
type Deps struct {
	Prober      discovery.Prober
	ICMPCheck   func(ctx context.Context, ip string) probe.Result
	TCPCheck    func(ctx context.Context, host string, port int) probe.Result
	DNSCheck    func(ctx context.Context, name string) probe.Result
	Neighbors   func(ctx context.Context) (map[string]netinfo.Neighbor, error)
	Gateway     func(ctx context.Context) string
	ReverseName func(ctx context.Context, ip string) string
	LocalMACs   func() map[string]string
	LocalDown   func() []string
	// DHCPListen is the address for passive DHCP name learning (":67"); empty disables it.
	DHCPListen  string
	Identify    func(ctx context.Context, prefix netip.Prefix, hosts []string) map[string]*identify.Info
	ResolveIPv4 func(ctx context.Context, host string) (string, error)
}

// SystemDeps returns the real implementations.
func SystemDeps() Deps {
	icmp := &probe.ICMP{}
	var mu sync.Mutex
	var gw string
	var gwAt time.Time
	return Deps{
		Prober:      icmp,
		ICMPCheck:   icmp.Check,
		TCPCheck:    probe.TCP,
		DNSCheck:    probe.DNS,
		Neighbors:   netinfo.Neighbors,
		LocalMACs:   netinfo.LocalMACs,
		LocalDown:   netinfo.LocalDownAddrs,
		DHCPListen:  ":67",
		Identify:    identify.Run,
		ReverseName: probe.ReverseName,
		Gateway: func(ctx context.Context) string { // cached: routing tables rarely change
			mu.Lock()
			defer mu.Unlock()
			if time.Since(gwAt) > time.Minute {
				gw, gwAt = netinfo.DefaultGateway(ctx), time.Now()
			}
			return gw
		},
		ResolveIPv4: func(ctx context.Context, host string) (string, error) {
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
			if err != nil || len(ips) == 0 {
				return "", errors.New("name does not resolve")
			}
			return ips[0].String(), nil
		},
	}
}

// Tuning holds the floors that protect the monitored network from an over-eager configuration.
type Tuning struct {
	MinHeartbeat         time.Duration
	MinDiscoveryInterval time.Duration
	MinCheckInterval     time.Duration
	FlushInterval        time.Duration
	CheckTick            time.Duration
	MaxBackoff           time.Duration
}

func DefaultTuning() Tuning {
	return Tuning{
		MinHeartbeat:         10 * time.Second,
		MinDiscoveryInterval: 60 * time.Second,
		MinCheckInterval:     10 * time.Second,
		FlushInterval:        10 * time.Second,
		CheckTick:            time.Second,
		MaxBackoff:           5 * time.Minute,
	}
}

type Agent struct {
	cfg     *config.Config
	client  *cloud.Client
	spool   *spool.Spool
	deps    Deps
	log     *slog.Logger
	version string
	started time.Time
	tuning  Tuning
	policy  scope.Policy

	mu        sync.Mutex
	remote    *cloud.RemoteConfig
	queue     []json.RawMessage
	completed []string
	seenCmds  map[string]bool
	refused   map[string]bool

	dhcp     *dhcp.Table
	scan     chan string
	checkNow chan string
	wake     chan struct{}
}

func New(cfg *config.Config, deps Deps, log *slog.Logger, version string, tuning Tuning) (*Agent, error) {
	client, err := cloud.New(cfg.ServerURL, cfg.CAFile, version)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	sp, err := spool.Open(filepath.Join(cfg.StateDir, "spool"), cfg.SpoolMaxBatches)
	if err != nil {
		return nil, err
	}
	return &Agent{
		cfg: cfg, client: client, spool: sp, deps: deps, log: log, version: version, started: time.Now(), tuning: tuning,
		policy:   scope.Policy{MinPrefixBits: config.MinScopePrefixBits, Allowed: cfg.Allowed(), AllowLoopback: cfg.AllowLoopbackScopes},
		seenCmds: map[string]bool{}, refused: map[string]bool{}, dhcp: dhcp.NewTable(),
		scan: make(chan string, 4), checkNow: make(chan string, 4), wake: make(chan struct{}, 1),
	}, nil
}

// Run blocks until ctx is cancelled. It returns an error only for conditions that retrying
// cannot fix (for example a refused enrollment token).
func (a *Agent) Run(ctx context.Context) error {
	if err := a.ensureEnrolled(ctx); err != nil {
		return err
	}
	a.loadCachedConfig()
	if a.deps.DHCPListen != "" {
		// Passive only: listens for the names devices broadcast when they join. Never sends.
		err := dhcp.Listen(ctx, a.deps.DHCPListen, a.dhcp, func(r dhcp.Request) {
			a.log.Info("learned a device name from DHCP", "mac", r.MAC, "hostname", r.Hostname, "vendor_class", r.VendorClass)
		})
		if err != nil {
			a.log.Warn("passive DHCP name learning is off: cannot listen on the DHCP port (needs CAP_NET_BIND_SERVICE on Linux; on Windows no local DHCP server and an inbound firewall rule for UDP 67)", "error", err.Error())
		} else {
			a.log.Info("passive DHCP name learning is on", "listen", a.deps.DHCPListen)
		}
	}

	var wg sync.WaitGroup
	for _, loop := range []func(context.Context){a.heartbeatLoop, a.discoveryLoop, a.checkLoop, a.uploadLoop} {
		wg.Add(1)
		go func(fn func(context.Context)) {
			defer wg.Done()
			fn(ctx)
		}(loop)
	}
	wg.Wait()
	// Graceful shutdown: whatever was measured but not yet uploaded goes to disk for the next start.
	a.flushQueueToSpool()
	a.log.Info("collector stopped", "buffered_batches", a.spool.Depth())
	return nil
}

// ── enrollment ──────────────────────────────────────────────────────────────

type credentialFile struct {
	CollectorID string `json:"collector_id"`
	Credential  string `json:"credential"`
}

func (a *Agent) credentialPath() string { return filepath.Join(a.cfg.StateDir, "credential.json") }

func (a *Agent) ensureEnrolled(ctx context.Context) error {
	if raw, err := os.ReadFile(a.credentialPath()); err == nil {
		var c credentialFile
		if json.Unmarshal(raw, &c) == nil && c.Credential != "" {
			a.client.SetCredential(c.Credential)
			a.log.Info("using stored collector identity", "collector_id", c.CollectorID)
			return nil
		}
		return fmt.Errorf("state file %s is corrupt; delete it and enroll again with a new token", a.credentialPath())
	}
	if a.cfg.EnrollmentToken == "" {
		return errors.New("this collector is not enrolled: provide an enrollment token (LAN_COLLECTOR_ENROLLMENT_TOKEN) created in LAN Detective under Collectors")
	}
	host, _ := os.Hostname()
	bo := cloud.Backoff{Min: 2 * time.Second, Max: a.tuning.MaxBackoff}
	for {
		resp, err := a.client.Enroll(ctx, cloud.EnrollRequest{EnrollmentToken: a.cfg.EnrollmentToken, Hostname: host, Version: a.version, OS: runtime.GOOS, Arch: runtime.GOARCH})
		switch {
		case err == nil:
			raw, _ := json.Marshal(credentialFile{CollectorID: resp.CollectorID, Credential: resp.Credential})
			// 0600: the credential is this collector's identity.
			if err := os.WriteFile(a.credentialPath(), raw, 0o600); err != nil {
				return fmt.Errorf("store credential: %w", err)
			}
			a.client.SetCredential(resp.Credential)
			a.log.Info("enrolled", "collector_id", resp.CollectorID)
			return nil
		case errors.Is(err, cloud.ErrUnauthorized), errors.Is(err, cloud.ErrRejected):
			return errors.New("enrollment refused: the token is invalid, already used, or expired — create a new one in LAN Detective")
		}
		wait := bo.Next()
		a.log.Warn("enrollment failed, will retry", "error", err.Error(), "retry_in", wait.Round(time.Second).String())
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// ── remote configuration ────────────────────────────────────────────────────

func (a *Agent) configPath() string { return filepath.Join(a.cfg.StateDir, "remote-config.json") }

// The last configuration is cached on disk so monitoring resumes after a restart even while the
// cloud is unreachable.
func (a *Agent) loadCachedConfig() {
	raw, err := os.ReadFile(a.configPath())
	if err != nil {
		return
	}
	var rc cloud.RemoteConfig
	if json.Unmarshal(raw, &rc) == nil {
		a.mu.Lock()
		a.remote = &rc
		a.mu.Unlock()
		a.log.Info("loaded cached configuration", "scopes", len(rc.Discovery.Scopes), "checks", len(rc.Checks))
	}
}

func (a *Agent) remoteConfig() *cloud.RemoteConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.remote
}

func clamp(seconds int, floor time.Duration, fallback time.Duration) time.Duration {
	d := time.Duration(seconds) * time.Second
	if seconds <= 0 {
		d = fallback
	}
	if d < floor {
		d = floor
	}
	return d
}

// ── heartbeat ───────────────────────────────────────────────────────────────

func (a *Agent) heartbeatLoop(ctx context.Context) {
	bo := cloud.Backoff{Min: 2 * time.Second, Max: a.tuning.MaxBackoff}
	connected := true
	for {
		wait := a.heartbeatOnce(ctx, &bo, &connected)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (a *Agent) heartbeatOnce(ctx context.Context, bo *cloud.Backoff, connected *bool) time.Duration {
	host, _ := os.Hostname()
	a.mu.Lock()
	acks := append([]string{}, a.completed...)
	a.mu.Unlock()

	resp, err := a.client.Heartbeat(ctx, cloud.HeartbeatRequest{
		Version: a.version, Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH,
		UptimeSeconds:     int64(time.Since(a.started).Seconds()),
		GatewayIP:         a.deps.Gateway(ctx),
		Interfaces:        interfacesOrEmpty(),
		SpoolDepth:        a.spool.Depth(),
		CompletedCommands: acks,
	})
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		if errors.Is(err, cloud.ErrUnauthorized) {
			a.log.Error("the cloud refused this collector's credential (revoked?). Monitoring continues locally; re-enroll to resume uploads")
			return a.tuning.MaxBackoff
		}
		wait := bo.Next()
		if *connected {
			a.log.Warn("lost contact with the cloud; monitoring continues and results are buffered", "error", err.Error())
			*connected = false
		}
		a.log.Debug("heartbeat failed", "error", err.Error(), "retry_in", wait.String())
		return wait
	}
	bo.Reset()
	if !*connected {
		a.log.Info("contact with the cloud restored", "buffered_batches", a.spool.Depth())
		*connected = true
		a.wakeUploader()
	}

	rc := resp.Config
	if len(rc.Checks) > maxChecks {
		rc.Checks = rc.Checks[:maxChecks]
	}
	a.mu.Lock()
	a.remote = &rc
	// Drop acknowledgements the server has now received.
	remaining := a.completed[:0]
	for _, id := range a.completed {
		found := false
		for _, ack := range acks {
			found = found || ack == id
		}
		if !found {
			remaining = append(remaining, id)
		}
	}
	a.completed = remaining
	a.mu.Unlock()
	if raw, err := json.Marshal(rc); err == nil {
		_ = os.WriteFile(a.configPath(), raw, 0o600)
	}

	for _, cmd := range resp.Commands {
		a.mu.Lock()
		seen := a.seenCmds[cmd.ID]
		a.seenCmds[cmd.ID] = true
		a.mu.Unlock()
		if seen {
			continue
		}
		// Closed allow-list of commands. Anything else is ignored — there is no remote execution.
		switch cmd.Kind {
		case "run_discovery":
			select {
			case a.scan <- cmd.ID:
			default:
				a.markCompleted(cmd.ID) // a scan is already queued
			}
		case "run_checks":
			select {
			case a.checkNow <- cmd.ID:
			default:
				a.markCompleted(cmd.ID)
			}
		case "wake_device":
			go a.wakeDevice(cmd)
		default:
			a.log.Warn("ignoring unsupported command", "kind", cmd.Kind)
		}
	}
	return clamp(rc.HeartbeatIntervalSeconds, a.tuning.MinHeartbeat, 30*time.Second)
}

func interfacesOrEmpty() []netinfo.Interface {
	if ifs := netinfo.Interfaces(); ifs != nil {
		return ifs
	}
	return []netinfo.Interface{}
}

// wakeDevice sends a Wake-on-LAN packet. Only to the broadcast address of a scope that is both delivered by
// the cloud and allowed by this collector's own policy; the command is acknowledged either way.
func (a *Agent) wakeDevice(cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	var p struct {
		MAC       string `json:"mac"`
		Broadcast string `json:"broadcast"`
	}
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		a.log.Warn("wake request ignored: malformed payload")
		return
	}
	mac, err := wol.ParseMAC(p.MAC)
	if err != nil {
		a.log.Warn("wake request ignored", "reason", err.Error())
		return
	}
	broadcast, err := netip.ParseAddr(p.Broadcast)
	if err != nil {
		a.log.Warn("wake request ignored: bad broadcast address")
		return
	}
	var allowed []netip.Prefix
	if rc := a.remoteConfig(); rc != nil {
		for _, sc := range rc.Discovery.Scopes {
			if prefix, err := a.policy.Check(sc.CIDR); err == nil {
				allowed = append(allowed, prefix)
			}
		}
	}
	if err := wol.Send(mac, broadcast, allowed); err != nil {
		a.log.Warn("wake request not sent", "mac", mac.String(), "error", err.Error())
		return
	}
	a.log.Info("sent Wake-on-LAN packet", "mac", mac.String(), "broadcast", broadcast.String())
}

func (a *Agent) markCompleted(id string) {
	a.mu.Lock()
	a.completed = append(a.completed, id)
	a.mu.Unlock()
}

// ── discovery ───────────────────────────────────────────────────────────────

func (a *Agent) discoveryLoop(ctx context.Context) {
	// Wait for a configuration before the first sweep.
	for a.remoteConfig() == nil {
		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-a.scan:
			a.runDiscovery(ctx, "manual")
			a.markCompleted(id)
		case <-timer.C:
			a.runDiscovery(ctx, "scheduled")
		}
		interval := a.tuning.MinDiscoveryInterval
		if rc := a.remoteConfig(); rc != nil {
			interval = clamp(rc.Discovery.IntervalSeconds, a.tuning.MinDiscoveryInterval, 5*time.Minute)
		}
		timer.Reset(interval)
	}
}

func (a *Agent) runDiscovery(ctx context.Context, trigger string) {
	rc := a.remoteConfig()
	if rc == nil {
		return
	}
	for _, sc := range rc.Discovery.Scopes {
		prefix, err := a.policy.Check(sc.CIDR)
		if err != nil {
			a.mu.Lock()
			already := a.refused[sc.CIDR]
			a.refused[sc.CIDR] = true
			a.mu.Unlock()
			if !already {
				a.log.Warn("refusing to probe a scope delivered by the cloud", "cidr", sc.CIDR, "reason", err.Error())
			}
			continue
		}
		res := discovery.Sweep(ctx, prefix, a.deps.Prober, discovery.Options{
			Concurrency: a.cfg.Limits.MaxConcurrency,
			PPS:         a.cfg.Limits.MaxPPS,
			Timeout:     time.Duration(a.cfg.Limits.PingTimeoutMs) * time.Millisecond,
			Neighbors:   a.deps.Neighbors,
			ReverseName: a.deps.ReverseName,
			LocalMACs:   a.deps.LocalMACs,
			LocalDown:   a.deps.LocalDown,
			DHCPName: func(mac string) (string, string, bool) {
				l, ok := a.dhcp.Lookup(mac)
				return l.Hostname, l.VendorClass, ok
			},
			Identify: a.deps.Identify,
		})
		if !res.Complete {
			return // interrupted: reporting a partial sweep would make present devices look offline
		}
		a.log.Info("discovery sweep finished", "cidr", prefix.String(), "trigger", trigger, "probed", res.HostsProbed,
			"found", len(res.Hosts), "duration", res.FinishedAt.Sub(res.StartedAt).Round(time.Millisecond).String())
		a.enqueue(map[string]any{
			"type": "discovery_run", "run_id": newUUID(), "scope_id": sc.ID, "trigger": trigger,
			"started_at": res.StartedAt, "finished_at": res.FinishedAt, "hosts_probed": res.HostsProbed, "hosts": res.Hosts,
		})
	}
	a.wakeUploader()
}

// ── monitoring checks ───────────────────────────────────────────────────────

func (a *Agent) checkLoop(ctx context.Context) {
	ticker := time.NewTicker(a.tuning.CheckTick)
	defer ticker.Stop()
	lastRun := map[string]time.Time{}
	var inFlight sync.Map
	workers := make(chan struct{}, checkWorkers)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-a.checkNow:
			// "Run diagnostics now": make every check due on the next tick.
			clear(lastRun)
			a.markCompleted(id)
			a.log.Info("running all checks now on request")
		case now := <-ticker.C:
			rc := a.remoteConfig()
			if rc == nil {
				continue
			}
			for _, chk := range rc.Checks {
				interval := clamp(chk.IntervalSeconds, a.tuning.MinCheckInterval, time.Minute)
				if now.Sub(lastRun[chk.ID]) < interval {
					continue
				}
				if _, busy := inFlight.LoadOrStore(chk.ID, true); busy {
					continue
				}
				select {
				case workers <- struct{}{}:
				default:
					inFlight.Delete(chk.ID)
					continue // all workers busy: try again on the next tick
				}
				lastRun[chk.ID] = now
				wg.Add(1)
				go func(chk cloud.Check) {
					defer wg.Done()
					defer func() { <-workers; inFlight.Delete(chk.ID) }()
					a.runCheck(ctx, chk)
				}(chk)
			}
		}
	}
}

func (a *Agent) runCheck(ctx context.Context, chk cloud.Check) {
	ts := time.Now().UTC()
	var res probe.Result
	switch chk.Kind {
	case "icmp":
		target := chk.Target
		if target == autoGateway {
			if target = a.deps.Gateway(ctx); target == "" {
				res = probe.Result{Error: "the collector host has no IPv4 default gateway"}
				break
			}
		} else if net.ParseIP(target) == nil {
			ip, err := a.deps.ResolveIPv4(ctx, target)
			if err != nil {
				res = probe.Result{Error: err.Error()}
				break
			}
			target = ip
		}
		res = a.deps.ICMPCheck(ctx, target)
	case "tcp":
		if chk.Port == nil {
			return
		}
		res = a.deps.TCPCheck(ctx, chk.Target, *chk.Port)
	case "dns":
		res = a.deps.DNSCheck(ctx, chk.Target)
	default:
		return // unknown kinds are ignored, never guessed at
	}
	if ctx.Err() != nil {
		return // shutting down: a cancelled probe is not a failed check
	}
	item := map[string]any{"type": "check_result", "check_id": chk.ID, "ts": ts, "ok": res.OK}
	if res.LatencyMs != nil {
		item["latency_ms"] = *res.LatencyMs
	}
	if res.LossPct != nil {
		item["loss_pct"] = *res.LossPct
	}
	if res.JitterMs != nil {
		item["jitter_ms"] = *res.JitterMs
	}
	if res.Error != "" {
		item["error"] = res.Error
	}
	if res.Resolved != "" {
		item["resolved_target"] = res.Resolved
	}
	a.enqueue(item)
}

// ── buffering and upload ────────────────────────────────────────────────────

func (a *Agent) enqueue(item map[string]any) {
	raw, err := json.Marshal(item)
	if err != nil {
		return
	}
	a.mu.Lock()
	if len(a.queue) >= maxQueueItems {
		a.queue = a.queue[1:]
	}
	a.queue = append(a.queue, raw)
	a.mu.Unlock()
}

func (a *Agent) wakeUploader() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *Agent) flushQueueToSpool() {
	a.mu.Lock()
	items := a.queue
	a.queue = nil
	a.mu.Unlock()
	for len(items) > 0 {
		n := min(batchSize, len(items))
		id := newUUID()
		raw, err := json.Marshal(map[string]any{"batch_id": id, "sent_at": time.Now().UTC(), "items": items[:n]})
		if err == nil {
			dropped, err := a.spool.Put(id, raw)
			if err != nil {
				a.log.Error("cannot write to the local buffer", "error", err.Error())
			}
			if dropped > 0 {
				a.log.Warn("local buffer is full; oldest unsent batches were dropped", "dropped", dropped)
			}
		}
		items = items[n:]
	}
}

func (a *Agent) uploadLoop(ctx context.Context) {
	bo := cloud.Backoff{Min: 2 * time.Second, Max: a.tuning.MaxBackoff}
	timer := time.NewTimer(a.tuning.FlushInterval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-a.wake:
		}
		a.flushQueueToSpool()
		wait := a.tuning.FlushInterval
	drain:
		for ctx.Err() == nil {
			name, data, ok, err := a.spool.Oldest()
			if err != nil || !ok {
				break
			}
			err = a.client.SendBatch(ctx, data)
			switch {
			case err == nil:
				_ = a.spool.Remove(name)
				bo.Reset()
			case errors.Is(err, cloud.ErrRejected):
				// The server will never accept this batch; keeping it would block everything behind it.
				a.log.Error("the cloud rejected a telemetry batch; discarding it", "batch", name, "error", err.Error())
				_ = a.spool.Remove(name)
			case errors.Is(err, cloud.ErrUnauthorized):
				wait = a.tuning.MaxBackoff
				break drain
			default:
				wait = bo.Next()
				a.log.Debug("upload failed; batch stays buffered", "error", err.Error(), "buffered_batches", a.spool.Depth(), "retry_in", wait.String())
				break drain
			}
		}
		timer.Reset(wait)
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
