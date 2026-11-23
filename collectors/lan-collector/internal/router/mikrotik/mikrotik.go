// Package mikrotik drives MikroTik routers running RouterOS v7 via the built-in REST API (/rest/*).
// It registers itself as router vendor "mikrotik".
//
// Mechanisms used (RouterOS v7 REST API, HTTP Basic Auth):
//   - identify:     GET /rest/system/resource (+ /rest/system/routerboard when available)
//   - clients:      merges GET /rest/ip/dhcp-server/lease, GET /rest/ip/arp, and
//                   GET /rest/interface/wifi/registration-table (fallback: wireless/registration-table)
//   - block:        PUT /rest/ip/firewall/filter (chain=forward, src-mac-address=<MAC>, action=drop,
//                   comment="lan-detective:block:<mac>"). Existing administrator rules are reported
//                   read-only (OwnerAdmin) and never modified or removed.
//   - rate limit:   PUT/PATCH/DELETE /rest/queue/simple (target=<ip>/32, max-limit=<up>k/<down>k,
//                   comment="lan-detective:limit:<mac>").
//   - schedule:     PUT/DELETE /rest/ip/firewall/filter with time=HH:MM:00-HH:MM:00,<days> and
//                   comment="lan-detective:schedule:<mac>".
package mikrotik

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "mikrotik"

const (
	blockCommentPrefix    = "lan-detective:block:"
	limitCommentPrefix    = "lan-detective:limit:"
	scheduleCommentPrefix = "lan-detective:schedule:"

	mechBlock    = "RouterOS firewall filter rule (chain=forward, src-mac-address, action=drop)"
	mechLimit    = "RouterOS simple queue (/queue/simple max-limit)"
	mechSchedule = "RouterOS time-based firewall filter rule (chain=forward, src-mac-address, time)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var (
	_ router.Driver      = (*Driver)(nil)
	_ router.RateLimiter = (*Driver)(nil)
	_ router.Scheduler   = (*Driver)(nil)
)

// Driver talks to one MikroTik RouterOS v7 router over its REST API.
type Driver struct {
	target router.Target
	base   string
	http   *http.Client
	creds  router.CredentialSource

	authHeader []byte // "Basic <base64>", zeroed in Close
	info       *router.Info
}

// New builds a MikroTik driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) ensureAuth(ctx context.Context) error {
	if len(d.authHeader) > 0 {
		return nil
	}
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)
	raw := make([]byte, 0, len(user)+1+len(pass))
	raw = append(raw, user...)
	raw = append(raw, ':')
	raw = append(raw, pass...)
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	router.Zero(raw)
	d.authHeader = append([]byte("Basic "), enc...)
	router.Zero(enc)
	return nil
}

func (d *Driver) do(ctx context.Context, op, method, path string, body any) (int, []byte, error) {
	if err := d.ensureAuth(ctx); err != nil {
		return 0, nil, err
	}
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "cannot encode request")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Authorization", string(d.authHeader))
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return 0, nil, router.TransportError(op, err)
	}
	defer resp.Body.Close()
	raw, err := router.ReadBody(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrBadCredentials, Op: op, Detail: "HTTP 401"}
	}
	if resp.StatusCode == http.StatusForbidden {
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "account lacks REST API permissions (HTTP 403)"}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrLockedOut, Op: op, Detail: "HTTP 429"}
	}
	return resp.StatusCode, raw, nil
}

func apiErrDetail(raw []byte, status int) string {
	var e struct {
		Error   int    `json:"error"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if json.Unmarshal(raw, &e) == nil && (e.Message != "" || e.Detail != "") {
		msg := strings.TrimSpace(e.Message + " " + e.Detail)
		if len(msg) > 160 {
			msg = msg[:160]
		}
		return fmt.Sprintf("HTTP %d: %s", status, msg)
	}
	return fmt.Sprintf("HTTP %d", status)
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	status, raw, err := d.do(ctx, "identify", http.MethodGet, "/rest/system/resource", nil)
	if err != nil {
		return router.Info{}, err
	}
	if status != http.StatusOK {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "RouterOS REST API unavailable (%s)", apiErrDetail(raw, status))
	}
	// RouterOS returns either a single object or a 1-element array depending on version.
	res, ok := decodeSingleObject(raw)
	if !ok || (strVal(res["version"]) == "" && strVal(res["board-name"]) == "") {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a MikroTik RouterOS v7 REST response")
	}
	info := router.Info{
		Vendor:   "MikroTik",
		Model:    firstNonEmpty(strVal(res["board-name"]), strVal(res["platform"]), "RouterOS"),
		Firmware: strVal(res["version"]),
		Extra:    map[string]string{},
	}
	if arch := strVal(res["architecture-name"]); arch != "" {
		info.Extra["architecture"] = arch
	}
	if up := strVal(res["uptime"]); up != "" {
		info.Extra["uptime"] = up
	}
	// Best-effort routerboard details (serial / model).
	if st, rbRaw, err := d.do(ctx, "identify", http.MethodGet, "/rest/system/routerboard", nil); err == nil && st == http.StatusOK {
		if rb, ok := decodeSingleObject(rbRaw); ok {
			if m := strVal(rb["model"]); m != "" {
				info.Model = m
			}
			if sn := strVal(rb["serial-number"]); sn != "" {
				info.Extra["serial"] = sn
			}
		}
	}
	d.info = &info
	return info, nil
}

func (d *Driver) Capabilities(ctx context.Context) (router.Capabilities, error) {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return nil, err
		}
	}
	return router.Capabilities{
		{Capability: router.CapClients, Supported: true, Mechanism: "RouterOS DHCP leases, ARP table and Wi-Fi registration table"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "/rest/ip/dhcp-server/lease"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Drops forwarded traffic from the device MAC without modifying administrator rules"},
		{Capability: router.CapRateLimit, Supported: true, Mechanism: mechLimit, Note: "Applies a per-IP simple queue tagged for this MAC (requires an observed IP)"},
		{Capability: router.CapSchedule, Supported: true, Mechanism: mechSchedule, Note: "Drops forwarded traffic during the configured weekly time windows in the router's clock"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) getList(ctx context.Context, op, path string) ([]map[string]any, int, error) {
	status, raw, err := d.do(ctx, op, http.MethodGet, path, nil)
	if err != nil {
		return nil, status, err
	}
	if status == http.StatusNotFound || status == http.StatusBadRequest {
		return nil, status, nil
	}
	if status != http.StatusOK {
		return nil, status, router.Errorf(router.ErrProtocol, op, "%s failed (%s)", path, apiErrDetail(raw, status))
	}
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, status, router.Errorf(router.ErrProtocol, op, "%s returned unexpected JSON", path)
	}
	return items, status, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	leases, _, err := d.getList(ctx, "clients", "/rest/ip/dhcp-server/lease")
	if err != nil {
		return nil, err
	}
	arps, _, err := d.getList(ctx, "clients", "/rest/ip/arp")
	if err != nil {
		return nil, err
	}
	// Wi-Fi registration table: RouterOS 7.13+ uses /rest/interface/wifi/registration-table;
	// older/legacy wireless package uses /rest/interface/wireless/registration-table.
	wifiRegs, _, _ := d.getList(ctx, "clients", "/rest/interface/wifi/registration-table")
	legacyRegs, _, _ := d.getList(ctx, "clients", "/rest/interface/wireless/registration-table")
	wifiRegs = append(wifiRegs, legacyRegs...)

	blockedMACs := map[string]bool{}
	if blocks, err := d.Blocked(ctx); err == nil {
		for _, b := range blocks {
			if !b.Partial {
				blockedMACs[b.MAC] = true
			}
		}
	}

	byMAC := map[string]*router.Client{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnUnknown, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	for _, l := range leases {
		if boolVal(l["disabled"]) {
			continue
		}
		mac, err := router.NormalizeMAC(firstNonEmpty(strVal(l["mac-address"]), strVal(l["active-mac-address"])))
		if err != nil {
			continue
		}
		c := ensure(mac)
		if ip := firstNonEmpty(strVal(l["active-address"]), strVal(l["address"])); ip != "" {
			c.IP = ip
		}
		if hn := strings.TrimSpace(strVal(l["host-name"])); hn != "" {
			c.Hostname = hn
		}
		status := strings.ToLower(strVal(l["status"]))
		if status == "bound" {
			t := true
			c.Active = &t
		} else if status != "" && c.Active == nil {
			f := false
			c.Active = &f
		}
		lease := &router.Lease{Source: "dhcp"}
		if !boolVal(l["dynamic"]) {
			lease.Source = "reserved"
		}
		if rem, ok := parseROSDuration(strVal(l["expires-after"])); ok {
			lease.Remaining = &rem
		}
		c.Lease = lease
		if srv := strVal(l["server"]); srv != "" && c.Interface == "" {
			c.Interface = srv
		}
		copyRaw(c.Raw, "dhcp.", l)
	}

	for _, a := range arps {
		if boolVal(a["disabled"]) || boolVal(a["invalid"]) {
			continue
		}
		mac, err := router.NormalizeMAC(strVal(a["mac-address"]))
		if err != nil {
			continue
		}
		c := ensure(mac)
		if ip := strVal(a["address"]); ip != "" && c.IP == "" {
			c.IP = ip
		}
		if iface := strVal(a["interface"]); iface != "" {
			c.Interface = iface
		}
		if boolVal(a["complete"]) {
			t := true
			c.Active = &t
		}
		if c.Connection == router.ConnUnknown {
			c.Connection = router.ConnWired
		}
		if c.Lease == nil && !boolVal(a["dhcp"]) {
			c.Lease = &router.Lease{Source: "static"}
		}
		copyRaw(c.Raw, "arp.", a)
	}

	for _, w := range wifiRegs {
		mac, err := router.NormalizeMAC(strVal(w["mac-address"]))
		if err != nil {
			continue
		}
		c := ensure(mac)
		t := true
		c.Active = &t
		c.Connection = wifiBand(firstNonEmpty(strVal(w["band"]), strVal(w["interface"])))
		if iface := firstNonEmpty(strVal(w["ssid"]), strVal(w["interface"])); iface != "" {
			c.Interface = iface
		}
		if sig, ok := parseSignal(firstNonEmpty(strVal(w["signal"]), strVal(w["signal-strength"]))); ok {
			c.SignalDBm = &sig
		}
		copyRaw(c.Raw, "wifi.", w)
	}

	out := make([]router.Client, 0, len(byMAC))
	for mac, c := range byMAC {
		b := blockedMACs[mac]
		c.Blocked = &b
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	rules, _, err := d.getList(ctx, "blocked", "/rest/ip/firewall/filter")
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, r := range rules {
		if boolVal(r["disabled"]) {
			continue
		}
		action := strings.ToLower(strVal(r["action"]))
		if action != "drop" && action != "reject" {
			continue
		}
		mac, err := router.NormalizeMAC(strVal(r["src-mac-address"]))
		if err != nil {
			continue
		}
		comment := strVal(r["comment"])
		isTime := strings.TrimSpace(strVal(r["time"])) != ""
		entry := router.BlockEntry{
			MAC:       mac,
			Mechanism: mechBlock,
			Owner:     router.OwnerAdmin,
			Partial:   isTime,
			Detail:    comment,
			Managed:   false,
		}
		switch {
		case strings.HasPrefix(comment, blockCommentPrefix):
			entry.Owner = router.OwnerProduct
			entry.Managed = true
		case strings.HasPrefix(comment, scheduleCommentPrefix):
			entry.Owner = router.OwnerProduct
			entry.Mechanism = mechSchedule
			entry.Partial = true
			entry.Managed = false
			entry.Detail = "schedule " + strVal(r["time"])
		}
		out = append(out, entry)
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	blocked, err := d.Blocked(ctx)
	if err != nil {
		return router.Change{}, err
	}
	for _, b := range blocked {
		if b.MAC == mac && !b.Partial {
			return router.Change{
				Action:          "block",
				MAC:             mac,
				Mechanism:       b.Mechanism,
				Applied:         false,
				AlreadyInEffect: true,
				Detail:          fmt.Sprintf("device is already blocked on MikroTik (%s)", b.Owner),
				Undo:            undoBlock(mac),
			}, nil
		}
	}
	payload := map[string]any{
		"chain":           "forward",
		"src-mac-address": strings.ToUpper(mac),
		"action":          "drop",
		"comment":         blockCommentPrefix + mac,
	}
	status, raw, err := d.do(ctx, "block", http.MethodPut, "/rest/ip/firewall/filter", payload)
	if err != nil {
		return router.Change{}, err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "cannot add firewall rule (%s)", apiErrDetail(raw, status))
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    "added forward-chain drop rule for " + strings.ToUpper(mac),
		Undo:      undoBlock(mac),
	}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rules, _, err := d.getList(ctx, "unblock", "/rest/ip/firewall/filter")
	if err != nil {
		return router.Change{}, err
	}
	wantComment := blockCommentPrefix + mac
	removed := 0
	for _, r := range rules {
		if strVal(r["comment"]) != wantComment {
			continue
		}
		id := strVal(r[".id"])
		if id == "" {
			continue
		}
		st, raw, err := d.do(ctx, "unblock", http.MethodDelete, "/rest/ip/firewall/filter/"+url.PathEscape(id), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusNoContent {
			return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "cannot remove rule %s (%s)", id, apiErrDetail(raw, st))
		}
		removed++
	}
	if removed == 0 {
		return router.Change{
			Action:          "unblock",
			MAC:             mac,
			Mechanism:       mechBlock,
			Applied:         false,
			AlreadyInEffect: true,
			Detail:          "no managed block rule present for this MAC",
		}, nil
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("removed %d managed firewall block rule(s)", removed),
		Undo:      "Block the device again in Nigafiy",
	}, nil
}

func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if limit.DownKbps <= 0 && limit.UpKbps <= 0 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "rate_limit", "down_kbps or up_kbps must be > 0")
	}
	clients, err := d.Clients(ctx)
	if err != nil {
		return router.Change{}, err
	}
	var ip string
	for _, c := range clients {
		if c.MAC == mac && c.IP != "" {
			ip = c.IP
			break
		}
	}
	if ip == "" {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rate_limit", "router has no IPv4 address for %s (required for simple queue target)", mac)
	}
	// RouterOS /queue/simple max-limit order is upload/download (target-upload/target-download).
	up := "0"
	if limit.UpKbps > 0 {
		up = fmt.Sprintf("%dk", limit.UpKbps)
	}
	down := "0"
	if limit.DownKbps > 0 {
		down = fmt.Sprintf("%dk", limit.DownKbps)
	}
	maxLimit := up + "/" + down
	comment := limitCommentPrefix + mac
	name := "ld-limit-" + strings.ReplaceAll(mac, ":", "")

	queues, _, err := d.getList(ctx, "rate_limit", "/rest/queue/simple")
	if err != nil {
		return router.Change{}, err
	}
	var existingID string
	for _, q := range queues {
		if strVal(q["comment"]) == comment {
			existingID = strVal(q[".id"])
			break
		}
	}
	body := map[string]any{
		"name":      name,
		"target":    ip + "/32",
		"max-limit": maxLimit,
		"comment":   comment,
	}
	var status int
	var raw []byte
	if existingID != "" {
		status, raw, err = d.do(ctx, "rate_limit", http.MethodPatch, "/rest/queue/simple/"+url.PathEscape(existingID), body)
	} else {
		status, raw, err = d.do(ctx, "rate_limit", http.MethodPut, "/rest/queue/simple", body)
	}
	if err != nil {
		return router.Change{}, err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "cannot configure simple queue (%s)", apiErrDetail(raw, status))
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("simple queue %s on %s/32 set to max-limit %s (up/down)", name, ip, maxLimit),
		Undo:      fmt.Sprintf("Clear rate limit in Nigafiy, or remove simple queue %q on MikroTik", name),
	}, nil
}

func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	queues, _, err := d.getList(ctx, "clear_rate_limit", "/rest/queue/simple")
	if err != nil {
		return router.Change{}, err
	}
	want := limitCommentPrefix + mac
	removed := 0
	for _, q := range queues {
		if strVal(q["comment"]) != want {
			continue
		}
		id := strVal(q[".id"])
		if id == "" {
			continue
		}
		st, raw, err := d.do(ctx, "clear_rate_limit", http.MethodDelete, "/rest/queue/simple/"+url.PathEscape(id), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusNoContent {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "cannot remove queue %s (%s)", id, apiErrDetail(raw, st))
		}
		removed++
	}
	return router.Change{
		Action:          "clear_rate_limit",
		MAC:             mac,
		Mechanism:       mechLimit,
		Applied:         removed > 0,
		AlreadyInEffect: removed == 0,
		Detail:          fmt.Sprintf("removed %d managed simple queue(s)", removed),
	}, nil
}

func (d *Driver) SetSchedule(ctx context.Context, rawMAC string, windows []router.Window) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if len(windows) == 0 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "schedule", "at least one window is required")
	}
	if _, err := d.ClearSchedule(ctx, mac); err != nil {
		return router.Change{}, err
	}
	specs := expandScheduleSpecs(windows)
	for _, spec := range specs {
		payload := map[string]any{
			"chain":           "forward",
			"src-mac-address": strings.ToUpper(mac),
			"action":          "drop",
			"time":            spec,
			"comment":         scheduleCommentPrefix + mac,
		}
		st, raw, err := d.do(ctx, "schedule", http.MethodPut, "/rest/ip/firewall/filter", payload)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusCreated {
			return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "cannot add schedule rule (%s)", apiErrDetail(raw, st))
		}
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("applied %d scheduled drop rule(s) for %s", len(specs), strings.ToUpper(mac)),
		Undo:      fmt.Sprintf("Remove schedule in Nigafiy, or delete firewall filter rules commented %q on MikroTik", scheduleCommentPrefix+mac),
	}, nil
}

func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rules, _, err := d.getList(ctx, "clear_schedule", "/rest/ip/firewall/filter")
	if err != nil {
		return router.Change{}, err
	}
	want := scheduleCommentPrefix + mac
	removed := 0
	for _, r := range rules {
		if strVal(r["comment"]) != want {
			continue
		}
		id := strVal(r[".id"])
		if id == "" {
			continue
		}
		st, raw, err := d.do(ctx, "clear_schedule", http.MethodDelete, "/rest/ip/firewall/filter/"+url.PathEscape(id), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusNoContent {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "cannot remove schedule rule %s (%s)", id, apiErrDetail(raw, st))
		}
		removed++
	}
	return router.Change{
		Action:          "clear_schedule",
		MAC:             mac,
		Mechanism:       mechSchedule,
		Applied:         removed > 0,
		AlreadyInEffect: removed == 0,
		Detail:          fmt.Sprintf("removed %d managed schedule rule(s)", removed),
	}, nil
}

func (d *Driver) Close(context.Context) error {
	router.Zero(d.authHeader)
	d.authHeader = nil
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or delete the /ip/firewall/filter rule commented %q on MikroTik", blockCommentPrefix+mac)
}

func decodeSingleObject(raw []byte) (map[string]any, bool) {
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil && obj != nil {
		return obj, true
	}
	var arr []map[string]any
	if json.Unmarshal(raw, &arr) == nil && len(arr) > 0 {
		return arr[0], true
	}
	return nil, false
}

func strVal(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	default:
		return ""
	}
}

func boolVal(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(x, "true") || x == "yes" || x == "1"
	case float64:
		return x != 0
	default:
		return false
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func copyRaw(dst map[string]string, prefix string, src map[string]any) {
	for k, v := range src {
		if s := strVal(v); s != "" {
			dst[prefix+k] = s
		}
	}
}

func wifiBand(s string) router.ConnectionType {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "6ghz") || strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5ghz") || strings.Contains(l, "5g"):
		return router.ConnWiFi5
	case strings.Contains(l, "2ghz") || strings.Contains(l, "2.4"):
		return router.ConnWiFi24
	default:
		return router.ConnWiFi
	}
}

func parseSignal(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	// Handles "-72" or "-65dBm@1Mbps".
	if idx := strings.IndexAny(s, "dD@ "); idx > 0 {
		s = s[:idx]
	}
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || v >= 0 || v <= -120 {
		return 0, false
	}
	return v, true
}

// parseROSDuration parses RouterOS durations such as "9m45s", "1d2h3m4s", "2w1d".
func parseROSDuration(s string) (time.Duration, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	var total time.Duration
	var num int
	hasUnit := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			num = num*10 + int(c-'0')
			continue
		}
		hasUnit = true
		switch c {
		case 'w':
			total += time.Duration(num) * 7 * 24 * time.Hour
		case 'd':
			total += time.Duration(num) * 24 * time.Hour
		case 'h':
			total += time.Duration(num) * time.Hour
		case 'm':
			total += time.Duration(num) * time.Minute
		case 's':
			total += time.Duration(num) * time.Second
		default:
			return 0, false
		}
		num = 0
	}
	return total, hasUnit
}

var rosDay = [7]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func expandScheduleSpecs(windows []router.Window) []string {
	var out []string
	for _, w := range windows {
		days := formatDays(w.Days, 0)
		if w.Start <= w.End {
			out = append(out, fmt.Sprintf("%s:00-%s:00,%s", w.Start, w.End, days))
		} else {
			// Window crosses midnight: split across current days and next days.
			out = append(out, fmt.Sprintf("%s:00-23:59:59,%s", w.Start, days))
			out = append(out, fmt.Sprintf("00:00:00-%s:00,%s", w.End, formatDays(w.Days, 1)))
		}
	}
	return out
}

func formatDays(days []time.Weekday, shift int) string {
	seen := [7]bool{}
	var parts []string
	for _, d := range days {
		idx := (int(d) + shift) % 7
		if idx < 0 {
			idx += 7
		}
		if !seen[idx] {
			seen[idx] = true
			parts = append(parts, rosDay[idx])
		}
	}
	if len(parts) == 0 {
		return "sun,mon,tue,wed,thu,fri,sat"
	}
	return strings.Join(parts, ",")
}
