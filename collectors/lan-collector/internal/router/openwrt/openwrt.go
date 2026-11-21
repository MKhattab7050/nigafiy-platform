// Package openwrt drives OpenWrt routers via the standard ubus JSON-RPC over HTTP(S) endpoint
// (/ubus, provided by uhttpd-mod-ubus + rpcd-mod-luci). It registers itself as vendor "openwrt".
//
// Mechanisms used:
//   - login/logout: ubus session.login / session.destroy
//   - identify:     ubus system.board
//   - clients:      merges luci-rpc.getDHCPLeases, luci-rpc.getHostHints, and iwinfo.devices + assoclist
//   - block:        uci.add/set/delete/commit firewall rule (src=lan, dest=wan, src_mac=<mac>,
//                   target=REJECT, name="lan-detective:block:<mac>") + luci.setInitAction("firewall","reload")
//   - schedule:     uci firewall rule with start_time, stop_time, weekdays and
//                   name="lan-detective:schedule:<mac>".
package openwrt

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

// Vendor is the registry key.
const Vendor = "openwrt"

const (
	zeroSession           = "00000000000000000000000000000000"
	blockNamePrefix       = "lan-detective:block:"
	scheduleNamePrefix    = "lan-detective:schedule:"
	mechBlock             = "OpenWrt UCI firewall rule (lan → wan, src_mac, REJECT)"
	mechSchedule          = "OpenWrt UCI scheduled firewall rule (src_mac, start_time/stop_time/weekdays)"
	ubusStatusOK          = 0
	ubusStatusPermDenied  = 6
	ubusStatusNotFound    = 4
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var (
	_ router.Driver    = (*Driver)(nil)
	_ router.Scheduler = (*Driver)(nil)
)

// Driver talks to one OpenWrt router over /ubus JSON-RPC.
type Driver struct {
	target router.Target
	base   string
	http   *http.Client
	creds  router.CredentialSource

	rpcID   int
	session []byte // ubus_rpc_session token, zeroed in Close
	info    *router.Info
}

// New builds an OpenWrt driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	ID     int               `json:"id"`
	Result []json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (d *Driver) rpcRaw(ctx context.Context, op, sess, object, method string, args any) (int, json.RawMessage, error) {
	d.rpcID++
	if args == nil {
		args = map[string]any{}
	}
	payload, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      d.rpcID,
		Method:  "call",
		Params:  []any{sess, object, method, args},
	})
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "cannot encode ubus request")
	}
	defer router.Zero(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+"/ubus", bytes.NewReader(payload))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := d.http.Do(req)
	if err != nil {
		return 0, nil, router.TransportError(op, err)
	}
	defer resp.Body.Close()
	raw, err := router.ReadBody(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, nil, router.Errorf(router.ErrProtocol, op, "ubus endpoint returned HTTP %d", resp.StatusCode)
	}
	var rep rpcResponse
	if err := json.Unmarshal(raw, &rep); err != nil {
		return 0, nil, router.Errorf(router.ErrProtocol, op, "invalid JSON-RPC response from /ubus")
	}
	if rep.Error != nil {
		if rep.Error.Code == -32002 {
			return ubusStatusPermDenied, nil, &router.Error{Kind: router.ErrSessionExpired, Op: op, Detail: rep.Error.Message}
		}
		return -1, nil, router.Errorf(router.ErrProtocol, op, "ubus error %d: %s", rep.Error.Code, rep.Error.Message)
	}
	if len(rep.Result) == 0 {
		return -1, nil, router.Errorf(router.ErrProtocol, op, "empty ubus result")
	}
	var code int
	if err := json.Unmarshal(rep.Result[0], &code); err != nil {
		return -1, nil, router.Errorf(router.ErrProtocol, op, "bad ubus status code")
	}
	var data json.RawMessage
	if len(rep.Result) > 1 {
		data = rep.Result[1]
	}
	return code, data, nil
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

	code, data, err := d.rpcRaw(ctx, "login", zeroSession, "session", "login", map[string]string{
		"username": user,
		"password": string(pass),
	})
	if err != nil {
		return err
	}
	if code == ubusStatusPermDenied {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "ubus session.login denied"}
	}
	if code != ubusStatusOK {
		return router.Errorf(router.ErrProtocol, "login", "ubus session.login returned code %d", code)
	}
	var res struct {
		Session string `json:"ubus_rpc_session"`
	}
	if err := json.Unmarshal(data, &res); err != nil || res.Session == "" {
		return router.Errorf(router.ErrProtocol, "login", "missing ubus_rpc_session")
	}
	router.Zero(d.session)
	d.session = []byte(res.Session)
	return nil
}

func (d *Driver) call(ctx context.Context, op, object, method string, args any) (int, json.RawMessage, error) {
	if len(d.session) == 0 {
		if err := d.login(ctx); err != nil {
			return 0, nil, err
		}
	}
	code, data, err := d.rpcRaw(ctx, op, string(d.session), object, method, args)
	if err != nil && isSessionExpired(err) {
		router.Zero(d.session)
		d.session = nil
		if err := d.login(ctx); err != nil {
			return 0, nil, err
		}
		code, data, err = d.rpcRaw(ctx, op, string(d.session), object, method, args)
	}
	return code, data, err
}

func isSessionExpired(err error) bool {
	if re, ok := err.(*router.Error); ok {
		return re.Kind == router.ErrSessionExpired
	}
	return false
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	code, data, err := d.call(ctx, "identify", "system", "board", nil)
	if err != nil {
		return router.Info{}, err
	}
	if code != ubusStatusOK {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "system.board returned code %d", code)
	}
	var b struct {
		Kernel   string `json:"kernel"`
		Hostname string `json:"hostname"`
		Model    string `json:"model"`
		Board    string `json:"board_name"`
		Release  struct {
			Distribution string `json:"distribution"`
			Version      string `json:"version"`
			Description  string `json:"description"`
		} `json:"release"`
	}
	if err := json.Unmarshal(data, &b); err != nil {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unreadable system.board response")
	}
	info := router.Info{
		Vendor:   first(b.Release.Distribution, "OpenWrt"),
		Model:    first(b.Model, b.Board, "OpenWrt"),
		Firmware: first(b.Release.Description, b.Release.Version, b.Kernel),
		Extra:    map[string]string{},
	}
	if b.Kernel != "" {
		info.Extra["kernel"] = b.Kernel
	}
	if b.Hostname != "" {
		info.Extra["hostname"] = b.Hostname
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
		{Capability: router.CapClients, Supported: true, Mechanism: "ubus luci-rpc (DHCP leases + host hints) and iwinfo"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "luci-rpc.getDHCPLeases"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Adds a dedicated UCI firewall REJECT rule for the MAC; administrator rules stay untouched"},
		{Capability: router.CapRateLimit, Supported: false, Note: "OpenWrt has no single standard per-MAC rate-limit API across SQM/tc setups"},
		{Capability: router.CapSchedule, Supported: true, Mechanism: mechSchedule, Note: "Adds UCI firewall rules with start_time, stop_time and weekdays"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	byMAC := map[string]*router.Client{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnUnknown, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	// 1. DHCP leases
	if code, data, err := d.call(ctx, "clients", "luci-rpc", "getDHCPLeases", nil); err == nil && code == ubusStatusOK {
		var res struct {
			Leases []struct {
				IP       string `json:"ipaddr"`
				MAC      string `json:"macaddr"`
				Hostname string `json:"hostname"`
				Name     string `json:"name"`
				Expires  int64  `json:"expires"`
			} `json:"dhcp_leases"`
		}
		if json.Unmarshal(data, &res) == nil {
			for _, l := range res.Leases {
				mac, err := router.NormalizeMAC(l.MAC)
				if err != nil {
					continue
				}
				c := ensure(mac)
				if l.IP != "" {
					c.IP = l.IP
				}
				if hn := first(l.Hostname, l.Name); hn != "" {
					c.Hostname = hn
				}
				lease := &router.Lease{Source: "dhcp"}
				if l.Expires > 0 {
					dur := time.Duration(l.Expires) * time.Second
					lease.Remaining = &dur
				}
				c.Lease = lease
				c.Raw["dhcp.ipaddr"] = l.IP
				if hn := first(l.Hostname, l.Name); hn != "" {
					c.Raw["dhcp.hostname"] = hn
				}
			}
		}
	}

	// 2. Host hints (ARP + static hosts)
	if code, data, err := d.call(ctx, "clients", "luci-rpc", "getHostHints", nil); err == nil && code == ubusStatusOK {
		var hints map[string]struct {
			Name    string   `json:"name"`
			IPAddrs []string `json:"ipaddrs"`
		}
		if json.Unmarshal(data, &hints) == nil {
			for rawMAC, h := range hints {
				mac, err := router.NormalizeMAC(rawMAC)
				if err != nil {
					continue
				}
				c := ensure(mac)
				if c.IP == "" && len(h.IPAddrs) > 0 {
					c.IP = h.IPAddrs[0]
				}
				if c.Hostname == "" && h.Name != "" {
					c.Hostname = h.Name
				}
				if c.Connection == router.ConnUnknown {
					c.Connection = router.ConnWired
				}
				t := true
				c.Active = &t
				if h.Name != "" {
					c.Raw["hint.name"] = h.Name
				}
			}
		}
	}

	// 3. Wireless assoclist via iwinfo
	if code, data, err := d.call(ctx, "clients", "iwinfo", "devices", nil); err == nil && code == ubusStatusOK {
		var devs struct {
			Devices []string `json:"devices"`
		}
		if json.Unmarshal(data, &devs) == nil {
			for _, dev := range devs.Devices {
				acode, adata, aerr := d.call(ctx, "clients", "iwinfo", "assoclist", map[string]string{"device": dev})
				if aerr != nil || acode != ubusStatusOK {
					continue
				}
				var assoc struct {
					Results []struct {
						MAC    string `json:"mac"`
						Signal int    `json:"signal"`
					} `json:"results"`
				}
				if json.Unmarshal(adata, &assoc) != nil {
					continue
				}
				for _, r := range assoc.Results {
					mac, err := router.NormalizeMAC(r.MAC)
					if err != nil {
						continue
					}
					c := ensure(mac)
					t := true
					c.Active = &t
					c.Connection = router.ConnWiFi
					c.Interface = dev
					if r.Signal < 0 && r.Signal > -120 {
						sig := r.Signal
						c.SignalDBm = &sig
					}
					c.Raw["wifi.device"] = dev
					c.Raw["wifi.signal"] = strconv.Itoa(r.Signal)
				}
			}
		}
	}

	blockedMACs := map[string]bool{}
	if blocks, err := d.Blocked(ctx); err == nil {
		for _, b := range blocks {
			if !b.Partial {
				blockedMACs[b.MAC] = true
			}
		}
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

type uciFirewallSection struct {
	id     string
	values map[string]any
}

func (d *Driver) firewallRules(ctx context.Context, op string) ([]uciFirewallSection, error) {
	code, data, err := d.call(ctx, op, "uci", "get", map[string]string{"config": "firewall"})
	if err != nil {
		return nil, err
	}
	if code != ubusStatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "uci.get firewall returned code %d", code)
	}
	var rep struct {
		Values map[string]map[string]any `json:"values"`
	}
	if err := json.Unmarshal(data, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable uci firewall config")
	}
	var out []uciFirewallSection
	for secID, vals := range rep.Values {
		if strVal(vals[".type"]) == "rule" {
			out = append(out, uciFirewallSection{id: secID, values: vals})
		}
	}
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	rules, err := d.firewallRules(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, r := range rules {
		if strVal(r.values["enabled"]) == "0" {
			continue
		}
		target := strings.ToUpper(strVal(r.values["target"]))
		if target != "REJECT" && target != "DROP" {
			continue
		}
		macs := macList(r.values["src_mac"])
		if len(macs) == 0 {
			continue
		}
		name := strVal(r.values["name"])
		hasTime := strVal(r.values["start_time"]) != "" || strVal(r.values["stop_time"]) != ""
		for _, mac := range macs {
			entry := router.BlockEntry{
				MAC:       mac,
				Name:      name,
				Mechanism: mechBlock,
				Owner:     router.OwnerAdmin,
				Partial:   hasTime,
				Managed:   false,
			}
			switch {
			case strings.HasPrefix(name, blockNamePrefix):
				entry.Owner = router.OwnerProduct
				entry.Managed = true
			case strings.HasPrefix(name, scheduleNamePrefix):
				entry.Owner = router.OwnerProduct
				entry.Mechanism = mechSchedule
				entry.Partial = true
				entry.Detail = fmt.Sprintf("%s-%s %s", strVal(r.values["start_time"]), strVal(r.values["stop_time"]), strVal(r.values["weekdays"]))
			}
			out = append(out, entry)
		}
	}
	return out, nil
}

func (d *Driver) commitAndReloadFirewall(ctx context.Context, op string) error {
	code, _, err := d.call(ctx, op, "uci", "commit", map[string]string{"config": "firewall"})
	if err != nil {
		return err
	}
	if code != ubusStatusOK {
		return router.Errorf(router.ErrRejected, op, "uci.commit firewall returned code %d", code)
	}
	// Trigger firewall reload (best-effort across LuCI / rpcd versions).
	if c, _, err := d.call(ctx, op, "luci", "setInitAction", map[string]string{"name": "firewall", "action": "reload"}); err != nil || c != ubusStatusOK {
		_, _, _ = d.call(ctx, op, "rc", "init", map[string]string{"name": "firewall", "action": "reload"})
	}
	return nil
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
				Detail:          fmt.Sprintf("device is already blocked in OpenWrt firewall (%s)", b.Owner),
				Undo:            undoBlock(mac),
			}, nil
		}
	}
	code, data, err := d.call(ctx, "block", "uci", "add", map[string]any{
		"config": "firewall",
		"type":   "rule",
		"values": map[string]string{
			"name":    blockNamePrefix + mac,
			"src":     "lan",
			"dest":    "wan",
			"src_mac": strings.ToUpper(mac),
			"target":  "REJECT",
			"enabled": "1",
		},
	})
	if err != nil {
		return router.Change{}, err
	}
	if code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "uci.add firewall rule failed (code %d)", code)
	}
	var added struct {
		Section string `json:"section"`
	}
	if json.Unmarshal(data, &added) == nil && added.Section != "" {
		// Ensure values are written on older rpcd versions that ignore values in uci.add.
		_, _, _ = d.call(ctx, "block", "uci", "set", map[string]any{
			"config":  "firewall",
			"section": added.Section,
			"values": map[string]string{
				"name":    blockNamePrefix + mac,
				"src":     "lan",
				"dest":    "wan",
				"src_mac": strings.ToUpper(mac),
				"target":  "REJECT",
				"enabled": "1",
			},
		})
	}
	if err := d.commitAndReloadFirewall(ctx, "block"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "block",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    "added UCI firewall REJECT rule for " + strings.ToUpper(mac),
		Undo:      undoBlock(mac),
	}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rules, err := d.firewallRules(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	wantName := blockNamePrefix + mac
	removed := 0
	for _, r := range rules {
		if strVal(r.values["name"]) != wantName {
			continue
		}
		code, _, err := d.call(ctx, "unblock", "uci", "delete", map[string]string{"config": "firewall", "section": r.id})
		if err != nil {
			return router.Change{}, err
		}
		if code != ubusStatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "uci.delete %s failed (code %d)", r.id, code)
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
			Detail:          "no managed OpenWrt block rule found for this MAC",
		}, nil
	}
	if err := d.commitAndReloadFirewall(ctx, "unblock"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unblock",
		MAC:       mac,
		Mechanism: mechBlock,
		Applied:   true,
		Detail:    fmt.Sprintf("removed %d managed UCI firewall rule(s)", removed),
		Undo:      "Block the device again in LAN Detective",
	}, nil
}

var owrtDay = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

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
	for _, w := range windows {
		days := make([]string, 0, len(w.Days))
		for _, wd := range w.Days {
			if wd >= 0 && wd <= 6 {
				days = append(days, owrtDay[wd])
			}
		}
		vals := map[string]string{
			"name":       scheduleNamePrefix + mac,
			"src":        "lan",
			"dest":       "wan",
			"src_mac":    strings.ToUpper(mac),
			"start_time": w.Start + ":00",
			"stop_time":  w.End + ":00",
			"weekdays":   strings.Join(days, " "),
			"target":     "REJECT",
			"enabled":    "1",
		}
		code, data, err := d.call(ctx, "schedule", "uci", "add", map[string]any{"config": "firewall", "type": "rule", "values": vals})
		if err != nil {
			return router.Change{}, err
		}
		if code != ubusStatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "uci.add schedule rule failed (code %d)", code)
		}
		var added struct{ Section string `json:"section"` }
		if json.Unmarshal(data, &added) == nil && added.Section != "" {
			_, _, _ = d.call(ctx, "schedule", "uci", "set", map[string]any{"config": "firewall", "section": added.Section, "values": vals})
		}
	}
	if err := d.commitAndReloadFirewall(ctx, "schedule"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("applied %d scheduled OpenWrt firewall rule(s)", len(windows)),
		Undo:      fmt.Sprintf("Remove schedule in LAN Detective, or delete firewall rules named %q in LuCI", scheduleNamePrefix+mac),
	}, nil
}

func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rules, err := d.firewallRules(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	want := scheduleNamePrefix + mac
	removed := 0
	for _, r := range rules {
		if strVal(r.values["name"]) != want {
			continue
		}
		code, _, err := d.call(ctx, "clear_schedule", "uci", "delete", map[string]string{"config": "firewall", "section": r.id})
		if err != nil {
			return router.Change{}, err
		}
		if code != ubusStatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "uci.delete %s failed", r.id)
		}
		removed++
	}
	if removed > 0 {
		if err := d.commitAndReloadFirewall(ctx, "clear_schedule"); err != nil {
			return router.Change{}, err
		}
	}
	return router.Change{
		Action:          "clear_schedule",
		MAC:             mac,
		Mechanism:       mechSchedule,
		Applied:         removed > 0,
		AlreadyInEffect: removed == 0,
		Detail:          fmt.Sprintf("removed %d managed OpenWrt schedule rule(s)", removed),
	}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	if len(d.session) > 0 {
		_, _, _ = d.rpcRaw(ctx, "logout", string(d.session), "session", "destroy", nil)
		router.Zero(d.session)
		d.session = nil
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove the firewall rule %q in OpenWrt LuCI", blockNamePrefix+mac)
}

func strVal(v any) string {
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

func macList(v any) []string {
	var raw []string
	switch x := v.(type) {
	case string:
		raw = strings.Fields(x)
	case []any:
		for _, elem := range x {
			if s, ok := elem.(string); ok {
				raw = append(raw, s)
			}
		}
	}
	var out []string
	for _, s := range raw {
		if m, err := router.NormalizeMAC(s); err == nil {
			out = append(out, m)
		}
	}
	return out
}
