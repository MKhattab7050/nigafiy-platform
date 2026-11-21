package pfsense

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	mechOverview    = "pfSense REST API v2 system & interface status (/api/v2/status/{system,interfaces})"
	mechReservation = "pfSense DHCP static mapping (/api/v2/services/dhcp_server/static_mapping)"
	mechPortForward = "pfSense NAT port forward (/api/v2/firewall/nat/port_forward)"
	mechReboot      = "pfSense diagnostics reboot (/api/v2/diagnostics/reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) lanPrefix(ctx context.Context) (netip.Prefix, netip.Addr) {
	_, data, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/status/interfaces", nil)
	if err != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	var ifaces []map[string]any
	if json.Unmarshal(data, &ifaces) != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	for _, it := range ifaces {
		ip, err := netip.ParseAddr(str(it["ipaddr"]))
		if err != nil || !ip.Is4() {
			continue
		}
		if ip == d.target.Address || strings.EqualFold(str(it["name"]), "lan") || strings.EqualFold(str(it["descr"]), "lan") {
			if bits, err := strconv.Atoi(strAny(it["subnet"])); err == nil && bits >= 8 && bits <= 30 {
				return netip.PrefixFrom(ip, bits).Masked(), ip
			}
			return netip.Prefix{}, ip
		}
	}
	return netip.Prefix{}, netip.Addr{}
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if _, data, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/status/system", nil); err == nil {
		var sys map[string]any
		if json.Unmarshal(data, &sys) == nil {
			if sec, ok := parseUptime(sys["uptime"]); ok {
				ov.UptimeSeconds = &sec
			}
		}
	}
	if _, data, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/status/interfaces", nil); err == nil {
		var ifaces []map[string]any
		if json.Unmarshal(data, &ifaces) == nil {
			for _, it := range ifaces {
				name := first(str(it["descr"]), str(it["name"]))
				ip := str(it["ipaddr"])
				if strings.EqualFold(str(it["name"]), "lan") || ip == d.target.Address.String() {
					if ip != "" {
						ov.LANIP = ip
					}
					continue
				}
				if strings.Contains(strings.ToLower(name), "wan") || (ip != "" && !isPriv(ip)) {
					st := "down"
					if strings.EqualFold(str(it["status"]), "up") {
						st = "up"
					}
					ov.WAN = append(ov.WAN, router.WANLink{
						Name:   first(name, "WAN"),
						Status: st,
						IPv4:   ip,
					})
				}
			}
		}
	}
	return ov, nil
}

type pfStaticMap struct {
	ID       int    `json:"id"`
	ParentID string `json:"parent_id"`
	MAC      string `json:"mac"`
	IPAddr   string `json:"ipaddr"`
	Hostname string `json:"hostname"`
}

func (d *Driver) readStaticMappings(ctx context.Context, op string) ([]pfStaticMap, error) {
	_, data, err := d.do(ctx, op, http.MethodGet, "/api/v2/services/dhcp_server/static_mappings", nil)
	if err != nil {
		return nil, err
	}
	var list []pfStaticMap
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, nil
	}
	return list, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	list, err := d.readStaticMappings(ctx, "settings")
	if err != nil {
		return nil, err
	}
	out := make([]router.Reservation, 0, len(list))
	for _, s := range list {
		mac, err := router.NormalizeMAC(s.MAC)
		if err != nil || s.IPAddr == "" {
			continue
		}
		parent := first(s.ParentID, "lan")
		out = append(out, router.Reservation{
			ID:      fmt.Sprintf("%s:%d", parent, s.ID),
			MAC:     mac,
			IP:      s.IPAddr,
			Enabled: true,
		})
	}
	return out, nil
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	_, data, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/firewall/nat/port_forwards", nil)
	if err != nil {
		return nil, nil
	}
	var rows []map[string]any
	if json.Unmarshal(data, &rows) != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for _, r := range rows {
		proto, ok := router.NormalizeProtocol(str(r["protocol"]))
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(strAny(r["destination_port"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(strAny(r["local_port"]))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(str(r["target"]))
		if ip == "" {
			continue
		}
		desc := str(r["descr"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		disabled, _ := r["disabled"].(bool)
		out = append(out, router.PortForward{
			ID:            strAny(r["id"]),
			Enabled:       !disabled,
			Description:   desc,
			Protocol:      proto,
			ExternalStart: es,
			ExternalEnd:   ee,
			InternalStart: is,
			InternalEnd:   ie,
			InternalIP:    ip,
			Owner:         owner,
		})
	}
	return out, nil
}

func (d *Driver) Settings(ctx context.Context) (router.Settings, error) {
	ov, err := d.readOverview(ctx)
	if err != nil {
		return router.Settings{}, err
	}
	res, err := d.readReservations(ctx)
	if err != nil {
		return router.Settings{}, err
	}
	pf, _ := d.readPortForwards(ctx)
	return router.Settings{
		Overview:     ov,
		Reservations: res,
		PortForwards: pf,
	}, nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, err := d.readReservations(ctx)
	if err != nil {
		return router.Change{}, err
	}
	lan, routerIP := d.lanPrefix(ctx)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, lan, routerIP)
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range existing {
		if r.MAC == mac && r.IP == ip.String() {
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
		}
	}
	if _, _, err := d.do(ctx, "reserve", http.MethodPost, "/api/v2/services/dhcp_server/static_mapping", map[string]any{
		"parent_id": "lan",
		"mac":       mac,
		"ipaddr":    ip.String(),
		"descr":     "Managed by LAN Detective",
	}); err != nil {
		return router.Change{}, err
	}
	_, _, _ = d.do(ctx, "reserve", http.MethodPost, "/api/v2/services/dhcp_server/apply", map[string]any{})
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on pfSense DHCP server", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or under Services → DHCP Server → Static Mappings in pfSense",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	list, err := d.readStaticMappings(ctx, "unreserve")
	if err != nil {
		return router.Change{}, err
	}
	for _, s := range list {
		if m, err := router.NormalizeMAC(s.MAC); err == nil && m == mac {
			parent := first(s.ParentID, "lan")
			path := fmt.Sprintf("/api/v2/services/dhcp_server/static_mapping?parent_id=%s&id=%d", url.QueryEscape(parent), s.ID)
			if _, _, err := d.do(ctx, "unreserve", http.MethodDelete, path, nil); err != nil {
				return router.Change{}, err
			}
			_, _, _ = d.do(ctx, "unreserve", http.MethodPost, "/api/v2/services/dhcp_server/apply", map[string]any{})
			return router.Change{
				Action:    "unreserve",
				MAC:       mac,
				Mechanism: mechReservation,
				Applied:   true,
				Detail:    fmt.Sprintf("removed pfSense DHCP static mapping %s for %s", s.IPAddr, mac),
				Undo:      "Add the reservation again in LAN Detective",
			}, nil
		}
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no pfSense static mapping found for this MAC"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	lan, routerIP := d.lanPrefix(ctx)
	clean, err := router.ValidatePortForward(rule, existing, lan, routerIP)
	if err != nil {
		return router.Change{}, err
	}
	proto := clean.Protocol
	if proto == router.ProtoBoth {
		proto = "tcp/udp"
	}
	payload := map[string]any{
		"interface":        "wan",
		"protocol":         proto,
		"source":           "any",
		"destination":      "wanip",
		"destination_port": formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		"target":           clean.InternalIP,
		"local_port":       strconv.Itoa(clean.InternalStart),
		"descr":            clean.Description,
		"associated_rule_id": "pass",
	}
	if _, _, err := d.do(ctx, "add_port_forward", http.MethodPost, "/api/v2/firewall/nat/port_forward", payload); err != nil {
		return router.Change{}, err
	}
	if _, _, err := d.do(ctx, "add_port_forward", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added pfSense NAT port forward %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in LAN Detective or under Firewall → NAT → Port Forward in pfSense",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "pfSense port-forward rule %s changed since it was last read", rule.ID)
		}
		if _, _, err := d.do(ctx, "remove_port_forward", http.MethodDelete, "/api/v2/firewall/nat/port_forward?id="+url.QueryEscape(e.ID), nil); err != nil {
			return router.Change{}, err
		}
		if _, _, err := d.do(ctx, "remove_port_forward", http.MethodPost, "/api/v2/firewall/apply", map[string]any{}); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed pfSense port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present on pfSense"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if _, _, err := d.do(ctx, "reboot", http.MethodPost, "/api/v2/diagnostics/reboot", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "pfSense accepted reboot request",
	}, nil
}

func strAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return ""
	}
}

func isPriv(s string) bool {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	return err == nil && router.IsPrivate(a)
}

func parsePortRange(s string) (int, int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, 0, false
	}
	if i := strings.IndexAny(s, "-:"); i > 0 {
		a, err1 := strconv.Atoi(strings.TrimSpace(s[:i]))
		b, err2 := strconv.Atoi(strings.TrimSpace(s[i+1:]))
		if err1 == nil && err2 == nil && a >= 1 && b >= a && b <= 65535 {
			return a, b, true
		}
		return 0, 0, false
	}
	p, err := strconv.Atoi(s)
	if err != nil || p < 1 || p > 65535 {
		return 0, 0, false
	}
	return p, p, true
}

func formatPortRange(a, b int) string {
	if a == b {
		return strconv.Itoa(a)
	}
	return fmt.Sprintf("%d:%d", a, b)
}

func parseUptime(v any) (int64, bool) {
	if f, ok := v.(float64); ok && f > 0 {
		return int64(f), true
	}
	if s, ok := v.(string); ok {
		if n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil && n > 0 {
			return n, true
		}
	}
	return 0, false
}
