// Package fortigate drives Fortinet FortiGate firewalls running FortiOS via the REST API
// (/api/v2/monitor/*). It registers itself as vendor "fortigate".
//
// Authentication:
//   - Recommended: FortiOS REST API Admin token (enter username "api" or "token" and the API token
//     as the password → sent as "Authorization: Bearer <token>").
//   - Fallback: standard FortiOS administrator username/password via POST /logincheck with
//     ccsrftoken CSRF cookie, logged out cleanly via POST /logout.
//
// Mechanisms used:
//   - identify: GET /api/v2/monitor/system/status
//   - clients:  merges GET /api/v2/monitor/user/device/query and GET /api/v2/monitor/system/dhcp
//   - block:    FortiOS User Quarantine (banned users): GET /api/v2/monitor/user/banned/select,
//               POST /api/v2/monitor/user/banned/add_users and clear_users.
//   - rename:   description of the device's DHCP reserved address (rename.go)
//   - Wi-Fi:    SSID (wireless-controller VAP) interface status up/down (wifi.go)
package fortigate

import (
	"bytes"
	"context"
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
const Vendor = "fortigate"

const mechBlock = "FortiGate user quarantine (/api/v2/monitor/user/banned)"

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one FortiGate firewall over FortiOS REST API.
type Driver struct {
	target    router.Target
	base      string
	http      *http.Client
	creds     router.CredentialSource
	bearer    []byte
	cookies   [][]byte
	csrfToken []byte
	loggedIn  bool
	info      *router.Info
}

// New builds a FortiGate driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	router.Zero(d.bearer)
	router.Zero(d.csrfToken)
	for _, c := range d.cookies {
		router.Zero(c)
	}
	d.bearer = nil
	d.csrfToken = nil
	d.cookies = nil
	d.loggedIn = false
}

func (d *Driver) ensureAuth(ctx context.Context) error {
	if len(d.bearer) > 0 || d.loggedIn {
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

	lu := strings.ToLower(strings.TrimSpace(user))
	if lu == "" || lu == "api" || lu == "token" || lu == "bearer" || lu == "api-token" {
		d.bearer = append([]byte("Bearer "), pass...)
		return nil
	}

	// Session login via /logincheck.
	form := url.Values{}
	form.Set("username", user)
	form.Set("secretkey", string(pass))
	form.Set("ajax", "1")
	body := []byte(form.Encode())
	defer router.Zero(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+"/logincheck", bytes.NewReader(body))
	if err != nil {
		return router.Errorf(router.ErrInvalidArgument, "login", "bad request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := d.http.Do(req)
	if err != nil {
		return router.TransportError("login", err)
	}
	defer resp.Body.Close()
	raw, _ := router.ReadBody(resp.Body)
	txt := strings.TrimSpace(string(raw))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || strings.HasPrefix(txt, "0") {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "FortiGate rejected login"}
	}
	if strings.HasPrefix(txt, "2") || strings.Contains(strings.ToLower(txt), "lock") {
		return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "FortiGate temporarily locked account"}
	}
	for _, c := range resp.Cookies() {
		d.cookies = append(d.cookies, []byte(c.Name+"="+c.Value))
		if strings.HasPrefix(strings.ToLower(c.Name), "ccsrftoken") {
			tok := strings.Trim(c.Value, `"`)
			if tok != "" {
				router.Zero(d.csrfToken)
				d.csrfToken = []byte(tok)
			}
		}
	}
	if len(d.cookies) == 0 {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "no session cookie returned"}
	}
	d.loggedIn = true
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
			return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "cannot encode body")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if len(d.bearer) > 0 {
		req.Header.Set("Authorization", string(d.bearer))
	} else if len(d.cookies) > 0 {
		parts := make([]string, len(d.cookies))
		for i, c := range d.cookies {
			parts[i] = string(c)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
		if len(d.csrfToken) > 0 && method != http.MethodGet {
			req.Header.Set("X-CSRFTOKEN", string(d.csrfToken))
		}
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
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrBadCredentials, Op: op, Detail: "FortiOS rejected token/session (HTTP 401)"}
	case http.StatusForbidden:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "FortiOS API profile lacks access (HTTP 403)"}
	case http.StatusTooManyRequests:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrLockedOut, Op: op, Detail: "HTTP 429"}
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	st, raw, err := d.do(ctx, "identify", http.MethodGet, "/api/v2/monitor/system/status", nil)
	if err != nil {
		return router.Info{}, err
	}
	if st != http.StatusOK {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "FortiOS status returned HTTP %d", st)
	}
	var rep struct {
		Version string `json:"version"`
		Build   int    `json:"build"`
		Serial  string `json:"serial"`
		Status  string `json:"status"`
		Results struct {
			Model     string `json:"model"`
			ModelName string `json:"model_name"`
			Hostname  string `json:"hostname"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil || rep.Version == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a FortiOS REST API response")
	}
	fw := rep.Version
	if rep.Build > 0 {
		fw = fmt.Sprintf("%s (build %d)", rep.Version, rep.Build)
	}
	info := router.Info{
		Vendor:   "Fortinet",
		Model:    first(rep.Results.ModelName, rep.Results.Model, "FortiGate"),
		Firmware: fw,
		Extra:    map[string]string{},
	}
	if rep.Serial != "" {
		info.Extra["serial"] = rep.Serial
	}
	if rep.Results.Hostname != "" {
		info.Extra["hostname"] = rep.Results.Hostname
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
		{Capability: router.CapClients, Supported: true, Mechanism: "FortiOS device inventory (/api/v2/monitor/user/device/query) and DHCP monitor"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "/api/v2/monitor/system/dhcp"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Quarantines/bans the device IP via FortiOS banned users monitor"},
		{Capability: router.CapRateLimit, Supported: false, Note: "FortiGate traffic shaping uses firewall shaping policies"},
		{Capability: router.CapSchedule, Supported: false, Note: "FortiGate schedules attach to firewall policies"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		d.wifiCapability(ctx),
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward, Note: "Creates/removes FortiOS Virtual IPs (attach a WAN→LAN policy permitting the VIP if needed)"},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename, Requires: router.RequiresReservation, Note: "The device inventory is read-only in the FortiOS API, so the name is stored as the description of the device's DHCP reservation; the device needs a reservation first"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) readClientsRaw(ctx context.Context) ([]router.Client, map[string]string, error) {
	byMAC := map[string]*router.Client{}
	ipToMAC := map[string]string{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnUnknown, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	st, raw, err := d.do(ctx, "clients", http.MethodGet, "/api/v2/monitor/user/device/query", nil)
	if err != nil {
		return nil, nil, err
	}
	if st == http.StatusOK {
		var rep struct {
			Results []map[string]any `json:"results"`
		}
		if json.Unmarshal(raw, &rep) == nil {
			for _, dev := range rep.Results {
				mac, err := router.NormalizeMAC(str(dev["mac"]))
				if err != nil {
					continue
				}
				c := ensure(mac)
				if ip := first(str(dev["ipv4_address"]), str(dev["ip"])); ip != "" {
					c.IP = ip
					ipToMAC[ip] = mac
				}
				if hn := first(str(dev["hostname"]), str(dev["host_src"])); hn != "" {
					c.Hostname = hn
				}
				if ssid := str(dev["ssid"]); ssid != "" {
					c.Connection = router.ConnWiFi
					c.Interface = ssid
				} else {
					c.Connection = router.ConnWired
					c.Interface = str(dev["detected_interface"])
				}
				if on, ok := dev["is_online"].(bool); ok {
					c.Active = &on
				}
				for k, v := range dev {
					if s := str(v); s != "" {
						c.Raw["dev."+k] = s
					}
				}
			}
		}
	}

	if dst, draw, derr := d.do(ctx, "clients", http.MethodGet, "/api/v2/monitor/system/dhcp", nil); derr == nil && dst == http.StatusOK {
		var rep struct {
			Results []map[string]any `json:"results"`
		}
		if json.Unmarshal(draw, &rep) == nil {
			now := time.Now().Unix()
			for _, l := range rep.Results {
				mac, err := router.NormalizeMAC(str(l["mac"]))
				if err != nil {
					continue
				}
				c := ensure(mac)
				if ip := str(l["ip"]); ip != "" {
					if c.IP == "" {
						c.IP = ip
					}
					ipToMAC[ip] = mac
				}
				if hn := str(l["hostname"]); hn != "" && c.Hostname == "" {
					c.Hostname = hn
				}
				if iface := str(l["interface"]); iface != "" && c.Interface == "" {
					c.Interface = iface
				}
				src := "dhcp"
				if b, ok := l["reserved"].(bool); ok && b {
					src = "reserved"
				}
				lease := &router.Lease{Source: src}
				if exp, ok := l["expire_time"].(float64); ok && int64(exp) > now {
					rem := time.Duration(int64(exp)-now) * time.Second
					lease.Remaining = &rem
				}
				c.Lease = lease
			}
		}
	}

	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, ipToMAC, nil
}

type bannedRow struct {
	IPAddress string `json:"ip_address"`
	Cause     string `json:"cause"`
	Source    string `json:"source"`
}

func (d *Driver) readBanned(ctx context.Context, op string) ([]bannedRow, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/v2/monitor/user/banned/select", nil)
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "banned/select returned HTTP %d", st)
	}
	var rep struct {
		Results []bannedRow `json:"results"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable banned/select JSON")
	}
	return rep.Results, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	bannedIPs := map[string]bool{}
	if rows, err := d.readBanned(ctx, "clients"); err == nil {
		for _, r := range rows {
			bannedIPs[r.IPAddress] = true
		}
	}
	for i := range clients {
		b := clients[i].IP != "" && bannedIPs[clients[i].IP]
		clients[i].Blocked = &b
	}
	return clients, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	rows, err := d.readBanned(ctx, "blocked")
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	_, ipToMAC, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, r := range rows {
		mac := ipToMAC[r.IPAddress]
		if mac == "" {
			continue
		}
		owner := router.OwnerUnknown
		if strings.EqualFold(r.Cause, "IPS") || strings.EqualFold(r.Cause, "AV") || strings.EqualFold(r.Cause, "DLP") {
			owner = router.OwnerAdmin
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Mechanism: mechBlock,
			Owner:     owner,
			Detail:    strings.TrimSpace("IP " + r.IPAddress + " " + r.Cause + " " + r.Source),
			Managed:   owner != router.OwnerAdmin,
		})
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	clients, _, err := d.readClientsRaw(ctx)
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
		return router.Change{}, router.Errorf(router.ErrNotFound, "block", "FortiGate has no IPv4 address for %s", mac)
	}
	banned, err := d.readBanned(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	for _, b := range banned {
		if b.IPAddress == ip {
			return router.Change{
				Action:          "block",
				MAC:             mac,
				Mechanism:       mechBlock,
				Applied:         false,
				AlreadyInEffect: true,
				Detail:          ip + " is already in FortiGate banned users",
				Undo:            undoBlock(ip),
			}, nil
		}
	}
	st, _, err := d.do(ctx, "block", http.MethodPost, "/api/v2/monitor/user/banned/add_users", map[string]any{
		"ip_addresses": []string{ip},
		"expiry":       0,
	})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "banned/add_users returned HTTP %d", st)
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("quarantined %s (%s) on FortiGate", ip, mac),
		Undo:      undoBlock(ip),
	}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	clients, _, err := d.readClientsRaw(ctx)
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
		return router.Change{}, router.Errorf(router.ErrNotFound, "unblock", "FortiGate has no IPv4 address for %s", mac)
	}
	banned, err := d.readBanned(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	found := false
	for _, b := range banned {
		if b.IPAddress == ip {
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
			Detail:          ip + " is not quarantined on FortiGate",
		}, nil
	}
	st, _, err := d.do(ctx, "unblock", http.MethodPost, "/api/v2/monitor/user/banned/clear_users", map[string]any{
		"ip_addresses": []string{ip},
	})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "banned/clear_users returned HTTP %d", st)
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("cleared quarantine for %s on FortiGate", ip),
		Undo:      "Block the device again in Nigafiy",
	}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		_, _, _ = d.do(ctx, "logout", http.MethodPost, "/logout", nil)
	}
	return nil
}

func undoBlock(ip string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or remove %s under Dashboard → User Quarantine Monitor in FortiGate", ip)
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

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// wifiCapability offers Wi-Fi only when the firewall lists wireless-controller SSIDs with a local
// interface (a FortiWiFi, or a FortiGate managing FortiAPs).
func (d *Driver) wifiCapability(ctx context.Context) router.CapabilityStatus {
	nets, ok, err := d.readWiFi(ctx, "capabilities")
	switch {
	case err != nil:
		return router.CapabilityStatus{Capability: router.CapWiFi, Supported: false, Note: "Could not read the SSIDs (wireless-controller VAPs); give the API profile read/write access to WiFi & Switch and Network"}
	case !ok:
		return router.CapabilityStatus{Capability: router.CapWiFi, Supported: false, Note: "This FortiGate has no wireless controller (no /api/v2/cmdb/wireless-controller/vap)"}
	case len(nets) == 0:
		return router.CapabilityStatus{Capability: router.CapWiFi, Supported: false, Note: "No SSID with a local interface is configured on this FortiGate"}
	}
	return router.CapabilityStatus{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi, Note: "Turning an SSID off takes its interface down; FortiOS has no guest/main flag, so every SSID asks for confirmation"}
}
