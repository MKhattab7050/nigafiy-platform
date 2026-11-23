// Package omada drives TP-Link Omada SDN Controllers (hardware OC200/OC300 and software v5+) via
// the controller JSON API (/{omadacId}/api/v2/*). It registers itself as vendor "omada".
//
// Mechanisms used:
//   - identify:   GET /api/info (public, returns omadacId, controllerVer, name)
//   - login:      POST /{omadacId}/api/v2/login (session cookie + Csrf-Token)
//   - clients:    GET /{omadacId}/api/v2/sites/{site}/clients + insight/known-clients
//   - block:      POST /{omadacId}/api/v2/sites/{site}/cmd/clients/{MAC}/block & unblock
//   - rate limit: PATCH /{omadacId}/api/v2/sites/{site}/clients/{MAC} (customRateLimit down/up kbps)
//   - logout:     POST /{omadacId}/api/v2/logout
package omada

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "omada"

const (
	mechBlock = "TP-Link Omada client block (cmd/clients/{mac}/block)"
	mechLimit = "TP-Link Omada custom client rate limit (clients/{mac} rateLimit)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var (
	_ router.Driver      = (*Driver)(nil)
	_ router.RateLimiter = (*Driver)(nil)
)

// Driver talks to one TP-Link Omada SDN Controller.
type Driver struct {
	target   router.Target
	base     string
	http     *http.Client
	creds    router.CredentialSource
	omadacID string
	siteID   string
	cookies  [][]byte
	csrf     []byte
	loggedIn bool
	info     *router.Info
}

// New builds an Omada driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	for _, c := range d.cookies {
		router.Zero(c)
	}
	router.Zero(d.csrf)
	d.cookies = nil
	d.csrf = nil
	d.loggedIn = false
}

func (d *Driver) rawDo(ctx context.Context, op, method, path string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if len(d.cookies) > 0 {
		parts := make([]string, len(d.cookies))
		for i, c := range d.cookies {
			parts[i] = string(c)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
	}
	if len(d.csrf) > 0 {
		req.Header.Set("Csrf-Token", string(d.csrf))
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
	for _, c := range resp.Cookies() {
		d.cookies = append(d.cookies, []byte(c.Name+"="+c.Value))
	}
	return resp.StatusCode, raw, nil
}

type apiReply struct {
	ErrorCode int             `json:"errorCode"`
	Msg       string          `json:"msg"`
	Result    json.RawMessage `json:"result"`
}

// Identify reads the public /api/info endpoint; no login is needed.
func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	st, raw, err := d.rawDo(ctx, "identify", http.MethodGet, "/api/info", nil)
	if err != nil {
		return router.Info{}, err
	}
	var rep apiReply
	if st != http.StatusOK || json.Unmarshal(raw, &rep) != nil || rep.ErrorCode != 0 {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a TP-Link Omada controller (HTTP %d)", st)
	}
	var res struct {
		OmadacID      string `json:"omadacId"`
		ControllerVer string `json:"controllerVer"`
		Name          string `json:"name"`
		Model         string `json:"model"`
	}
	if err := json.Unmarshal(rep.Result, &res); err != nil || res.OmadacID == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "missing omadacId in /api/info")
	}
	d.omadacID = res.OmadacID
	info := router.Info{
		Vendor:   "TP-Link Omada",
		Model:    first(res.Model, res.Name, "Omada Controller"),
		Firmware: res.ControllerVer,
		Extra:    map[string]string{"omadac_id": res.OmadacID},
	}
	d.info = &info
	return info, nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.omadacID == "" {
		if _, err := d.Identify(ctx); err != nil {
			return err
		}
	}
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)
	body, _ := json.Marshal(map[string]string{"username": user, "password": string(pass)})
	defer router.Zero(body)

	st, raw, err := d.rawDo(ctx, "login", http.MethodPost, "/"+d.omadacID+"/api/v2/login", body)
	if err != nil {
		return err
	}
	var rep apiReply
	if json.Unmarshal(raw, &rep) != nil {
		return router.Errorf(router.ErrProtocol, "login", "unreadable Omada login reply (HTTP %d)", st)
	}
	if st == http.StatusUnauthorized || rep.ErrorCode == -44106 || rep.ErrorCode == -44104 {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: rep.Msg}
	}
	if rep.ErrorCode == -44112 || strings.Contains(strings.ToLower(rep.Msg), "lock") {
		return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: rep.Msg}
	}
	if st != http.StatusOK || rep.ErrorCode != 0 {
		return router.Errorf(router.ErrBadCredentials, "login", "Omada login error %d: %s", rep.ErrorCode, rep.Msg)
	}
	var res struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(rep.Result, &res) == nil && res.Token != "" {
		router.Zero(d.csrf)
		d.csrf = []byte(res.Token)
	}
	d.loggedIn = true
	return d.discoverSite(ctx)
}

func (d *Driver) discoverSite(ctx context.Context) error {
	if d.siteID != "" {
		return nil
	}
	res, err := d.call(ctx, "sites", http.MethodGet, "/"+d.omadacID+"/api/v2/sites?currentPage=1&currentPageSize=20", nil)
	if err != nil {
		return err
	}
	var page struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if json.Unmarshal(res, &page) != nil || len(page.Data) == 0 {
		return router.Errorf(router.ErrProtocol, "sites", "Omada controller returned no sites")
	}
	for _, s := range page.Data {
		if strings.EqualFold(s.Name, "Default") {
			d.siteID = s.ID
			return nil
		}
	}
	d.siteID = page.Data[0].ID
	return nil
}

func (d *Driver) call(ctx context.Context, op, method, path string, payload any) (json.RawMessage, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, router.Errorf(router.ErrInvalidArgument, op, "cannot encode body")
		}
	}
	st, raw, err := d.rawDo(ctx, op, method, path, body)
	if err != nil {
		return nil, err
	}
	if st == http.StatusUnauthorized {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		st, raw, err = d.rawDo(ctx, op, method, path, body)
		if err != nil {
			return nil, err
		}
	}
	var rep apiReply
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable Omada reply (HTTP %d)", st)
	}
	if rep.ErrorCode == -1200 || rep.ErrorCode == -44110 {
		return nil, &router.Error{Kind: router.ErrSessionExpired, Op: op, Detail: rep.Msg}
	}
	if st == http.StatusForbidden || rep.ErrorCode == -44105 {
		return nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: rep.Msg}
	}
	if st >= 400 || rep.ErrorCode != 0 {
		return nil, router.Errorf(router.ErrRejected, op, "Omada error %d: %s", rep.ErrorCode, rep.Msg)
	}
	return rep.Result, nil
}

func (d *Driver) Capabilities(ctx context.Context) (router.Capabilities, error) {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return nil, err
		}
	}
	return router.Capabilities{
		{Capability: router.CapClients, Supported: true, Mechanism: "Omada Controller client list and known clients"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "Omada client API reports client IP without DHCP lease expiry"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Blocks the client MAC across the Omada site"},
		{Capability: router.CapRateLimit, Supported: true, Mechanism: mechLimit, Note: "Configures per-client custom download/upload limits in kbit/s"},
		{Capability: router.CapSchedule, Supported: false, Note: "Omada schedules are configured on WLANs/ACLs rather than individual clients"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func omadaMAC(mac string) string {
	return strings.ToUpper(strings.ReplaceAll(mac, ":", "-"))
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	res, err := d.call(ctx, "clients", http.MethodGet, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/clients?currentPage=1&currentPageSize=500&filters.active=true", nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(res, &page); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "clients", "unexpected Omada clients shape")
	}

	blockedSet := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedSet[b.MAC] = true
		}
	}

	byMAC := map[string]*router.Client{}
	for _, row := range page.Data {
		mac, err := router.NormalizeMAC(str(row["mac"]))
		if err != nil {
			continue
		}
		active := boolOf(row["active"])
		blk := boolOf(row["blocked"]) || blockedSet[mac]
		c := &router.Client{
			MAC:        mac,
			IP:         str(row["ip"]),
			Hostname:   first(str(row["name"]), str(row["hostName"])),
			Connection: omadaConn(row),
			Interface:  first(str(row["ssid"]), str(row["networkName"]), str(row["portName"])),
			Active:     &active,
			Blocked:    &blk,
			Raw:        map[string]string{},
		}
		if sig, ok := intOf(row["rssi"]); ok && sig < 0 && sig > -120 {
			c.SignalDBm = &sig
		}
		for k, v := range row {
			if s := str(v); s != "" {
				c.Raw[k] = s
			}
		}
		byMAC[mac] = c
	}

	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	res, err := d.call(ctx, "blocked", http.MethodGet, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/insight/known-clients?currentPage=1&currentPageSize=500&filters.blocked=true", nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(res, &page); err != nil {
		return nil, nil
	}
	var out []router.BlockEntry
	for _, row := range page.Data {
		if b, has := row["blocked"]; has && !boolOf(b) {
			continue
		}
		mac, err := router.NormalizeMAC(str(row["mac"]))
		if err != nil {
			continue
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      first(str(row["name"]), str(row["hostName"])),
			Mechanism: mechBlock,
			Owner:     router.OwnerUnknown,
			Managed:   true,
		})
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
		if b.MAC == mac {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "client is already blocked in Omada", Undo: undoBlock(mac)}, nil
		}
	}
	_, err = d.call(ctx, "block", http.MethodPost, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/cmd/clients/"+omadaMAC(mac)+"/block", map[string]any{})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "blocked " + omadaMAC(mac) + " on Omada controller", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	blocked, err := d.Blocked(ctx)
	if err != nil {
		return router.Change{}, err
	}
	found := false
	for _, b := range blocked {
		if b.MAC == mac {
			found = true
			break
		}
	}
	if !found {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "client is not blocked in Omada"}, nil
	}
	_, err = d.call(ctx, "unblock", http.MethodPost, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/cmd/clients/"+omadaMAC(mac)+"/unblock", map[string]any{})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "unblocked " + omadaMAC(mac) + " on Omada controller", Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if limit.DownKbps <= 0 && limit.UpKbps <= 0 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "rate_limit", "down_kbps or up_kbps must be > 0")
	}
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return router.Change{}, err
		}
	}
	payload := map[string]any{
		"rateLimit": map[string]any{
			"mode": 1,
			"customRateLimit": map[string]any{
				"enable":     true,
				"downEnable": limit.DownKbps > 0,
				"downLimit":  limit.DownKbps,
				"upEnable":   limit.UpKbps > 0,
				"upLimit":    limit.UpKbps,
			},
		},
	}
	_, err = d.call(ctx, "rate_limit", http.MethodPatch, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/clients/"+omadaMAC(mac), payload)
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("set Omada custom rate limit for %s (down=%d kbps, up=%d kbps)", mac, limit.DownKbps, limit.UpKbps),
		Undo:      "Clear rate limit in LAN Detective, or disable Rate Limit on the client in Omada Controller",
	}, nil
}

func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return router.Change{}, err
		}
	}
	payload := map[string]any{
		"rateLimit": map[string]any{
			"mode":            0,
			"customRateLimit": map[string]any{"enable": false},
		},
	}
	_, err = d.call(ctx, "clear_rate_limit", http.MethodPatch, "/"+d.omadacID+"/api/v2/sites/"+d.siteID+"/clients/"+omadaMAC(mac), payload)
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: true, Detail: "disabled custom rate limit on Omada client " + mac}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn && d.omadacID != "" {
		_, _, _ = d.rawDo(ctx, "logout", http.MethodPost, "/"+d.omadacID+"/api/v2/logout", nil)
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or unblock %s under Insights → Known Clients in Omada Controller", omadaMAC(mac))
}

func omadaConn(row map[string]any) router.ConnectionType {
	if !boolOf(row["wireless"]) {
		return router.ConnWired
	}
	if radio, ok := intOf(row["radioId"]); ok {
		switch radio {
		case 0:
			return router.ConnWiFi24
		case 1:
			return router.ConnWiFi5
		case 2:
			return router.ConnWiFi6
		}
	}
	return router.ConnWiFi
}

func str(v any) string {
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

func boolOf(v any) bool { b, ok := v.(bool); return ok && b }

func intOf(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	return int(f), true
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
