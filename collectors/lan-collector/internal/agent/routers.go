package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/router"
)

// Router control: the site's routers are read periodically (identity, capabilities, client list,
// blocks in effect) and changed only on an explicit command from an administrator (block, unblock,
// rate limit, schedule). Every operation opens the driver once, re-checks the router address
// against this collector's own scope policy (router.Open → router.Authorize), runs one operation,
// and always closes (logs out). One operation per router at a time.

const (
	cmdRouterRefresh          = "router_refresh"
	cmdRouterFetchCertificate = "router_fetch_certificate"
	cmdRouterBlock            = "router_block"
	cmdRouterUnblock          = "router_unblock"
	cmdRouterRateLimit        = "router_rate_limit"
	cmdRouterSchedule         = "router_schedule"
	cmdRouterRename           = "router_rename"
	cmdRouterWiFi             = "router_wifi"
	cmdRouterReservation      = "router_reservation"
	cmdRouterPortForward      = "router_port_forward"
	cmdRouterReboot           = "router_reboot"

	routerTick            = 5 * time.Second
	minRouterInterval     = 2 * time.Minute
	defaultRouterInterval = 5 * time.Minute
	routerOpBudget        = 2 * time.Minute
	routerCloseBudget     = 15 * time.Second
	maxRouterTargets      = 16
	maxRouterClients      = 1024
	maxRouterBlocks       = 512
	// When the router locks the account without saying for how long, logins pause this long.
	defaultLockoutPause = 30 * time.Minute
)

// routerTarget is one router as delivered in the heartbeat. Username and password live only in
// memory (the heartbeat configuration); they are never logged, cached on disk or reported.
type routerTarget struct {
	ID        string `json:"id"`
	Vendor    string `json:"vendor"`
	Address   string `json:"address"`
	Port      int    `json:"port,omitempty"`
	Transport string `json:"transport"`
	PinSHA256 string `json:"pin_sha256,omitempty"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	// CredentialsVersion changes whenever the administrator replaces the credentials; a login
	// suspension caused by rejected credentials ends when it changes.
	CredentialsVersion string `json:"credentials_version"`
	IntervalSeconds    int    `json:"refresh_interval_seconds"`
}

type routersConfig struct {
	Targets []routerTarget `json:"targets"`
}

// routerPayload is the parameter set of every router_* command. Only the fields of the command's
// own kind are used.
type routerPayload struct {
	RequestID string            `json:"request_id"`
	RouterID  string            `json:"router_id"`
	MAC       string            `json:"mac,omitempty"`
	Address   string            `json:"address,omitempty"` // router_fetch_certificate
	Port      int               `json:"port,omitempty"`    // router_fetch_certificate
	Clear     bool              `json:"clear,omitempty"`   // rate limit / schedule: remove instead of set
	Limit     *router.RateLimit `json:"limit,omitempty"`
	Windows   []router.Window   `json:"windows,omitempty"`
	// Router controls (docs/features/router-controls.md).
	Name        string              `json:"name,omitempty"`    // router_rename
	WiFiID      string              `json:"wifi_id,omitempty"` // router_wifi
	Enabled     *bool               `json:"enabled,omitempty"` // router_wifi
	IP          string              `json:"ip,omitempty"`      // router_reservation
	PortForward *router.PortForward `json:"port_forward,omitempty"`
}

type loginSuspension struct {
	credentialsVersion string
	until              time.Time // zero: until the credentials change
	reason             string
}

type routerState struct {
	mu        sync.Mutex
	busy      map[string]chan struct{}
	suspended map[string]loginSuspension
	last      map[string]time.Time
	refused   map[string]bool
}

func newRouterState() routerState {
	return routerState{busy: map[string]chan struct{}{}, suspended: map[string]loginSuspension{}, last: map[string]time.Time{}, refused: map[string]bool{}}
}

// acquire serialises operations on one router. It returns false if ctx ends first.
func (s *routerState) acquire(ctx context.Context, id string) (func(), bool) {
	s.mu.Lock()
	ch := s.busy[id]
	if ch == nil {
		ch = make(chan struct{}, 1)
		s.busy[id] = ch
	}
	s.mu.Unlock()
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, true
	case <-ctx.Done():
		return nil, false
	}
}

// suspension returns the active login suspension for t, if any. A suspension ends when the
// administrator replaces the credentials or (for a router lock-out) when the wait has passed.
func (s *routerState) suspension(t routerTarget, now time.Time) (loginSuspension, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sp, ok := s.suspended[t.ID]
	if !ok {
		return loginSuspension{}, false
	}
	if sp.credentialsVersion != t.CredentialsVersion || (!sp.until.IsZero() && !now.Before(sp.until)) {
		delete(s.suspended, t.ID)
		return loginSuspension{}, false
	}
	return sp, true
}

func (s *routerState) suspend(t routerTarget, until time.Time, reason string) {
	s.mu.Lock()
	s.suspended[t.ID] = loginSuspension{credentialsVersion: t.CredentialsVersion, until: until, reason: reason}
	s.mu.Unlock()
}

// prune drops per-router state for router IDs no longer in activeIDs. In-flight
// busy channels (len(ch) > 0) are retained until the running operation releases them.
func (s *routerState) prune(activeIDs map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, ch := range s.busy {
		if !activeIDs[id] && len(ch) == 0 {
			delete(s.busy, id)
		}
	}
	for id := range s.suspended {
		if !activeIDs[id] {
			delete(s.suspended, id)
		}
	}
	for id := range s.last {
		if !activeIDs[id] {
			delete(s.last, id)
		}
	}
	for id := range s.refused {
		if !activeIDs[id] {
			delete(s.refused, id)
		}
	}
}

func (a *Agent) routerTargets() []routerTarget {
	rc := a.remoteConfig()
	if rc == nil || len(rc.Routers) == 0 {
		return nil
	}
	var c routersConfig
	if json.Unmarshal(rc.Routers, &c) != nil {
		return nil
	}
	if len(c.Targets) > maxRouterTargets {
		c.Targets = c.Targets[:maxRouterTargets]
	}
	return c.Targets
}

func (a *Agent) routerTarget(id string) (routerTarget, bool) {
	for _, t := range a.routerTargets() {
		if t.ID == id {
			return t, true
		}
	}
	return routerTarget{}, false
}

// authorizedPrefixes are the scopes the cloud delivered AND this collector's own policy accepts:
// the same set discovery, SNMP and Wake-on-LAN use.
func (a *Agent) authorizedPrefixes() []netip.Prefix {
	var out []netip.Prefix
	if rc := a.remoteConfig(); rc != nil {
		for _, sc := range rc.Discovery.Scopes {
			if prefix, err := a.policy.Check(sc.CIDR); err == nil {
				out = append(out, prefix)
			}
		}
	}
	return out
}

func (a *Agent) routerOptions() router.Options {
	return router.Options{Authorized: a.authorizedPrefixes(), AllowLoopback: a.cfg.AllowLoopbackScopes}
}

// credentials hands the driver a fresh copy of the password each time it needs to log in.
func (t routerTarget) credentials() router.CredentialSource {
	return func(context.Context) (string, []byte, error) {
		if t.Username == "" || t.Password == "" {
			return "", nil, &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credentials configured for this router"}
		}
		return t.Username, []byte(t.Password), nil
	}
}

func (t routerTarget) target() (router.Target, error) {
	addr, err := netip.ParseAddr(t.Address)
	if err != nil {
		return router.Target{}, router.Errorf(router.ErrInvalidArgument, "target", "router address is not an IP address")
	}
	return router.Target{ID: t.ID, Vendor: t.Vendor, Address: addr, Port: t.Port, Transport: router.Transport(t.Transport), PinSHA256: t.PinSHA256}, nil
}

var routerErrorKinds = []struct {
	err  error
	kind string
}{
	{router.ErrBadCredentials, "bad_credentials"},
	{router.ErrLockedOut, "locked_out"},
	{router.ErrSessionExpired, "session_expired"},
	{router.ErrSessionLimit, "session_limit"},
	{router.ErrUnsupported, "unsupported"},
	{router.ErrUnreachable, "unreachable"},
	{router.ErrNotAuthorized, "not_authorized"},
	{router.ErrCertificate, "certificate"},
	{router.ErrNotFound, "not_found"},
	{router.ErrProtocol, "protocol"},
	{router.ErrInvalidArgument, "invalid_argument"},
	{router.ErrUnknownVendor, "unknown_vendor"},
	{router.ErrRejected, "rejected"},
	{router.ErrCredentialSource, "no_credentials"},
}

func routerErrorKind(err error) string {
	for _, k := range routerErrorKinds {
		if errors.Is(err, k.err) {
			return k.kind
		}
	}
	return "internal"
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// routerError is the wire form of a failure. Router errors never contain secrets (router package
// contract); the message is clipped anyway.
func routerError(kind, message string, retryAfter time.Duration) map[string]any {
	e := map[string]any{"kind": kind, "message": clip(message, 400)}
	if retryAfter > 0 {
		e["retry_after_seconds"] = int(retryAfter.Round(time.Second) / time.Second)
	}
	return e
}

func errorItem(err error) map[string]any {
	var re *router.Error
	var retry time.Duration
	if errors.As(err, &re) {
		retry = re.RetryAfter
	}
	return routerError(routerErrorKind(err), err.Error(), retry)
}

// routerLoop refreshes each configured router on its interval (read-only: identity, capabilities,
// clients, blocks). It never changes anything on a router.
func (a *Agent) routerLoop(ctx context.Context) {
	if a.deps.RouterOpen == nil {
		return
	}
	tick := time.NewTicker(routerTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		targets := a.routerTargets()
		active := make(map[string]bool, len(targets))
		for _, t := range targets {
			active[t.ID] = true
		}
		a.routers.prune(active)
		for _, t := range targets {
			interval := clamp(t.IntervalSeconds, minRouterInterval, defaultRouterInterval)
			a.routers.mu.Lock()
			due := time.Since(a.routers.last[t.ID]) >= interval
			a.routers.mu.Unlock()
			if !due {
				continue
			}
			if _, suspended := a.routers.suspension(t, time.Now()); suspended {
				continue // reported when it happened; never retried until the credentials change or the wait passes
			}
			a.runRouterOp(ctx, t, "refresh", "scheduled", routerPayload{RouterID: t.ID})
			if ctx.Err() != nil {
				return
			}
		}
	}
}

var routerActions = map[string]string{
	cmdRouterRefresh:     "refresh",
	cmdRouterBlock:       "block",
	cmdRouterUnblock:     "unblock",
	cmdRouterRateLimit:   "rate_limit",
	cmdRouterSchedule:    "schedule",
	cmdRouterRename:      "rename",
	cmdRouterWiFi:        "wifi",
	cmdRouterReservation: "reserve",
	cmdRouterPortForward: "add_port_forward",
	cmdRouterReboot:      "reboot",
}

// routerCommand runs one administrator-requested router operation. Acknowledged either way; the
// outcome travels as a router_result telemetry item.
func (a *Agent) routerCommand(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	var p routerPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.RouterID == "" || p.RequestID == "" {
		a.log.Warn("router request ignored: malformed payload", "kind", cmd.Kind)
		return
	}
	if cmd.Kind == cmdRouterFetchCertificate {
		a.fetchRouterCertificate(ctx, p)
		return
	}
	action := routerActions[cmd.Kind]
	if action == "rate_limit" && p.Clear {
		action = "clear_rate_limit"
	}
	if action == "schedule" && p.Clear {
		action = "clear_schedule"
	}
	if action == "reserve" && p.Clear {
		action = "unreserve"
	}
	if action == "add_port_forward" && p.Clear {
		action = "remove_port_forward"
	}
	t, ok := a.routerTarget(p.RouterID)
	if !ok {
		a.reportRouter(map[string]any{"type": "router_result", "ts": time.Now().UTC(), "router_id": p.RouterID, "request_id": p.RequestID,
			"action": action, "trigger": "command", "ok": false,
			"error": routerError("not_configured", "this router is not in the collector's current configuration (disabled, outside the authorized ranges, awaiting a certificate, or logins paused)", 0)})
		return
	}
	a.runRouterOp(ctx, t, action, "command", p)
}

func (a *Agent) reportRouter(item map[string]any) {
	a.enqueue(item)
	a.wakeUploader()
}

func (a *Agent) runRouterOp(ctx context.Context, t routerTarget, action, trigger string, p routerPayload) {
	started := time.Now()
	item := map[string]any{"type": "router_result", "router_id": t.ID, "action": action, "trigger": trigger}
	if p.RequestID != "" {
		item["request_id"] = p.RequestID
	}
	finish := func(err error) {
		if ctx.Err() != nil {
			return // shutting down: the request expires on the server instead of reporting a false failure
		}
		item["ts"] = time.Now().UTC()
		item["duration_ms"] = time.Since(started).Milliseconds()
		item["ok"] = err == nil
		if err != nil {
			item["error"] = errorItem(err)
			a.log.Warn("router operation failed", "router_id", t.ID, "address", t.Address, "action", action, "error", clip(err.Error(), 400))
		} else {
			a.log.Info("router operation done", "router_id", t.ID, "address", t.Address, "action", action,
				"duration", time.Since(started).Round(time.Millisecond).String())
		}
		a.reportRouter(item)
	}
	if a.deps.RouterOpen == nil {
		finish(router.Errorf(router.ErrUnsupported, "open", "router control is not available on this collector"))
		return
	}
	if sp, suspended := a.routers.suspension(t, time.Now()); suspended {
		msg := "logins to this router are paused because it rejected the user name or password; update the credentials in LAN Detective"
		var retry time.Duration
		if !sp.until.IsZero() {
			retry = time.Until(sp.until)
			msg = "logins to this router are paused because it locked the account after failed logins; LAN Detective waits before trying again"
		}
		item["ts"], item["ok"], item["duration_ms"] = time.Now().UTC(), false, 0
		item["error"] = routerError("login_suspended", msg, retry)
		a.reportRouter(item)
		return
	}
	release, ok := a.routers.acquire(ctx, t.ID)
	if !ok {
		return
	}
	defer release()
	a.routers.mu.Lock()
	a.routers.last[t.ID] = time.Now()
	a.routers.mu.Unlock()

	rt, err := t.target()
	if err != nil {
		finish(err)
		return
	}
	d, err := a.deps.RouterOpen(rt, t.credentials(), a.routerOptions())
	if err != nil {
		a.routers.mu.Lock()
		logged := a.routers.refused[t.ID]
		a.routers.refused[t.ID] = true
		a.routers.mu.Unlock()
		if !logged && errors.Is(err, router.ErrNotAuthorized) {
			a.log.Warn("refusing to contact a router outside the authorized ranges", "router_id", t.ID, "address", t.Address)
		}
		finish(err)
		return
	}
	defer func() {
		// Always log out, even when the operation's context ended.
		cctx, cancel := context.WithTimeout(context.Background(), routerCloseBudget)
		if cerr := d.Close(cctx); cerr != nil {
			// A failed logout can leave a session open on the router; single-session routers then
			// refuse the next login ("Duplicated login") until that session times out.
			a.log.Warn("router logout failed", "router_id", t.ID, "address", t.Address, "action", action, "error", cerr.Error())
		}
		cancel()
	}()
	opCtx, cancel := context.WithTimeout(ctx, routerOpBudget)
	defer cancel()
	err = a.routerOperation(opCtx, d, action, p, item)
	var re *router.Error
	switch {
	case errors.Is(err, router.ErrBadCredentials), errors.Is(err, router.ErrCredentialSource):
		a.routers.suspend(t, time.Time{}, "bad_credentials")
	case errors.Is(err, router.ErrLockedOut):
		wait := defaultLockoutPause
		if errors.As(err, &re) && re.RetryAfter > 0 {
			wait = re.RetryAfter
		}
		a.routers.suspend(t, time.Now().Add(wait), "locked_out")
	}
	finish(err)
}

func (a *Agent) routerOperation(ctx context.Context, d router.Driver, action string, p routerPayload, item map[string]any) error {
	mac := func() (string, error) {
		m, err := router.NormalizeMAC(p.MAC)
		if err == nil {
			item["mac"] = m
		}
		return m, err
	}
	switch action {
	case "refresh":
		return refreshRouter(ctx, d, item)
	case "block", "unblock":
		m, err := mac()
		if err != nil {
			return err
		}
		var ch router.Change
		if action == "block" {
			ch, err = d.Block(ctx, m)
		} else {
			ch, err = d.Unblock(ctx, m)
		}
		if err == nil {
			item["change"] = wireChange(ch)
		}
		return err
	case "rate_limit", "clear_rate_limit":
		rl, ok := d.(router.RateLimiter)
		if !ok {
			return router.Errorf(router.ErrUnsupported, "rate_limit", "this router driver cannot limit a device's speed")
		}
		m, err := mac()
		if err != nil {
			return err
		}
		var ch router.Change
		if action == "clear_rate_limit" {
			ch, err = rl.ClearRateLimit(ctx, m)
		} else {
			if p.Limit == nil || p.Limit.DownKbps < 0 || p.Limit.UpKbps < 0 {
				return router.Errorf(router.ErrInvalidArgument, "rate_limit", "no valid limit given")
			}
			ch, err = rl.SetRateLimit(ctx, m, *p.Limit)
		}
		if err == nil {
			item["change"] = wireChange(ch)
		}
		return err
	case "schedule", "clear_schedule":
		sc, ok := d.(router.Scheduler)
		if !ok {
			return router.Errorf(router.ErrUnsupported, "schedule", "this router driver cannot schedule a device's access")
		}
		m, err := mac()
		if err != nil {
			return err
		}
		var ch router.Change
		if action == "clear_schedule" {
			ch, err = sc.ClearSchedule(ctx, m)
		} else {
			if len(p.Windows) == 0 {
				return router.Errorf(router.ErrInvalidArgument, "schedule", "no time windows given")
			}
			ch, err = sc.SetSchedule(ctx, m, p.Windows)
		}
		if err == nil {
			item["change"] = wireChange(ch)
		}
		return err
	case "rename", "wifi", "reserve", "unreserve", "add_port_forward", "remove_port_forward", "reboot":
		ch, err := a.routerControl(ctx, d, action, p, mac)
		if err != nil {
			return err
		}
		item["change"] = wireChange(ch)
		if action != "reboot" {
			// Report what the router shows now, so the UI reflects the router, not the request.
			attachSettings(ctx, d, item)
		}
		return nil
	}
	return router.Errorf(router.ErrInvalidArgument, "command", "unknown router action")
}

func unsupported(op, what string) error {
	return router.Errorf(router.ErrUnsupported, op, "this router driver cannot %s", what)
}

// routerControl runs one of the router controls (docs/features/router-controls.md).
func (a *Agent) routerControl(ctx context.Context, d router.Driver, action string, p routerPayload, mac func() (string, error)) (router.Change, error) {
	switch action {
	case "rename":
		r, ok := d.(router.Renamer)
		if !ok {
			return router.Change{}, unsupported(action, "rename a device")
		}
		m, err := mac()
		if err != nil {
			return router.Change{}, err
		}
		return r.RenameClient(ctx, m, p.Name)
	case "wifi":
		w, ok := d.(router.WiFiController)
		if !ok {
			return router.Change{}, unsupported(action, "turn Wi-Fi networks on or off")
		}
		if p.WiFiID == "" || p.Enabled == nil {
			return router.Change{}, router.Errorf(router.ErrInvalidArgument, action, "no Wi-Fi network or state given")
		}
		if !*p.Enabled {
			if err := a.guardOwnWiFi(ctx, d, p.WiFiID); err != nil {
				return router.Change{}, err
			}
		}
		return w.SetWiFiEnabled(ctx, p.WiFiID, *p.Enabled)
	case "reserve", "unreserve":
		r, ok := d.(router.ReservationManager)
		if !ok {
			return router.Change{}, unsupported(action, "manage DHCP reservations")
		}
		m, err := mac()
		if err != nil {
			return router.Change{}, err
		}
		if action == "unreserve" {
			return r.RemoveReservation(ctx, m)
		}
		return r.AddReservation(ctx, m, p.IP)
	case "add_port_forward", "remove_port_forward":
		f, ok := d.(router.PortForwarder)
		if !ok {
			return router.Change{}, unsupported(action, "manage port forwarding")
		}
		if p.PortForward == nil {
			return router.Change{}, router.Errorf(router.ErrInvalidArgument, action, "no port-forward rule given")
		}
		if action == "remove_port_forward" {
			return f.RemovePortForward(ctx, *p.PortForward)
		}
		return f.AddPortForward(ctx, *p.PortForward)
	case "reboot":
		r, ok := d.(router.Rebooter)
		if !ok {
			return router.Change{}, unsupported(action, "restart the router")
		}
		return r.Reboot(ctx)
	}
	return router.Change{}, router.Errorf(router.ErrInvalidArgument, "command", "unknown router action")
}

// guardOwnWiFi refuses to turn off a Wi-Fi network this collector's own computer is connected to:
// the collector would lose the router and could not turn it back on.
func (a *Agent) guardOwnWiFi(ctx context.Context, d router.Driver, id string) error {
	sr, ok := d.(router.SettingsReader)
	if !ok || a.deps.LocalMACs == nil {
		return nil
	}
	s, err := sr.Settings(ctx)
	if err != nil {
		return err
	}
	local := map[string]bool{}
	for _, m := range a.deps.LocalMACs() {
		if n, err := router.NormalizeMAC(m); err == nil {
			local[n] = true
		}
	}
	for _, w := range s.WiFi {
		if w.ID != id {
			continue
		}
		for _, m := range w.ClientMACs {
			if local[m] {
				return router.Errorf(router.ErrInvalidArgument, "wifi",
					"the computer running this collector is connected to %q; turning it off would cut LAN Detective off from the router", w.SSID)
			}
		}
	}
	return nil
}

// attachSettings adds the router-wide settings to a result item. A failure to read them never fails
// the operation they accompany; the next refresh tries again.
func attachSettings(ctx context.Context, d router.Driver, item map[string]any) {
	sr, ok := d.(router.SettingsReader)
	if !ok {
		return
	}
	s, err := sr.Settings(ctx)
	if err != nil {
		return
	}
	if w := wireSettings(s); len(w) > 0 {
		item["settings"] = w
	}
}

// portRangeOK: both ends are real ports (the API refuses a result with any other value).
func portRangeOK(start, end int) bool {
	return start >= 1 && start <= 65535 && end >= 1 && end <= 65535
}

func wireSettings(s router.Settings) map[string]any {
	out := map[string]any{}
	ipOK := func(v string) bool {
		a, err := netip.ParseAddr(v)
		return err == nil && a.Is4()
	}
	if o := s.Overview; o != nil {
		ov := map[string]any{}
		if o.UptimeSeconds != nil && *o.UptimeSeconds >= 0 {
			ov["uptime_seconds"] = *o.UptimeSeconds
		}
		if ipOK(o.LANIP) {
			ov["lan_ip"] = o.LANIP
		}
		wan := make([]map[string]any, 0, len(o.WAN))
		for _, l := range o.WAN {
			if len(wan) >= 8 {
				break
			}
			name := clip(strings.TrimSpace(l.Name), 60)
			if name == "" {
				name = "WAN"
			}
			e := map[string]any{"name": name, "status": l.Status}
			switch l.Status {
			case "up", "down", "connecting", "unknown":
			default:
				e["status"] = "unknown"
			}
			if l.Type != "" {
				e["type"] = clip(l.Type, 20)
			}
			if ipOK(l.IPv4) {
				e["ipv4"] = l.IPv4
			}
			var dns []string
			for _, x := range l.DNS {
				if ipOK(x) && len(dns) < 4 {
					dns = append(dns, x)
				}
			}
			if len(dns) > 0 {
				e["dns"] = dns
			}
			if l.UptimeSeconds != nil && *l.UptimeSeconds >= 0 {
				e["uptime_seconds"] = *l.UptimeSeconds
			}
			wan = append(wan, e)
		}
		ov["wan"] = wan
		out["overview"] = ov
	}
	if s.WiFi != nil {
		list := make([]map[string]any, 0, len(s.WiFi))
		for _, w := range s.WiFi {
			if len(list) >= 32 {
				break
			}
			if w.ID == "" || len(w.ID) > 40 {
				continue // an entry the API could not address
			}
			macs := []string{}
			for _, m := range w.ClientMACs {
				if n, err := router.NormalizeMAC(m); err == nil && len(macs) < 256 {
					macs = append(macs, n)
				}
			}
			e := map[string]any{"id": clip(w.ID, 40), "ssid": clip(w.SSID, 64), "enabled": w.Enabled, "main": w.Main, "guest": w.Guest, "hidden": w.Hidden, "client_macs": macs}
			if w.Band != "" {
				e["band"] = clip(w.Band, 20)
			}
			if w.Security != "" {
				e["security"] = clip(w.Security, 40)
			}
			list = append(list, e)
		}
		out["wifi"] = list
	}
	if s.Reservations != nil {
		list := make([]map[string]any, 0, len(s.Reservations))
		for _, r := range s.Reservations {
			m, err := router.NormalizeMAC(r.MAC)
			if err != nil || !ipOK(r.IP) || r.ID == "" || len(r.ID) > 40 || len(list) >= 256 {
				continue
			}
			list = append(list, map[string]any{"id": clip(r.ID, 40), "mac": m, "ip": r.IP, "enabled": r.Enabled})
		}
		out["reservations"] = list
	}
	if s.PortForwards != nil {
		list := make([]map[string]any, 0, len(s.PortForwards))
		for _, f := range s.PortForwards {
			if len(list) >= 256 || !ipOK(f.InternalIP) || f.ID == "" || len(f.ID) > 40 || !portRangeOK(f.ExternalStart, f.ExternalEnd) || !portRangeOK(f.InternalStart, f.InternalEnd) {
				continue
			}
			owner := router.OwnerAdmin
			if f.Owner == router.OwnerProduct {
				owner = router.OwnerProduct
			}
			proto, ok := router.NormalizeProtocol(f.Protocol)
			if !ok {
				proto = router.ProtoBoth
			}
			e := map[string]any{"id": clip(f.ID, 40), "enabled": f.Enabled, "description": clip(f.Description, 120), "protocol": proto,
				"external_start": f.ExternalStart, "external_end": f.ExternalEnd, "internal_start": f.InternalStart, "internal_end": f.InternalEnd,
				"internal_ip": f.InternalIP, "owner": string(owner)}
			list = append(list, e)
		}
		out["port_forwards"] = list
	}
	return out
}

// refreshRouter reads identity, capabilities, the client list and the blocks in effect. What was
// read before a failure is still reported.
func refreshRouter(ctx context.Context, d router.Driver, item map[string]any) error {
	info, err := d.Identify(ctx)
	if err != nil {
		return err
	}
	item["identity"] = wireInfo(info)
	caps, err := d.Capabilities(ctx)
	if err != nil {
		return err
	}
	item["capabilities"] = wireCaps(caps)
	if caps.Supports(router.CapClients) {
		clients, err := d.Clients(ctx)
		if err != nil {
			return err
		}
		router.SortClients(clients)
		wire := make([]map[string]any, 0, len(clients))
		for _, c := range clients {
			if w, ok := wireClient(c); ok && len(wire) < maxRouterClients {
				wire = append(wire, w)
			}
		}
		if len(clients) > maxRouterClients {
			item["clients_truncated"] = true
		}
		item["clients"] = wire
	}
	if caps.Supports(router.CapBlock) {
		blocked, err := d.Blocked(ctx)
		if err != nil {
			return err
		}
		wire := make([]map[string]any, 0, len(blocked))
		for _, b := range blocked {
			m, err := router.NormalizeMAC(b.MAC)
			if err != nil || len(wire) >= maxRouterBlocks {
				continue
			}
			e := map[string]any{"mac": m, "mechanism": clip(b.Mechanism, 120), "owner": string(b.Owner), "managed": b.Managed, "partial": b.Partial}
			if b.Name != "" {
				e["name"] = clip(b.Name, 120)
			}
			if b.Detail != "" {
				e["detail"] = clip(b.Detail, 300)
			}
			wire = append(wire, e)
		}
		item["blocked"] = wire
	}
	if caps.Supports(router.CapOverview) || caps.Supports(router.CapWiFi) || caps.Supports(router.CapReservations) || caps.Supports(router.CapPortForward) {
		attachSettings(ctx, d, item)
	}
	return nil
}

func wireInfo(i router.Info) map[string]any {
	out := map[string]any{"vendor": clip(i.Vendor, 120), "model": clip(i.Model, 120), "firmware": clip(i.Firmware, 120)}
	if len(i.Extra) > 0 {
		extra := map[string]string{}
		for k, v := range i.Extra {
			if len(extra) >= 20 {
				break
			}
			extra[clip(k, 60)] = clip(v, 200)
		}
		out["extra"] = extra
	}
	return out
}

func wireCaps(cs router.Capabilities) []map[string]any {
	out := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		e := map[string]any{"capability": string(c.Capability), "supported": c.Supported}
		if c.Mechanism != "" {
			e["mechanism"] = clip(c.Mechanism, 200)
		}
		if c.Note != "" {
			e["note"] = clip(c.Note, 400)
		}
		out = append(out, e)
		if len(out) >= 16 {
			break
		}
	}
	return out
}

func wireClient(c router.Client) (map[string]any, bool) {
	mac, err := router.NormalizeMAC(c.MAC)
	if err != nil {
		return nil, false
	}
	conn := string(c.Connection)
	if conn == "" {
		conn = string(router.ConnUnknown)
	}
	e := map[string]any{"mac": mac, "connection": conn}
	if ip, err := netip.ParseAddr(c.IP); err == nil && ip.Unmap().Is4() {
		e["ip"] = ip.Unmap().String()
	}
	if c.Hostname != "" {
		e["hostname"] = clip(c.Hostname, 120)
	}
	if c.Interface != "" {
		e["interface"] = clip(c.Interface, 120)
	}
	if c.SignalDBm != nil {
		e["signal_dbm"] = *c.SignalDBm
	}
	if c.Active != nil {
		e["active"] = *c.Active
	}
	if c.Blocked != nil {
		e["blocked"] = *c.Blocked
	}
	if c.Lease != nil {
		if c.Lease.Source != "" {
			e["lease_source"] = clip(c.Lease.Source, 20)
		}
		if c.Lease.Remaining != nil && *c.Lease.Remaining >= 0 {
			e["lease_remaining_seconds"] = int64(*c.Lease.Remaining / time.Second)
		}
	}
	if len(c.Raw) > 0 {
		raw := map[string]string{}
		for k, v := range c.Raw {
			if len(raw) >= 40 {
				break
			}
			raw[clip(k, 60)] = clip(v, 200)
		}
		e["raw"] = raw
	}
	return e, true
}

func wireChange(c router.Change) map[string]any {
	return map[string]any{"action": clip(c.Action, 40), "mac": c.MAC, "mechanism": clip(c.Mechanism, 200), "applied": c.Applied,
		"already_in_effect": c.AlreadyInEffect, "detail": clip(c.Detail, 400), "undo": clip(c.Undo, 400)}
}

// fetchRouterCertificate performs only a TLS handshake with the router (no login, no HTTP request)
// so the administrator can confirm the fingerprint before it is pinned.
func (a *Agent) fetchRouterCertificate(ctx context.Context, p routerPayload) {
	started := time.Now()
	item := map[string]any{"type": "router_result", "router_id": p.RouterID, "request_id": p.RequestID, "action": "fetch_certificate", "trigger": "command"}
	finish := func(err error) {
		if ctx.Err() != nil {
			return
		}
		item["ts"], item["duration_ms"], item["ok"] = time.Now().UTC(), time.Since(started).Milliseconds(), err == nil
		if err != nil {
			item["error"] = errorItem(err)
		}
		a.reportRouter(item)
	}
	if a.deps.RouterCertificate == nil {
		finish(router.Errorf(router.ErrUnsupported, "tls", "certificate inspection is not available on this collector"))
		return
	}
	addr, err := netip.ParseAddr(p.Address)
	if err != nil {
		finish(router.Errorf(router.ErrInvalidArgument, "tls", "router address is not an IP address"))
		return
	}
	release, ok := a.routers.acquire(ctx, p.RouterID)
	if !ok {
		return
	}
	defer release()
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	info, err := a.deps.RouterCertificate(cctx, addr, p.Port, a.routerOptions())
	if err == nil {
		item["certificate"] = map[string]any{"sha256": info.SHA256, "subject": clip(info.Subject, 300), "issuer": clip(info.Issuer, 300),
			"not_before": info.NotBefore.UTC(), "not_after": info.NotAfter.UTC(), "self_signed": info.SelfSigned, "expired": info.Expired, "system_trust": info.SystemTrust}
	}
	finish(err)
}
