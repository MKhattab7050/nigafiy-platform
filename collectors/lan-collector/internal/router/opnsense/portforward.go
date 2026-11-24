package opnsense

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Port forwards on OPNsense 26.1 and newer: destination NAT through the MVC API.
//
// OPNsense 26.1 ("Witty Woodpecker", January 2026) migrated Firewall → NAT → Port Forward to the MVC
// framework as "Destination NAT" with an API (docs.opnsense.org/releases/CE_26.1.html; API reference
// docs.opnsense.org/development/api/core/firewall.html, controller DNatController, model
// OPNsense/Firewall/DNat.xml). Before 26.1 port forwards exist only on the legacy PHP page, without an
// API, so older firmware keeps the capability unsupported (portForwardNote).
//
// Used here:
//   - GET  /api/firewall/d_nat/search_rule          list (rows carry the rule uuid)
//   - GET  /api/firewall/d_nat/get_rule/{uuid}      one rule: {"rule": {...}}, option fields as
//     {"key": {"value": ..., "selected": 1}} maps
//   - POST /api/firewall/d_nat/add_rule             {"rule": {...}} → {"result": "saved", "uuid": ...}
//   - POST /api/firewall/d_nat/del_rule/{uuid}      → {"result": "deleted"}
//   - POST /api/firewall/d_nat/apply                load the new ruleset
//
// DNat.xml fields written: disabled, interface (wan), ipprotocol (inet), protocol (tcp, udp, or the
// extra "TCP/UDP" option), source.network (any), destination.network (wanip), destination.port
// (a port or "start-end"), target (the device's IPv4), local-port (the first internal port), descr,
// pass ("pass": the redirect passes without a separate filter rule, as pfSense's "pass" association).
const mechPortForward = "OPNsense 26.1+ destination NAT (/api/firewall/d_nat/*)"

// maxDNatRules bounds the per-rule reads of one listing.
const maxDNatRules = 256

var _ router.PortForwarder = (*Driver)(nil)

// dnatSupported reports whether the firmware has the destination-NAT API (26.1 or newer).
func dnatSupported(firmware string) bool {
	parts := strings.SplitN(strings.TrimSpace(firmware), ".", 3)
	if len(parts) < 2 {
		return false
	}
	major, err1 := strconv.Atoi(parts[0])
	minorDigits := strings.TrimRightFunc(parts[1], func(r rune) bool { return r < '0' || r > '9' })
	minor, err2 := strconv.Atoi(minorDigits)
	if err1 != nil || err2 != nil {
		return false
	}
	return major > 26 || (major == 26 && minor >= 1)
}

func (d *Driver) firmware(ctx context.Context) (string, error) {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return "", err
		}
	}
	return d.info.Firmware, nil
}

func (d *Driver) requireDNat(ctx context.Context, op string) error {
	fw, err := d.firmware(ctx)
	if err != nil {
		return err
	}
	if !dnatSupported(fw) {
		return router.Errorf(router.ErrUnsupported, op, "%s", portForwardNote(fw))
	}
	return nil
}

// optVal reads an MVC field as get_rule returns it: a plain string, or an option map whose selected
// keys are the value.
func optVal(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case map[string]any:
		var keys []string
		for k, o := range x {
			if m, ok := o.(map[string]any); ok {
				if s, _ := m["selected"].(float64); s == 1 {
					keys = append(keys, k)
				} else if b, _ := m["selected"].(bool); b {
					keys = append(keys, k)
				}
			}
		}
		sort.Strings(keys)
		return strings.Join(keys, ",")
	}
	return ""
}

func parsePorts(s string) (int, int, bool) {
	s = strings.TrimSpace(s)
	a, b, isRange := strings.Cut(s, "-")
	if !isRange {
		a, b, isRange = strings.Cut(s, ":")
	}
	start, err := strconv.Atoi(strings.TrimSpace(a))
	if err != nil || start < 1 || start > 65535 {
		return 0, 0, false
	}
	if !isRange {
		return start, start, true
	}
	end, err := strconv.Atoi(strings.TrimSpace(b))
	if err != nil || end < start || end > 65535 {
		return 0, 0, false
	}
	return start, end, true
}

func portSpec(a, b int) string {
	if a == b {
		return strconv.Itoa(a)
	}
	return fmt.Sprintf("%d-%d", a, b)
}

// readPortForwards lists the destination-NAT rules that forward to one IPv4 address. Rules this
// driver cannot express (aliases, IPv6, several interfaces, no port) are left out, never guessed.
func (d *Driver) readPortForwards(ctx context.Context, op string) ([]router.PortForward, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/firewall/d_nat/search_rule", nil)
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "OPNsense d_nat/search_rule returned HTTP %d", st)
	}
	var env struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable OPNsense d_nat/search_rule JSON")
	}
	out := make([]router.PortForward, 0, len(env.Rows))
	for i, row := range env.Rows {
		if i >= maxDNatRules {
			break
		}
		uuid := str(row["uuid"])
		if uuid == "" || len(uuid) > 40 {
			continue
		}
		st, raw, err := d.do(ctx, op, http.MethodGet, "/api/firewall/d_nat/get_rule/"+url.PathEscape(uuid), nil)
		if err != nil {
			return nil, err
		}
		if st != http.StatusOK {
			continue
		}
		var one struct {
			Rule map[string]any `json:"rule"`
		}
		if json.Unmarshal(raw, &one) != nil || one.Rule == nil {
			continue
		}
		if pf, ok := dnatToPortForward(uuid, one.Rule); ok {
			out = append(out, pf)
		}
	}
	return out, nil
}

func dnatToPortForward(uuid string, r map[string]any) (router.PortForward, bool) {
	proto, ok := router.NormalizeProtocol(optVal(r["protocol"]))
	if !ok {
		return router.PortForward{}, false
	}
	dst, _ := r["destination"].(map[string]any)
	es, ee, ok := parsePorts(optVal(dst["port"]))
	if !ok {
		return router.PortForward{}, false
	}
	target := optVal(r["target"])
	ip, err := netip.ParseAddr(target)
	if err != nil || !ip.Is4() {
		return router.PortForward{}, false
	}
	is := es
	if lp := optVal(r["local-port"]); lp != "" {
		p, err := strconv.Atoi(lp)
		if err != nil || p < 1 || p > 65535 {
			return router.PortForward{}, false
		}
		is = p
	}
	ie := is + (ee - es)
	if ie > 65535 {
		return router.PortForward{}, false
	}
	desc := optVal(r["descr"])
	owner := router.OwnerAdmin
	if strings.HasPrefix(desc, router.ProductRulePrefix) {
		owner = router.OwnerProduct
	}
	return router.PortForward{
		ID:            uuid,
		Enabled:       optVal(r["disabled"]) != "1",
		Description:   desc,
		Protocol:      proto,
		ExternalStart: es,
		ExternalEnd:   ee,
		InternalStart: is,
		InternalEnd:   ie,
		InternalIP:    ip.String(),
		Owner:         owner,
	}, true
}

type mvcResult struct {
	Result      string            `json:"result"`
	UUID        string            `json:"uuid"`
	Validations map[string]string `json:"validations"`
}

func (d *Driver) mvcPost(ctx context.Context, op, path string, body any, want string) (mvcResult, error) {
	st, raw, err := d.do(ctx, op, http.MethodPost, path, body)
	if err != nil {
		return mvcResult{}, err
	}
	var res mvcResult
	_ = json.Unmarshal(raw, &res)
	if st != http.StatusOK || !strings.EqualFold(res.Result, want) {
		fields := make([]string, 0, len(res.Validations))
		for k := range res.Validations {
			fields = append(fields, k)
		}
		sort.Strings(fields)
		detail := ""
		if len(fields) > 0 {
			detail = " (refused fields: " + strings.Join(fields, ", ") + ")"
		}
		return res, router.Errorf(router.ErrRejected, op, "OPNsense %s answered HTTP %d, result %q%s", path, st, res.Result, detail)
	}
	return res, nil
}

func (d *Driver) applyDNat(ctx context.Context, op string) error {
	st, raw, err := d.do(ctx, op, http.MethodPost, "/api/firewall/d_nat/apply", map[string]any{})
	if err != nil {
		return err
	}
	var res struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(raw, &res)
	if st != http.StatusOK || (res.Status != "" && !strings.EqualFold(strings.TrimSpace(res.Status), "ok")) {
		return router.Errorf(router.ErrRejected, op, "OPNsense d_nat/apply answered HTTP %d", st)
	}
	return nil
}

// lan returns the LAN prefix and the router's address on it, from the interface configuration.
func (d *Driver) lan(ctx context.Context) (netip.Prefix, netip.Addr) {
	st, raw, err := d.do(ctx, "port_forward", http.MethodGet, "/api/diagnostics/interface/getInterfaceConfig", nil)
	if err != nil || st != http.StatusOK {
		return netip.Prefix{}, netip.Addr{}
	}
	var ifaces map[string]map[string]any
	if json.Unmarshal(raw, &ifaces) != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	for name, cfg := range ifaces {
		arr, _ := cfg["ipv4"].([]any)
		for _, e := range arr {
			m, _ := e.(map[string]any)
			ip, err := netip.ParseAddr(str(m["ipaddr"]))
			if err != nil || !ip.Is4() {
				continue
			}
			if ip != d.target.Address && !strings.Contains(strings.ToLower(name), "lan") {
				continue
			}
			bits := -1
			if f, ok := m["subnetbits"].(float64); ok {
				bits = int(f)
			}
			if bits >= 8 && bits <= 30 {
				return netip.PrefixFrom(ip, bits).Masked(), ip
			}
			return netip.Prefix{}, ip
		}
	}
	return netip.Prefix{}, netip.Addr{}
}

// AddPortForward creates one destination-NAT rule on the WAN, applies it and re-reads it.
func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	if err := d.requireDNat(ctx, "add_port_forward"); err != nil {
		return router.Change{}, err
	}
	existing, err := d.readPortForwards(ctx, "add_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	lan, routerIP := d.lan(ctx)
	if !routerIP.IsValid() {
		routerIP = d.target.Address
	}
	clean, err := router.ValidatePortForward(rule, existing, lan, routerIP)
	if err != nil {
		return router.Change{}, err
	}
	proto := clean.Protocol
	if proto == router.ProtoBoth {
		proto = "tcp/udp"
	}
	res, err := d.mvcPost(ctx, "add_port_forward", "/api/firewall/d_nat/add_rule", map[string]any{"rule": map[string]any{
		"disabled":    "0",
		"interface":   "wan",
		"ipprotocol":  "inet",
		"protocol":    proto,
		"source":      map[string]any{"network": "any"},
		"destination": map[string]any{"network": "wanip", "port": portSpec(clean.ExternalStart, clean.ExternalEnd)},
		"target":      clean.InternalIP,
		"local-port":  strconv.Itoa(clean.InternalStart),
		"descr":       clean.Description,
		"pass":        "pass",
	}}, "saved")
	if err != nil {
		return router.Change{}, err
	}
	if err := d.applyDNat(ctx, "add_port_forward"); err != nil {
		return router.Change{}, err
	}
	after, err := d.readPortForwards(ctx, "add_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	var made *router.PortForward
	for i := range after {
		if after[i].ID == res.UUID || (res.UUID == "" && router.SameRule(after[i], clean)) {
			made = &after[i]
		}
	}
	if made == nil || !router.SameRule(*made, clean) {
		return router.Change{}, router.Errorf(router.ErrProtocol, "add_port_forward", "OPNsense saved the rule but it does not list it as sent; check Firewall → NAT → Destination NAT")
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail: fmt.Sprintf("added OPNsense destination NAT %s %s → %s:%s", clean.Protocol, portSpec(clean.ExternalStart, clean.ExternalEnd),
			clean.InternalIP, portSpec(clean.InternalStart, clean.InternalEnd)),
		Undo: "Remove the port forward in Nigafiy or under Firewall → NAT → Destination NAT in OPNsense",
	}, nil
}

// RemovePortForward deletes the rule with rule.ID if it still forwards what the operator saw.
func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	if err := d.requireDNat(ctx, "remove_port_forward"); err != nil {
		return router.Change{}, err
	}
	existing, err := d.readPortForwards(ctx, "remove_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrNotFound, "remove_port_forward", "the rule changed on the router; refresh and try again")
		}
		if _, err := d.mvcPost(ctx, "remove_port_forward", "/api/firewall/d_nat/del_rule/"+url.PathEscape(e.ID), map[string]any{}, "deleted"); err != nil {
			return router.Change{}, err
		}
		if err := d.applyDNat(ctx, "remove_port_forward"); err != nil {
			return router.Change{}, err
		}
		after, err := d.readPortForwards(ctx, "remove_port_forward")
		if err != nil {
			return router.Change{}, err
		}
		for _, a := range after {
			if a.ID == e.ID {
				return router.Change{}, router.Errorf(router.ErrProtocol, "remove_port_forward", "OPNsense still lists the rule after deleting it")
			}
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed OPNsense destination NAT %s %s → %s (%s)", e.Protocol, portSpec(e.ExternalStart, e.ExternalEnd), e.InternalIP, e.Description),
			Undo: fmt.Sprintf("Add it again in Nigafiy: %s external %s → %s:%s", e.Protocol, portSpec(e.ExternalStart, e.ExternalEnd),
				e.InternalIP, portSpec(e.InternalStart, e.InternalEnd)),
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "the rule is no longer on OPNsense"}, nil
}
