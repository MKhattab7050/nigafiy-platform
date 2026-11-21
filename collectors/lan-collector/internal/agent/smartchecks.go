package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/dhcp"
	"github.com/lan-detective/lan-collector/internal/smart"
)

// Smart network checks (protocol: apps/api/src/common/smart-check-protocol.ts; schedule: the
// `smart_checks` key of the heartbeat configuration, apps/api/src/modules/security/config.ts).
//
// Each check runs on its own interval when enabled, and once more for every "run now" request
// (run_now, told apart by requested_at). One run = one `smart_check` telemetry item carrying the
// block of its own check, a fresh run_id, its trigger and duration, or ok:false with an error kind.
//
//   - rogue_dhcp: one DHCPDISCOVER per authorized interface, offers collected (never answered, no
//     lease taken) — the documented exception to receive-only DHCP.
//   - upnp: SSDP search on the authorized interfaces, read-only IGD actions on the gateways that answer.
//   - wifi: the collector host's own Wi-Fi link and the networks its adapter already lists (no scan).
//   - banners: one GET / on each target's web ports (targets and ports come from the server).
//   - dhcp_fingerprints: what the passive DHCP listener (UDP 67, receive-only) overheard since the last report.
//
// Every address probed is re-checked against the scopes the cloud delivered AND this collector's
// own policy (authorizedPrefixes), whatever the configuration says. A nil Deps function disables its
// check on this collector; a "run now" for it is answered with error kind not_supported.

const (
	checkRogueDHCP    = "rogue_dhcp"
	checkUPnP         = "upnp"
	checkWiFi         = "wifi"
	checkBanners      = "banners"
	checkFingerprints = "dhcp_fingerprints"

	// minSmartInterval protects the network from an over-eager schedule (the banner probe's
	// server interval is 1 s, meaning "whenever devices are due").
	minSmartInterval     = time.Minute
	defaultSmartInterval = 15 * time.Minute
	// A request older than the server's own 15-minute window (a cached configuration after a restart) is not run.
	runNowWindow = 15 * time.Minute
	// A device probed for banners is not probed again by schedule for this long, even while the
	// server has not yet received the result and still lists it as due.
	bannerReprobeGap   = 30 * time.Minute
	maxBannerTargets   = 64
	maxBannerPorts     = 8
	maxSmartDurationMs = 3_600_000
)

var smartCheckOrder = []string{checkRogueDHCP, checkUPnP, checkWiFi, checkBanners, checkFingerprints}

// runnableChecks may be requested with "run now" (RUNNABLE_CHECKS on the server).
var runnableChecks = map[string]bool{checkRogueDHCP: true, checkUPnP: true, checkWiFi: true, checkBanners: true}

// smartErrorKinds is SMART_ERROR_KINDS of the protocol; anything else is reported as internal.
var smartErrorKinds = map[string]bool{"listen_failed": true, "no_interface": true, "not_supported": true, "command_failed": true,
	"not_found": true, "timeout": true, "protocol": true, "internal": true}

// blockKey is the item field that carries each check's data.
var blockKey = map[string]string{checkRogueDHCP: "dhcp", checkUPnP: "upnp", checkWiFi: "wifi", checkBanners: "banners", checkFingerprints: "dhcp_fingerprints"}

type smartSchedule struct {
	Enabled         bool `json:"enabled"`
	IntervalSeconds int  `json:"interval_seconds"`
}

type smartChecksConfig struct {
	RogueDHCP struct {
		smartSchedule
		ListenSeconds float64 `json:"listen_seconds"`
	} `json:"rogue_dhcp"`
	UPnP    smartSchedule `json:"upnp"`
	WiFi    smartSchedule `json:"wifi"`
	Banners struct {
		smartSchedule
		Ports   []int    `json:"ports"`
		Targets []string `json:"targets"`
	} `json:"banners"`
	DHCPFingerprints smartSchedule `json:"dhcp_fingerprints"`
	RunNow           []struct {
		Check       string `json:"check"`
		RequestedAt string `json:"requested_at"`
	} `json:"run_now"`
}

func (c *smartChecksConfig) schedule(check string) smartSchedule {
	switch check {
	case checkRogueDHCP:
		return c.RogueDHCP.smartSchedule
	case checkUPnP:
		return c.UPnP
	case checkWiFi:
		return c.WiFi
	case checkBanners:
		return c.Banners.smartSchedule
	case checkFingerprints:
		return c.DHCPFingerprints
	}
	return smartSchedule{}
}

// smartState is the scheduler's memory. Not persisted: after a restart every enabled check runs once.
type smartState struct {
	mu         sync.Mutex
	last       map[string]time.Time // last start per check
	inFlight   map[string]bool
	handled    map[string]string    // check → requested_at of the last "run now" answered
	bannerSeen map[string]time.Time // address → last banner probe
	lastDrain  time.Time            // last fingerprint report
	wg         sync.WaitGroup
}

func newSmartState() smartState {
	return smartState{last: map[string]time.Time{}, inFlight: map[string]bool{}, handled: map[string]string{}, bannerSeen: map[string]time.Time{}}
}

// smartConfig decodes the smart_checks part of the current configuration; ok=false when absent.
func (a *Agent) smartConfig() (*smartChecksConfig, bool) {
	rc := a.remoteConfig()
	if rc == nil || len(rc.SmartChecks) == 0 || string(rc.SmartChecks) == "null" {
		return nil, false
	}
	var c smartChecksConfig
	if err := json.Unmarshal(rc.SmartChecks, &c); err != nil {
		return nil, false
	}
	return &c, true
}

// smartLoop runs the checks until ctx ends.
func (a *Agent) smartLoop(ctx context.Context) {
	tick := time.NewTicker(a.tuning.CheckTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			a.smartTick(ctx, now)
		}
	}
}

// observeDHCP receives every client message the passive DHCP listener parsed.
func (a *Agent) observeDHCP(m dhcp.ClientMessage) { a.fingerprints.Observe(m) }

// smartTick starts every check that is due at now (scheduled) or requested (run now) and not running.
func (a *Agent) smartTick(ctx context.Context, now time.Time) {
	cfg, ok := a.smartConfig()
	if !ok || !cfg.DHCPFingerprints.Enabled {
		// Nothing overheard is kept while fingerprinting is off.
		a.fingerprints.Drain(now)
	}
	if !ok {
		return // no smart_checks in the configuration: no check runs
	}
	requested := map[string]string{}
	for _, r := range cfg.RunNow {
		at, err := time.Parse(time.RFC3339Nano, r.RequestedAt)
		if !runnableChecks[r.Check] || err != nil || now.Sub(at) > runNowWindow {
			continue
		}
		if r.RequestedAt > requested[r.Check] {
			requested[r.Check] = r.RequestedAt
		}
	}

	s := &a.smartRuns
	for _, check := range smartCheckOrder {
		sch := cfg.schedule(check)
		s.mu.Lock()
		manualAt, manual := requested[check]
		manual = manual && s.handled[check] != manualAt
		due := sch.Enabled && (s.last[check].IsZero() || now.Sub(s.last[check]) >= smartInterval(sch.IntervalSeconds))
		busy := s.inFlight[check]
		s.mu.Unlock()
		if busy || (!manual && !due) {
			continue // a pending "run now" waits for the running one to finish
		}
		trigger := "scheduled"
		if manual {
			trigger = "manual"
		}
		run, skip := a.prepareSmartCheck(check, cfg, trigger, now)
		if skip {
			continue
		}
		s.mu.Lock()
		s.last[check] = now
		s.inFlight[check] = true
		if manual {
			s.handled[check] = manualAt
		}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() {
				s.mu.Lock()
				delete(s.inFlight, check)
				s.mu.Unlock()
			}()
			a.runSmartCheck(ctx, check, trigger, run)
		}()
	}
}

func smartInterval(seconds int) time.Duration {
	return clamp(seconds, minSmartInterval, defaultSmartInterval)
}

// smartRun is one prepared run: it returns the check's block (nil when there is none) or an error.
type smartRun func(ctx context.Context) (block any, err error)

// smartError is a failure with a protocol error kind; the block may still carry partial data.
type smartError struct{ kind, message string }

func (e *smartError) Error() string { return e.message }

// prepareSmartCheck binds a run to the configuration of this tick. skip=true when a scheduled
// run has nothing to do (no banner target due).
func (a *Agent) prepareSmartCheck(check string, cfg *smartChecksConfig, trigger string, now time.Time) (smartRun, bool) {
	unsupported := func(what string) smartRun {
		return func(context.Context) (any, error) {
			return nil, &smartError{"not_supported", what + " is not available on this collector"}
		}
	}
	switch check {
	case checkRogueDHCP:
		if a.deps.SmartDHCP == nil {
			return unsupported("the rogue DHCP check"), trigger == "scheduled"
		}
		listen := time.Duration(cfg.RogueDHCP.ListenSeconds * float64(time.Second))
		listen = min(max(listen, time.Second), 30*time.Second)
		return func(ctx context.Context) (any, error) { return a.runRogueDHCP(ctx, listen) }, false
	case checkUPnP:
		if a.deps.SmartUPnP == nil {
			return unsupported("the UPnP audit"), trigger == "scheduled"
		}
		return a.runUPnP, false
	case checkWiFi:
		if a.deps.SmartWiFi == nil {
			return unsupported("the Wi-Fi analyzer"), trigger == "scheduled"
		}
		return a.runWiFi, false
	case checkBanners:
		if a.deps.SmartBanners == nil {
			return unsupported("the banner probe"), trigger == "scheduled"
		}
		targets := a.bannerTargets(cfg.Banners.Targets, trigger == "scheduled", now)
		if trigger == "scheduled" && len(targets) == 0 {
			return nil, true
		}
		ports := bannerPorts(cfg.Banners.Ports)
		return func(ctx context.Context) (any, error) { return a.runBanners(ctx, targets, ports) }, false
	case checkFingerprints:
		since := a.smartRuns.lastDrain
		a.smartRuns.lastDrain = now
		return func(context.Context) (any, error) { return a.runFingerprints(since) }, false
	}
	return nil, true
}

// runSmartCheck runs one check and reports it as one smart_check item, in its own batch.
func (a *Agent) runSmartCheck(ctx context.Context, check, trigger string, run smartRun) {
	started := time.Now()
	block, err := func() (block any, err error) {
		defer func() {
			if r := recover(); r != nil {
				block, err = nil, &smartError{"internal", fmt.Sprintf("the check stopped unexpectedly: %v", r)}
			}
		}()
		return run(ctx)
	}()
	if ctx.Err() != nil {
		return // shutting down: an interrupted run is not a result
	}
	item := smartItem(check, trigger, started, time.Now(), block, err)
	a.log.Info("smart check finished", "check", check, "trigger", trigger, "ok", item["ok"], "duration_ms", item["duration_ms"])
	a.spoolSingle(item)
}

// smartItem builds the telemetry item. ts is the end of the run: the server clears "run now"
// requests made up to ts.
func smartItem(check, trigger string, started, finished time.Time, block any, err error) map[string]any {
	ms := finished.Sub(started).Milliseconds()
	ms = min(max(ms, 0), maxSmartDurationMs)
	item := map[string]any{
		"type": "smart_check", "ts": finished.UTC(), "run_id": newUUID(), "check": check, "trigger": trigger,
		"ok": err == nil, "duration_ms": ms,
	}
	if block != nil {
		item[blockKey[check]] = block
	}
	if err != nil {
		kind, msg := "internal", err.Error()
		var se *smartError
		var we *smart.WiFiError
		switch {
		case errors.As(err, &se):
			kind, msg = se.kind, se.message
		case errors.As(err, &we):
			kind, msg = we.Kind, we.Message
		case errors.Is(err, context.DeadlineExceeded):
			kind, msg = "timeout", "the check did not finish in time"
		}
		if !smartErrorKinds[kind] {
			kind = "internal"
		}
		item["error"] = map[string]any{"kind": kind, "message": printable(msg, 400)}
	}
	return item
}

// smartInterfaces are the host's interfaces inside the authorized scopes, each with its scope id.
func (a *Agent) smartInterfaces(allowed []netip.Prefix) []smart.DHCPInterface {
	list := smart.Interfaces
	if a.deps.SmartInterfaces != nil {
		list = a.deps.SmartInterfaces
	}
	var out []smart.DHCPInterface
	for _, i := range list(allowed) {
		if i.Address.Is4() && inPrefixes(i.Address, allowed) { // re-checked whatever the lister returned
			out = append(out, i)
		}
	}
	return out
}

func inPrefixes(a netip.Addr, prefixes []netip.Prefix) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// scopeIDOf is the id of the delivered scope an address lies in (empty when it is not a UUID).
func (a *Agent) scopeIDOf(addr netip.Addr) string {
	rc := a.remoteConfig()
	if rc == nil {
		return ""
	}
	for _, sc := range rc.Discovery.Scopes {
		if p, err := a.policy.Check(sc.CIDR); err == nil && p.Contains(addr) && requestIDRe.MatchString(sc.ID) {
			return sc.ID
		}
	}
	return ""
}

func (a *Agent) runRogueDHCP(ctx context.Context, listen time.Duration) (any, error) {
	ifaces := a.smartInterfaces(a.authorizedPrefixes())
	if len(ifaces) == 0 {
		return nil, &smartError{"no_interface", smart.ErrNoInterface.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, listen+15*time.Second)
	defer cancel()
	results := a.deps.SmartDHCP(ctx, ifaces, listen)
	listened := 0
	firstErr := ""
	for i := range results {
		if results[i].Offers == nil {
			results[i].Offers = []smart.DHCPOffer{}
		}
		if addr, err := netip.ParseAddr(results[i].Address); err == nil {
			results[i].ScopeID = a.scopeIDOf(addr)
		}
		if results[i].ListenError == "" {
			listened++
		} else if firstErr == "" {
			firstErr = results[i].ListenError
		}
	}
	block := map[string]any{"interfaces": results}
	if listened == 0 {
		return block, &smartError{"listen_failed", "could not listen for DHCP offers on any interface: " + firstErr}
	}
	return block, nil
}

func (a *Agent) runUPnP(ctx context.Context) (any, error) {
	allowed := a.authorizedPrefixes()
	ifaces := a.smartInterfaces(allowed)
	if len(ifaces) == 0 {
		return nil, &smartError{"no_interface", smart.ErrNoInterface.Error()}
	}
	locals := make([]netip.Addr, 0, len(ifaces))
	for _, i := range ifaces {
		locals = append(locals, i.Address)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	gateways := []smart.UPnPGateway{}
	for _, g := range a.deps.SmartUPnP(ctx, locals, allowed) {
		if addr, err := netip.ParseAddr(g.Address); err == nil && addr.Is4() && inPrefixes(addr, allowed) && len(gateways) < 8 {
			if g.Mappings == nil {
				g.Mappings = []smart.UPnPMapping{}
			}
			gateways = append(gateways, g)
		}
	}
	return map[string]any{"gateways": gateways}, nil
}

func (a *Agent) runWiFi(ctx context.Context) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := a.deps.SmartWiFi(ctx)
	if err != nil {
		return nil, err
	}
	r.Normalize()
	return r, nil
}

// bannerTargets parses the server's targets, keeps authorized IPv4 addresses and, for a scheduled
// run, leaves out the ones this collector probed recently.
func (a *Agent) bannerTargets(raw []string, scheduled bool, now time.Time) []netip.Addr {
	allowed := a.authorizedPrefixes()
	a.smartRuns.mu.Lock()
	defer a.smartRuns.mu.Unlock()
	for ip, at := range a.smartRuns.bannerSeen {
		if now.Sub(at) >= bannerReprobeGap {
			delete(a.smartRuns.bannerSeen, ip)
		}
	}
	seen := map[netip.Addr]bool{}
	var out []netip.Addr
	for _, s := range raw {
		addr, err := netip.ParseAddr(s)
		if err != nil || !addr.Is4() || seen[addr] || !inPrefixes(addr, allowed) {
			continue
		}
		if _, recent := a.smartRuns.bannerSeen[addr.String()]; recent && scheduled {
			continue
		}
		seen[addr] = true
		out = append(out, addr)
		if len(out) >= maxBannerTargets {
			break
		}
	}
	for _, addr := range out {
		a.smartRuns.bannerSeen[addr.String()] = now
	}
	return out
}

// bannerPorts keeps valid ports from the configuration, in order, without repeats.
func bannerPorts(raw []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, p := range raw {
		if p >= 1 && p <= 65535 && !seen[p] && len(out) < maxBannerPorts {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func (a *Agent) runBanners(ctx context.Context, targets []netip.Addr, ports []int) (any, error) {
	allowed := a.authorizedPrefixes()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	r := smart.BannerReport{Probed: []string{}, Results: []smart.Banner{}}
	if len(targets) > 0 && len(ports) > 0 {
		r = a.deps.SmartBanners(ctx, targets, ports, allowed)
	}
	// Whatever the prober returned, only authorized addresses are reported.
	probed := []string{}
	for _, s := range r.Probed {
		if addr, err := netip.ParseAddr(s); err == nil && addr.Is4() && inPrefixes(addr, allowed) && len(probed) < maxBannerTargets {
			probed = append(probed, s)
		}
	}
	results := []smart.Banner{}
	for _, b := range r.Results {
		if addr, err := netip.ParseAddr(b.IP); err == nil && addr.Is4() && inPrefixes(addr, allowed) && len(results) < 256 {
			results = append(results, b)
		}
	}
	return smart.BannerReport{Probed: probed, Results: results}, nil
}

func (a *Agent) runFingerprints(since time.Time) (any, error) {
	if a.deps.DHCPListen == "" {
		return nil, &smartError{"not_supported", "passive DHCP listening is turned off on this collector"}
	}
	if !a.dhcpListening {
		return nil, &smartError{"listen_failed", printable("the passive DHCP listener is not running: "+a.dhcpListenErr, 400)}
	}
	return map[string]any{"clients": a.fingerprints.Drain(since)}, nil
}

// cacheableSmartChecks strips "run now" requests from the configuration written to disk: a
// request is answered while it is fresh, never replayed from the cache after a restart.
func cacheableSmartChecks(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	delete(m, "run_now")
	out, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return out
}
