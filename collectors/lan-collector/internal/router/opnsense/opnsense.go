// Package opnsense drives OPNsense firewalls via the built-in REST API (/api/*) using HTTP Basic
// Auth (API key as username, API secret as password). It registers itself as vendor "opnsense".
//
// Mechanisms used:
//   - identify: GET /api/core/firmware/info (fallback: /api/core/firmware/status)
//   - clients:  merges GET /api/diagnostics/interface/getArp (fallback: get_arp) and
//               POST /api/dhcpv4/leases/searchLease (fallback: /api/kea/leases4/search)
//   - block:    manages host alias "lan_detective_blocked" via /api/firewall/alias_util/{list,add,delete}
//               (creates the alias via /api/firewall/alias/addItem + /api/firewall/alias/reconfigure
//               when absent). Administrators reference this alias in a LAN block rule.
package opnsense

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "opnsense"

const (
	blockAlias = "lan_detective_blocked"
	mechBlock  = "OPNsense firewall host alias (lan_detective_blocked via /api/firewall/alias_util)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one OPNsense firewall over its REST API.
type Driver struct {
	target     router.Target
	base       string
	http       *http.Client
	creds      router.CredentialSource
	authHeader []byte
	info       *router.Info
}

// New builds an OPNsense driver for t.
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
	key, secret, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(secret)
	raw := make([]byte, 0, len(key)+1+len(secret))
	raw = append(raw, key...)
	raw = append(raw, ':')
	raw = append(raw, secret...)
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
			return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "cannot encode body")
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
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrBadCredentials, Op: op, Detail: "OPNsense rejected API key/secret (HTTP 401)"}
	case http.StatusForbidden:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "API key lacks required OPNsense privileges (HTTP 403)"}
	case http.StatusTooManyRequests:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrLockedOut, Op: op, Detail: "HTTP 429"}
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	status, raw, err := d.do(ctx, "identify", http.MethodGet, "/api/core/firmware/info", nil)
	if err != nil {
		return router.Info{}, err
	}
	if status == http.StatusNotFound {
		status, raw, err = d.do(ctx, "identify", http.MethodGet, "/api/core/firmware/status", nil)
		if err != nil {
			return router.Info{}, err
		}
	}
	if status != http.StatusOK {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "OPNsense firmware endpoint returned HTTP %d", status)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unreadable OPNsense firmware JSON")
	}
	ver := first(str(m["product_version"]), nestedStr(m, "product", "product_version"))
	name := first(str(m["product_name"]), nestedStr(m, "product", "product_name"), "OPNsense")
	if ver == "" && !strings.Contains(strings.ToLower(name), "opnsense") {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not an OPNsense API response")
	}
	info := router.Info{Vendor: "OPNsense", Model: name, Firmware: ver, Extra: map[string]string{}}
	if abi := first(str(m["product_abi"]), nestedStr(m, "product", "product_abi")); abi != "" {
		info.Extra["abi"] = abi
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
		{Capability: router.CapClients, Supported: true, Mechanism: "OPNsense ARP table (/api/diagnostics/interface/getArp) and DHCPv4 leases"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "OPNsense DHCPv4 / Kea lease API"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Adds/removes the device IP in alias lan_detective_blocked (requires a LAN block rule matching this alias)"},
		{Capability: router.CapRateLimit, Supported: false, Note: "OPNsense traffic shaping uses dummynet pipes/queues configured per policy"},
		{Capability: router.CapSchedule, Supported: false, Note: "OPNsense schedules attach to firewall rules rather than individual MAC entries"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: false, Note: "OPNsense is a dedicated firewall; manage Wi-Fi on your access points"},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: false, Note: portForwardNote(d.info.Firmware)},
		{Capability: router.CapRename, Supported: false, Note: "OPNsense does not expose a separate client alias API"},
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

	// 1. ARP table (getArp on 24.x, get_arp on newer snake_case core)
	st, raw, err := d.do(ctx, "clients", http.MethodGet, "/api/diagnostics/interface/getArp", nil)
	if err != nil {
		return nil, nil, err
	}
	if st == http.StatusNotFound {
		st, raw, err = d.do(ctx, "clients", http.MethodGet, "/api/diagnostics/interface/get_arp", nil)
		if err != nil {
			return nil, nil, err
		}
	}
	if st != http.StatusOK {
		return nil, nil, router.Errorf(router.ErrProtocol, "clients", "getArp returned HTTP %d", st)
	}
	var arps []map[string]any
	if err := json.Unmarshal(raw, &arps); err != nil {
		return nil, nil, router.Errorf(router.ErrProtocol, "clients", "unexpected ARP table JSON")
	}
	for _, a := range arps {
		mac, err := router.NormalizeMAC(str(a["mac"]))
		if err != nil {
			continue
		}
		c := ensure(mac)
		if ip := str(a["ip"]); ip != "" {
			c.IP = ip
			ipToMAC[ip] = mac
		}
		if hn := str(a["hostname"]); hn != "" && hn != "?" {
			c.Hostname = hn
		}
		if iface := first(str(a["intf_description"]), str(a["intf"])); iface != "" {
			c.Interface = iface
		}
		active := !boolOf(a["expired"])
		c.Active = &active
		for k, v := range a {
			if s := str(v); s != "" {
				c.Raw["arp."+k] = s
			}
		}
	}

	// 2. DHCPv4 leases (ISC DHCP or Kea)
	leaseReq := map[string]any{"current": 1, "rowCount": -1, "searchPhrase": "", "inactive": true}
	lst, lraw, lerr := d.do(ctx, "clients", http.MethodPost, "/api/dhcpv4/leases/searchLease", leaseReq)
	if lerr == nil && lst == http.StatusNotFound {
		lst, lraw, lerr = d.do(ctx, "clients", http.MethodPost, "/api/kea/leases4/search", leaseReq)
	}
	if lerr == nil && lst == http.StatusOK {
		var env struct {
			Rows []map[string]any `json:"rows"`
		}
		if json.Unmarshal(lraw, &env) == nil {
			for _, row := range env.Rows {
				mac, err := router.NormalizeMAC(first(str(row["mac"]), str(row["hwaddr"])))
				if err != nil {
					continue
				}
				c := ensure(mac)
				if ip := str(row["address"]); ip != "" {
					if c.IP == "" {
						c.IP = ip
					}
					ipToMAC[ip] = mac
				}
				if hn := first(str(row["hostname"]), str(row["descr"])); hn != "" && c.Hostname == "" {
					c.Hostname = hn
				}
				src := "dhcp"
				if strings.EqualFold(str(row["type"]), "static") {
					src = "reserved"
				}
				c.Lease = &router.Lease{Source: src}
				if c.Active == nil {
					on := strings.EqualFold(str(row["status"]), "online") || strings.EqualFold(str(row["state"]), "active")
					c.Active = &on
				}
				for k, v := range row {
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

func (d *Driver) aliasIPs(ctx context.Context, op string) ([]string, bool, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/firewall/alias_util/list/"+blockAlias, nil)
	if err != nil {
		return nil, false, err
	}
	if st == http.StatusNotFound {
		return nil, false, nil
	}
	if st != http.StatusOK {
		return nil, false, router.Errorf(router.ErrProtocol, op, "alias_util/list returned HTTP %d", st)
	}
	var env struct {
		Rows []struct {
			IP string `json:"ip"`
		} `json:"rows"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, false, nil
	}
	ips := make([]string, 0, len(env.Rows))
	for _, r := range env.Rows {
		if ip := strings.TrimSpace(r.IP); ip != "" {
			ips = append(ips, ip)
		}
	}
	return ips, true, nil
}

func (d *Driver) ensureBlockAlias(ctx context.Context, op string) error {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/firewall/alias_util/aliases", nil)
	if err != nil {
		return err
	}
	if st == http.StatusOK {
		var names []string
		if json.Unmarshal(raw, &names) == nil {
			for _, n := range names {
				if n == blockAlias {
					return nil
				}
			}
		}
	}
	addPayload := map[string]any{
		"alias": map[string]any{
			"enabled":     "1",
			"name":        blockAlias,
			"type":        "host",
			"content":     "",
			"description": "Managed by Nigafiy",
		},
	}
	st, _, err = d.do(ctx, op, http.MethodPost, "/api/firewall/alias/addItem", addPayload)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "cannot create OPNsense alias %s (HTTP %d)", blockAlias, st)
	}
	_, _, err = d.do(ctx, op, http.MethodPost, "/api/firewall/alias/reconfigure", map[string]any{})
	return err
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	clients, _, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	blockedIPs := map[string]bool{}
	if ips, ok, err := d.aliasIPs(ctx, "clients"); err == nil && ok {
		for _, ip := range ips {
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
	ips, ok, err := d.aliasIPs(ctx, "blocked")
	if err != nil || !ok || len(ips) == 0 {
		return nil, err
	}
	_, ipToMAC, err := d.readClientsRaw(ctx)
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, ip := range ips {
		mac := ipToMAC[ip]
		if mac == "" {
			continue
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Mechanism: mechBlock,
			Owner:     router.OwnerProduct,
			Detail:    "IP " + ip + " in alias " + blockAlias,
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
		return router.Change{}, router.Errorf(router.ErrNotFound, "block", "OPNsense has no IPv4 address for %s in ARP/DHCP", mac)
	}
	if err := d.ensureBlockAlias(ctx, "block"); err != nil {
		return router.Change{}, err
	}
	ips, _, _ := d.aliasIPs(ctx, "block")
	for _, cur := range ips {
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
	st, _, err := d.do(ctx, "block", http.MethodPost, "/api/firewall/alias_util/add/"+blockAlias, map[string]string{"address": ip})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "alias_util/add failed (HTTP %d)", st)
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("added %s (%s) to OPNsense alias %s", ip, mac, blockAlias),
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
		return router.Change{}, router.Errorf(router.ErrNotFound, "unblock", "OPNsense has no IPv4 address for %s in ARP/DHCP", mac)
	}
	ips, ok, err := d.aliasIPs(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	present := false
	if ok {
		for _, cur := range ips {
			if cur == ip {
				present = true
				break
			}
		}
	}
	if !present {
		return router.Change{
			Action:          "unblock",
			MAC:             mac,
			Mechanism:       mechBlock,
			Applied:         false,
			AlreadyInEffect: true,
			Detail:          ip + " is not in alias " + blockAlias,
		}, nil
	}
	st, _, err := d.do(ctx, "unblock", http.MethodPost, "/api/firewall/alias_util/delete/"+blockAlias, map[string]string{"address": ip})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "alias_util/delete failed (HTTP %d)", st)
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("removed %s from OPNsense alias %s", ip, blockAlias),
		Undo:      "Block the device again in Nigafiy",
	}, nil
}

func (d *Driver) Close(context.Context) error {
	router.Zero(d.authHeader)
	d.authHeader = nil
	return nil
}

func undoBlock(ip string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or remove %s from Firewall → Diagnostics → Aliases (%s) in OPNsense", ip, blockAlias)
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func nestedStr(m map[string]any, keys ...string) string {
	cur := m
	for i, k := range keys {
		if i == len(keys)-1 {
			return str(cur[k])
		}
		next, ok := cur[k].(map[string]any)
		if !ok {
			return ""
		}
		cur = next
	}
	return ""
}

func boolOf(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// portForwardNote explains the refusal of port-forward changes. Older releases manage destination NAT
// only through legacy pages; newer ones add a destination-NAT API (/api/firewall/d_nat) whose rule
// format changed between releases and has not been verified against a real firewall, so this driver
// does not write it. The detected firmware is named so the administrator knows what was checked.
func portForwardNote(firmware string) string {
	fw := strings.TrimSpace(firmware)
	if fw == "" {
		fw = "unknown version"
	}
	return "Port forwards are not changed on OPNsense (firmware " + fw + "): the destination-NAT API differs between releases and is not verified, so manage them under Firewall → NAT → Port Forward"
}
