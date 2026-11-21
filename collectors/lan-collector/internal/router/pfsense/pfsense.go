// Package pfsense drives Netgate pfSense firewalls with the pfSense REST API v2 package
// (pfSense-pkg-RESTAPI, /api/v2/*). It registers itself as vendor "pfsense".
//
// Authentication:
//   - If username is "api-key", "x-api-key" or "token" (case-insensitive), password is sent as
//     "X-API-Key: <password>".
//   - Otherwise standard HTTP Basic Auth ("Authorization: Basic ...") is used.
//
// Mechanisms used:
//   - identify: GET /api/v2/system/version
//   - clients:  merges GET /api/v2/diagnostics/arp_table and GET /api/v2/services/dhcp_server/leases
//   - block:    manages host alias "lan_detective_blocked" via /api/v2/firewall/aliases,
//               POST/PATCH /api/v2/firewall/alias, and POST /api/v2/firewall/apply.
package pfsense

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

// Vendor is the registry key.
const Vendor = "pfsense"

const (
	blockAlias = "lan_detective_blocked"
	mechBlock  = "pfSense firewall host alias (lan_detective_blocked via REST API v2)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one pfSense firewall over REST API v2.
type Driver struct {
	target    router.Target
	base      string
	http      *http.Client
	creds     router.CredentialSource
	authName  string
	authValue []byte
	info      *router.Info
}

// New builds a pfSense driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) ensureAuth(ctx context.Context) error {
	if len(d.authValue) > 0 {
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
	if lu == "api-key" || lu == "x-api-key" || lu == "token" {
		d.authName = "X-API-Key"
		d.authValue = append([]byte(nil), pass...)
		return nil
	}
	raw := make([]byte, 0, len(user)+1+len(pass))
	raw = append(raw, user...)
	raw = append(raw, ':')
	raw = append(raw, pass...)
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	router.Zero(raw)
	d.authName = "Authorization"
	d.authValue = append([]byte("Basic "), enc...)
	router.Zero(enc)
	return nil
}

func (d *Driver) do(ctx context.Context, op, method, path string, body any) (int, json.RawMessage, error) {
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
	req.Header.Set(d.authName, string(d.authValue))
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
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrBadCredentials, Op: op, Detail: "pfSense rejected credentials/API key (HTTP 401)"}
	case http.StatusForbidden:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "pfSense API privileges insufficient (HTTP 403)"}
	case http.StatusTooManyRequests:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrLockedOut, Op: op, Detail: "HTTP 429"}
	}
	var env struct {
		Status  string          `json:"status"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return resp.StatusCode, nil, router.Errorf(router.ErrProtocol, op, "unreadable pfSense REST API v2 response (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode >= 400 || (env.Status != "" && env.Status != "ok") {
		return resp.StatusCode, nil, router.Errorf(router.ErrRejected, op, "pfSense HTTP %d: %s", resp.StatusCode, env.Message)
	}
	return resp.StatusCode, env.Data, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	_, data, err := d.do(ctx, "identify", http.MethodGet, "/api/v2/system/version", nil)
	if err != nil {
		return router.Info{}, err
	}
	var v struct {
		Version string `json:"version"`
		Base    string `json:"base"`
		Patch   string `json:"patch"`
	}
	if err := json.Unmarshal(data, &v); err != nil || v.Version == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a pfSense REST API v2 version payload")
	}
	info := router.Info{Vendor: "Netgate pfSense", Model: "pfSense", Firmware: v.Version, Extra: map[string]string{}}
	if v.Base != "" {
		info.Extra["base"] = v.Base
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
		{Capability: router.CapClients, Supported: true, Mechanism: "pfSense REST API v2 ARP table and DHCP server leases"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "/api/v2/services/dhcp_server/leases"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Manages host alias lan_detective_blocked (requires a LAN block rule referencing this alias)"},
		{Capability: router.CapRateLimit, Supported: false, Note: "pfSense limiters require policy-specific pipe rules"},
		{Capability: router.CapSchedule, Supported: false, Note: "pfSense schedules are attached to firewall rules rather than per-MAC entries"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: false, Note: "pfSense is a dedicated firewall; manage Wi-Fi on your access points"},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: false, Note: "pfSense does not keep a separate client alias table outside DHCP static mappings"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) readClientsRaw(ctx context.Context) ([]router.Client, map[string]string, error) {
	byMAC := map[string]*router.Client{}
	ipToMAC := map[string]string{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnWired, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	_, arpData, err := d.do(ctx, "clients", http.MethodGet, "/api/v2/diagnostics/arp_table", nil)
	if err != nil {
		return nil, nil, err
	}
	var arps []map[string]any
	if err := json.Unmarshal(arpData, &arps); err != nil {
		return nil, nil, router.Errorf(router.ErrProtocol, "clients", "unexpected ARP table format")
	}
	for _, a := range arps {
		mac, err := router.NormalizeMAC(first(str(a["mac_address"]), str(a["mac"])))
		if err != nil {
			continue
		}
		c := ensure(mac)
		if ip := first(str(a["ip_address"]), str(a["ip"])); ip != "" {
			c.IP = ip
			ipToMAC[ip] = mac
		}
		if hn := str(a["hostname"]); hn != "" && hn != "?" {
			c.Hostname = hn
		}
		if iface := str(a["interface"]); iface != "" {
			c.Interface = iface
		}
		active := !strings.EqualFold(str(a["status"]), "expired")
		c.Active = &active
		for k, v := range a {
			if s := str(v); s != "" {
				c.Raw["arp."+k] = s
			}
		}
	}

	if _, leaseData, lerr := d.do(ctx, "clients", http.MethodGet, "/api/v2/services/dhcp_server/leases", nil); lerr == nil {
		var leases []map[string]any
		if json.Unmarshal(leaseData, &leases) == nil {
			for _, l := range leases {
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
				src := "dhcp"
				if strings.EqualFold(str(l["type"]), "static") {
					src = "reserved"
				}
				c.Lease = &router.Lease{Source: src}
				if c.Active == nil {
					on := strings.EqualFold(str(l["online_status"]), "active/online") || strings.EqualFold(str(l["active_status"]), "active")
					c.Active = &on
				}
				for k, v := range l {
					if s := str(v); s != "" {
						c.Raw["dhcp."+k] = s
					}
				}
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

type pfAlias struct {
	ID      *int     `json:"id"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Descr   string   `json:"descr"`
	Address []string `json:"address"`
	Detail  []string `json:"detail"`
}

func (d *Driver) findBlockAlias(ctx context.Context, op string) (*pfAlias, error) {
	_, data, err := d.do(ctx, op, http.MethodGet, "/api/v2/firewall/aliases", nil)
	if err != nil {
		return nil, err
	}
	var list []pfAlias
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unexpected aliases list")
	}
	for i := range list {
		if list[i].Name == blockAlias {
			return &list[i], nil
		}
	}
	return nil, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	blockedIPs := map[string]bool{}
	if al, err := d.findBlockAlias(ctx, "clients"); err == nil && al != nil {
		for _, ip := range al.Address {
			blockedIPs[ip] = true
		}
	}
	for i := range clients {
		b := clients[i].IP != "" && blockedIPs[clients[i].IP]
		clients[i].Blocked = &b
	}
	return clients, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	al, err := d.findBlockAlias(ctx, "blocked")
	if err != nil || al == nil || len(al.Address) == 0 {
		return nil, err
	}
	_, ipToMAC, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for i, ip := range al.Address {
		mac := ipToMAC[ip]
		if mac == "" && i < len(al.Detail) && strings.HasPrefix(al.Detail[i], "lan-detective:") {
			mac = strings.TrimPrefix(al.Detail[i], "lan-detective:")
		}
		if m, err := router.NormalizeMAC(mac); err == nil {
			out = append(out, router.BlockEntry{
				MAC:       m,
				Mechanism: mechBlock,
				Owner:     router.OwnerProduct,
				Detail:    "IP " + ip + " in alias " + blockAlias,
				Managed:   true,
			})
		}
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
		return router.Change{}, router.Errorf(router.ErrNotFound, "block", "pfSense has no IPv4 address for %s in ARP/DHCP", mac)
	}
	al, err := d.findBlockAlias(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	if al != nil {
		for _, cur := range al.Address {
			if cur == ip {
				return router.Change{
					Action:          "block",
					MAC:             mac,
					Mechanism:       mechBlock,
					Applied:         false,
					AlreadyInEffect: true,
					Detail:          ip + " is already in alias " + blockAlias,
					Undo:            undoBlock(ip),
				}, nil
			}
		}
		addrs := append(append([]string(nil), al.Address...), ip)
		details := padDetails(al.Detail, len(al.Address))
		details = append(details, "lan-detective:"+mac)
		if _, _, err := d.do(ctx, "block", http.MethodPatch, "/api/v2/firewall/alias", map[string]any{
			"id": al.ID, "name": blockAlias, "type": "host", "address": addrs, "detail": details,
		}); err != nil {
			return router.Change{}, err
		}
	} else {
		if _, _, err := d.do(ctx, "block", http.MethodPost, "/api/v2/firewall/alias", map[string]any{
			"name":    blockAlias,
			"type":    "host",
			"descr":   "Managed by LAN Detective",
			"address": []string{ip},
			"detail":  []string{"lan-detective:" + mac},
		}); err != nil {
			return router.Change{}, err
		}
	}
	if _, _, err := d.do(ctx, "block", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("added %s (%s) to pfSense alias %s and applied firewall", ip, mac, blockAlias),
		Undo:      undoBlock(ip),
	}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	al, err := d.findBlockAlias(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	if al == nil {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "managed alias does not exist"}, nil
	}
	clients, _, _ := d.readClientsRaw(ctx)
	var ip string
	for _, c := range clients {
		if c.MAC == mac && c.IP != "" {
			ip = c.IP
			break
		}
	}
	details := padDetails(al.Detail, len(al.Address))
	var nextAddrs, nextDetails []string
	removed := false
	for i, cur := range al.Address {
		if (ip != "" && cur == ip) || details[i] == "lan-detective:"+mac {
			removed = true
			continue
		}
		nextAddrs = append(nextAddrs, cur)
		nextDetails = append(nextDetails, details[i])
	}
	if !removed {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "device is not in managed alias"}, nil
	}
	if nextAddrs == nil {
		nextAddrs = []string{}
		nextDetails = []string{}
	}
	if _, _, err := d.do(ctx, "unblock", http.MethodPatch, "/api/v2/firewall/alias", map[string]any{
		"id": al.ID, "name": blockAlias, "type": "host", "address": nextAddrs, "detail": nextDetails,
	}); err != nil {
		return router.Change{}, err
	}
	if _, _, err := d.do(ctx, "unblock", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("removed %s from pfSense alias %s and applied firewall", mac, blockAlias),
		Undo:      "Block the device again in LAN Detective",
	}, nil
}

func (d *Driver) Close(context.Context) error {
	router.Zero(d.authValue)
	d.authValue = nil
	return nil
}

func undoBlock(ip string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s from Firewall → Aliases (%s) in pfSense", ip, blockAlias)
}

func padDetails(d []string, n int) []string {
	out := make([]string, n)
	copy(out, d)
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
