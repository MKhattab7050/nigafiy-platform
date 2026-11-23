// Package unifi drives Ubiquiti UniFi Network controllers — both UniFi OS consoles (UDM, UCG,
// Cloud Key Gen2+) and legacy self-hosted UniFi Network controllers. It registers as vendor "unifi".
//
// Mechanisms used:
//   - login:   POST /api/auth/login (UniFi OS, captures TOKEN/UOS_TOKEN cookie + X-CSRF-Token)
//              with automatic fallback to POST /api/login (legacy controller) on HTTP 404.
//   - info:    GET {api}/stat/sysinfo
//   - clients: merges GET {api}/stat/sta (active sessions, band, RSSI, SSID) and
//              GET {api}/rest/user (known & blocked clients)
//   - block:   POST {api}/cmd/stamgr {"cmd":"block-sta"|"unblock-sta","mac":"<mac>"}
//   - logout:  POST /api/auth/logout (UniFi OS) or POST /api/logout (legacy).
package unifi

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
const Vendor = "unifi"

const mechBlock = "UniFi station manager block (cmd/stamgr block-sta)"

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to a UniFi OS or legacy UniFi Network controller.
type Driver struct {
	target router.Target
	base   string
	http   *http.Client
	creds  router.CredentialSource

	loggedIn bool
	unifiOS  bool
	site     string
	cookies  [][]byte
	csrf     []byte
	info     *router.Info
}

// New builds a UniFi driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds, site: "default"}, nil
}

func (d *Driver) apiPrefix() string {
	if d.unifiOS {
		return "/proxy/network/api/s/" + d.site
	}
	return "/api/s/" + d.site
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

func (d *Driver) storeCookies(cs []*http.Cookie) {
	for _, c := range cs {
		kv := []byte(c.Name + "=" + c.Value)
		prefix := c.Name + "="
		replaced := false
		for i, existing := range d.cookies {
			if strings.HasPrefix(string(existing), prefix) {
				router.Zero(existing)
				d.cookies[i] = kv
				replaced = true
				break
			}
		}
		if !replaced {
			d.cookies = append(d.cookies, kv)
		}
	}
}

func (d *Driver) rawDo(ctx context.Context, op, method, path string, body []byte) (int, []byte, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
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
	if len(d.csrf) > 0 && method != http.MethodGet {
		req.Header.Set("X-CSRF-Token", string(d.csrf))
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return 0, nil, nil, router.TransportError(op, err)
	}
	defer resp.Body.Close()
	raw, err := router.ReadBody(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, resp.Header, err
	}
	d.storeCookies(resp.Cookies())
	if tok := resp.Header.Get("X-Csrf-Token"); tok != "" {
		router.Zero(d.csrf)
		d.csrf = []byte(tok)
	}
	return resp.StatusCode, raw, resp.Header, nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	uJSON, _ := json.Marshal(user)
	pJSON, _ := json.Marshal(string(pass))
	var buf bytes.Buffer
	buf.WriteString(`{"username":`)
	buf.Write(uJSON)
	buf.WriteString(`,"password":`)
	buf.Write(pJSON)
	buf.WriteString(`,"remember":false}`)
	router.Zero(pJSON)
	body := buf.Bytes()
	defer router.Zero(body)

	// Try UniFi OS first (/api/auth/login), then fall back to legacy (/api/login) on 404.
	status, raw, _, err := d.rawDo(ctx, "login", http.MethodPost, "/api/auth/login", body)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		d.unifiOS = false
		status, raw, _, err = d.rawDo(ctx, "login", http.MethodPost, "/api/login", body)
		if err != nil {
			return err
		}
	} else {
		d.unifiOS = true
	}

	switch status {
	case http.StatusOK:
		d.loggedIn = true
		// Discover first site if "default" isn't the only site.
		d.discoverSite(ctx)
		return nil
	case http.StatusUnauthorized, http.StatusForbidden:
		if strings.Contains(strings.ToLower(string(raw)), "lock") {
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "controller locked account"}
		}
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("HTTP %d", status)}
	case http.StatusTooManyRequests:
		return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "rate limited (HTTP 429)"}
	default:
		return router.Errorf(router.ErrProtocol, "login", "unexpected login status HTTP %d", status)
	}
}

func (d *Driver) discoverSite(ctx context.Context) {
	path := "/api/self/sites"
	if d.unifiOS {
		path = "/proxy/network/api/self/sites"
	}
	st, raw, _, err := d.rawDo(ctx, "sites", http.MethodGet, path, nil)
	if err != nil || st != http.StatusOK {
		return
	}
	var env struct {
		Data []struct {
			Name string `json:"name"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &env) != nil || len(env.Data) == 0 {
		return
	}
	for _, s := range env.Data {
		if s.Name == "default" {
			d.site = "default"
			return
		}
	}
	if env.Data[0].Name != "" {
		d.site = env.Data[0].Name
	}
}

func (d *Driver) call(ctx context.Context, op, method, relPath string, payload any) ([]map[string]any, error) {
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
	status, raw, _, err := d.rawDo(ctx, op, method, d.apiPrefix()+relPath, body)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		status, raw, _, err = d.rawDo(ctx, op, method, d.apiPrefix()+relPath, body)
		if err != nil {
			return nil, err
		}
	}
	if status == http.StatusForbidden {
		return nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "insufficient UniFi permissions (HTTP 403)"}
	}
	var env struct {
		Meta struct {
			RC  string `json:"rc"`
			Msg string `json:"msg"`
		} `json:"meta"`
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable UniFi reply (HTTP %d)", status)
	}
	if status != http.StatusOK || (env.Meta.RC != "" && env.Meta.RC != "ok") {
		return nil, router.Errorf(router.ErrRejected, op, "UniFi returned %q (%s)", env.Meta.RC, env.Meta.Msg)
	}
	return env.Data, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	data, err := d.call(ctx, "identify", http.MethodGet, "/stat/sysinfo", nil)
	if err != nil {
		return router.Info{}, err
	}
	info := router.Info{Vendor: "Ubiquiti", Model: "UniFi Network", Extra: map[string]string{"site": d.site}}
	if d.unifiOS {
		info.Extra["platform"] = "UniFi OS"
	} else {
		info.Extra["platform"] = "UniFi Controller"
	}
	if len(data) > 0 {
		row := data[0]
		if v := str(row["version"]); v != "" {
			info.Firmware = v
		}
		if m := first(str(row["ubnt_device_type"]), str(row["name"]), str(row["hostname"])); m != "" {
			info.Model = m
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
		{Capability: router.CapClients, Supported: true, Mechanism: "UniFi active stations (/stat/sta) and known clients (/rest/user)"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "UniFi stat/sta reports client IPs without DHCP lease expiry"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Disconnects and blocks the client MAC across the UniFi site"},
		{Capability: router.CapRateLimit, Supported: false, Note: "UniFi bandwidth limits are assigned via Wi-Fi profiles/user groups rather than per-device rates"},
		{Capability: router.CapSchedule, Supported: false, Note: "UniFi does not expose per-MAC blocking schedules via stamgr"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	active, err := d.call(ctx, "clients", http.MethodGet, "/stat/sta", nil)
	if err != nil {
		return nil, err
	}
	known, _ := d.call(ctx, "clients", http.MethodGet, "/rest/user", nil)

	byMAC := map[string]*router.Client{}
	for _, row := range known {
		mac, err := router.NormalizeMAC(str(row["mac"]))
		if err != nil {
			continue
		}
		f := false
		b := boolOf(row["blocked"])
		c := &router.Client{
			MAC:        mac,
			IP:         first(str(row["fixed_ip"]), str(row["last_ip"])),
			Hostname:   first(str(row["name"]), str(row["hostname"])),
			Connection: router.ConnUnknown,
			Active:     &f,
			Blocked:    &b,
			Raw:        toRaw(row),
		}
		if boolOf(row["use_fixedip"]) {
			c.Lease = &router.Lease{Source: "reserved"}
		}
		byMAC[mac] = c
	}

	for _, row := range active {
		mac, err := router.NormalizeMAC(str(row["mac"]))
		if err != nil {
			continue
		}
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		t := true
		c.Active = &t
		if ip := str(row["ip"]); ip != "" {
			c.IP = ip
		}
		if hn := first(str(row["name"]), str(row["hostname"])); hn != "" {
			c.Hostname = hn
		}
		if boolOf(row["is_wired"]) {
			c.Connection = router.ConnWired
			c.Interface = first(str(row["network"]), str(row["sw_port"]))
		} else {
			c.Connection = unifiRadio(str(row["radio"]), str(row["radio_proto"]))
			c.Interface = first(str(row["essid"]), str(row["network"]))
			if sig, ok := intOf(row["signal"]); ok && sig < 0 && sig > -120 {
				c.SignalDBm = &sig
			}
		}
		if _, has := row["blocked"]; has {
			b := boolOf(row["blocked"])
			c.Blocked = &b
		} else if c.Blocked == nil {
			f := false
			c.Blocked = &f
		}
		for k, v := range toRaw(row) {
			c.Raw[k] = v
		}
	}

	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	known, err := d.call(ctx, "blocked", http.MethodGet, "/rest/user", nil)
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, row := range known {
		if !boolOf(row["blocked"]) {
			continue
		}
		mac, err := router.NormalizeMAC(str(row["mac"]))
		if err != nil {
			continue
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      first(str(row["name"]), str(row["hostname"])),
			Mechanism: mechBlock,
			Owner:     router.OwnerUnknown, // UniFi keeps a single boolean per client without an owner tag.
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
			return router.Change{
				Action:          "block",
				MAC:             mac,
				Mechanism:       mechBlock,
				Applied:         false,
				AlreadyInEffect: true,
				Detail:          "client is already blocked in UniFi Network",
				Undo:            undoBlock(mac),
			}, nil
		}
	}
	_, err = d.call(ctx, "block", http.MethodPost, "/cmd/stamgr", map[string]string{"cmd": "block-sta", "mac": mac})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    "blocked client " + mac + " via UniFi stamgr",
		Undo:      undoBlock(mac),
	}, nil
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
		return router.Change{
			Action:          "unblock",
			MAC:             mac,
			Mechanism:       mechBlock,
			Applied:         false,
			AlreadyInEffect: true,
			Detail:          "client is not blocked in UniFi Network",
		}, nil
	}
	_, err = d.call(ctx, "unblock", http.MethodPost, "/cmd/stamgr", map[string]string{"cmd": "unblock-sta", "mac": mac})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    "unblocked client " + mac + " via UniFi stamgr",
		Undo:      "Block the device again in Nigafiy",
	}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if !d.loggedIn {
		return nil
	}
	path := "/api/logout"
	if d.unifiOS {
		path = "/api/auth/logout"
	}
	_, _, _, _ = d.rawDo(ctx, "logout", http.MethodPost, path, nil)
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or unblock %s under Client Devices → Blocked in UniFi Network", mac)
}

func unifiRadio(radio, proto string) router.ConnectionType {
	switch strings.ToLower(radio) {
	case "ng":
		return router.ConnWiFi24
	case "na":
		return router.ConnWiFi5
	case "6e":
		return router.ConnWiFi6
	}
	if strings.Contains(strings.ToLower(proto), "6e") {
		return router.ConnWiFi6
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

func boolOf(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

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

func toRaw(m map[string]any) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		if s := str(v); s != "" {
			out[k] = s
		}
	}
	return out
}
