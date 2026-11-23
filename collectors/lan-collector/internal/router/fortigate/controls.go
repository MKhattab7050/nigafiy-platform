package fortigate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "FortiOS system status & interface monitor (/api/v2/monitor/system/{status,interface})"
	mechReservation = "FortiOS DHCP server reserved-address (/api/v2/cmdb/system.dhcp/server)"
	mechPortForward = "FortiOS firewall Virtual IP port forwarding (/api/v2/cmdb/firewall/vip)"
	mechReboot      = "FortiOS system reboot (/api/v2/monitor/system/os/reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/monitor/system/status", nil); err == nil && st == http.StatusOK {
		var rep struct {
			Results map[string]any `json:"results"`
		}
		if json.Unmarshal(raw, &rep) == nil {
			if up, ok := rep.Results["uptime"].(float64); ok && up > 0 {
				sec := int64(up)
				ov.UptimeSeconds = &sec
			}
		}
	}
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/monitor/system/interface", nil); err == nil && st == http.StatusOK {
		var rep struct {
			Results map[string]map[string]any `json:"results"`
		}
		if json.Unmarshal(raw, &rep) == nil {
			for name, iface := range rep.Results {
				ip := str(iface["ip"])
				if ip == "" || ip == "0.0.0.0" {
					continue
				}
				if ip == d.target.Address.String() || strings.Contains(strings.ToLower(name), "lan") || strings.EqualFold(name, "internal") {
					ov.LANIP = ip
					continue
				}
				if strings.Contains(strings.ToLower(name), "wan") || !isPriv(ip) {
					status := "down"
					if b, ok := iface["link"].(bool); ok && b {
						status = "up"
					}
					ov.WAN = append(ov.WAN, router.WANLink{Name: name, Status: status, Type: str(iface["type"]), IPv4: ip})
				}
			}
		}
	}
	return ov, nil
}

type fgtDHCPServer struct {
	ID              int              `json:"id"`
	Interface       string           `json:"interface"`
	Netmask         string           `json:"netmask"`
	DefaultGateway  string           `json:"default-gateway"`
	ReservedAddress []map[string]any `json:"reserved-address"`
}

func (d *Driver) readDHCPServers(ctx context.Context, op string) ([]fgtDHCPServer, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/v2/cmdb/system.dhcp/server", nil)
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return nil, nil
	}
	var rep struct {
		Results []fgtDHCPServer `json:"results"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil, nil
	}
	return rep.Results, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	srvs, err := d.readDHCPServers(ctx, "settings")
	if err != nil {
		return nil, err
	}
	out := make([]router.Reservation, 0)
	for _, s := range srvs {
		for _, r := range s.ReservedAddress {
			if strings.EqualFold(str(r["action"]), "block") {
				continue
			}
			mac, err := router.NormalizeMAC(str(r["mac"]))
			ip := strings.TrimSpace(str(r["ip"]))
			if err != nil || ip == "" {
				continue
			}
			out = append(out, router.Reservation{
				ID:      fmt.Sprintf("%d:%s", s.ID, str(r["id"])),
				MAC:     mac,
				IP:      ip,
				Enabled: true,
			})
		}
	}
	return out, nil
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	st, raw, err := d.do(ctx, "settings", http.MethodGet, "/api/v2/cmdb/firewall/vip", nil)
	if err != nil || st != http.StatusOK {
		return nil, nil
	}
	var rep struct {
		Results []map[string]any `json:"results"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0)
	for _, v := range rep.Results {
		if !strings.EqualFold(str(v["portforward"]), "enable") {
			continue
		}
		proto, ok := router.NormalizeProtocol(str(v["protocol"]))
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(str(v["extport"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(str(v["mappedport"]))
		if !ok {
			is, ie = es, ee
		}
		ip := firstMappedIP(v["mappedip"])
		if ip == "" {
			continue
		}
		name := str(v["name"])
		desc := first(str(v["comment"]), name)
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) || strings.HasPrefix(name, "ld-pf-") {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            name,
			Enabled:       true,
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

func firstMappedIP(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case []any:
		for _, elem := range x {
			if m, ok := elem.(map[string]any); ok {
				if r := str(m["range"]); r != "" {
					if i := strings.IndexByte(r, '-'); i > 0 {
						return strings.TrimSpace(r[:i])
					}
					return strings.TrimSpace(r)
				}
			}
		}
	}
	return ""
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
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range existing {
		if r.MAC == mac && r.IP == ip.String() {
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
		}
	}
	srvs, err := d.readDHCPServers(ctx, "reserve")
	if err != nil || len(srvs) == 0 {
		return router.Change{}, router.Errorf(router.ErrNotFound, "reserve", "no DHCP server configured on FortiGate")
	}
	srv := srvs[0]
	nextID := 1
	updated := make([]map[string]any, 0, len(srv.ReservedAddress)+1)
	for _, r := range srv.ReservedAddress {
		if id, err := strconv.Atoi(str(r["id"])); err == nil && id >= nextID {
			nextID = id + 1
		}
		if m, err := router.NormalizeMAC(str(r["mac"])); err == nil && m == mac {
			continue
		}
		updated = append(updated, r)
	}
	updated = append(updated, map[string]any{
		"id":          nextID,
		"ip":          ip.String(),
		"mac":         mac,
		"action":      "reserved",
		"description": "Managed by LAN Detective",
	})
	st, _, err := d.do(ctx, "reserve", http.MethodPut, fmt.Sprintf("/api/v2/cmdb/system.dhcp/server/%d", srv.ID), map[string]any{
		"reserved-address": updated,
	})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "FortiOS DHCP server update returned HTTP %d", st)
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on FortiGate DHCP server %d", ip, mac, srv.ID),
		Undo:      "Remove the reservation in LAN Detective or under Network → Interfaces → DHCP Server in FortiGate",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	srvs, err := d.readDHCPServers(ctx, "unreserve")
	if err != nil {
		return router.Change{}, err
	}
	for _, srv := range srvs {
		var next []map[string]any
		var removedIP string
		for _, r := range srv.ReservedAddress {
			if m, err := router.NormalizeMAC(str(r["mac"])); err == nil && m == mac {
				removedIP = str(r["ip"])
				continue
			}
			next = append(next, r)
		}
		if removedIP == "" {
			continue
		}
		if next == nil {
			next = []map[string]any{}
		}
		st, _, err := d.do(ctx, "unreserve", http.MethodPut, fmt.Sprintf("/api/v2/cmdb/system.dhcp/server/%d", srv.ID), map[string]any{
			"reserved-address": next,
		})
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "unreserve", "FortiOS DHCP server update returned HTTP %d", st)
		}
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("removed FortiGate DHCP reservation %s for %s", removedIP, mac),
			Undo:      "Add the reservation again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no DHCP reservation found for this MAC on FortiGate"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	protos := []string{clean.Protocol}
	if clean.Protocol == router.ProtoBoth {
		protos = []string{router.ProtoTCP, router.ProtoUDP}
	}
	for _, p := range protos {
		vipName := fmt.Sprintf("ld-pf-%s-%d-%s", p, clean.ExternalStart, strings.ReplaceAll(clean.InternalIP, ".", "_"))
		payload := map[string]any{
			"name":        vipName,
			"type":        "static-nat",
			"extip":       "0.0.0.0",
			"extintf":     "any",
			"portforward": "enable",
			"protocol":    p,
			"extport":     formatPortRange(clean.ExternalStart, clean.ExternalEnd),
			"mappedip":    []map[string]string{{"range": clean.InternalIP}},
			"mappedport":  formatPortRange(clean.InternalStart, clean.InternalEnd),
			"comment":     clean.Description,
		}
		st, _, err := d.do(ctx, "add_port_forward", http.MethodPost, "/api/v2/cmdb/firewall/vip", payload)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusCreated {
			return router.Change{}, router.Errorf(router.ErrRejected, "add_port_forward", "FortiOS VIP creation returned HTTP %d", st)
		}
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added FortiGate VIP %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the VIP in LAN Detective or under Policy & Objects → Virtual IPs in FortiGate",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "FortiGate VIP %s changed since it was last read", rule.ID)
		}
		st, _, err := d.do(ctx, "remove_port_forward", http.MethodDelete, "/api/v2/cmdb/firewall/vip/"+url.PathEscape(e.ID), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "FortiOS VIP delete returned HTTP %d", st)
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed FortiGate VIP %s", e.ID),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "VIP is no longer present on FortiGate"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	st, _, err := d.do(ctx, "reboot", http.MethodPost, "/api/v2/monitor/system/os/reboot", map[string]any{
		"event_log_message": "Reboot requested via Nigafiy",
	})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reboot", "FortiOS reboot returned HTTP %d", st)
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "FortiGate accepted reboot request",
	}, nil
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
	if i := strings.IndexByte(s, '-'); i > 0 {
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
	return fmt.Sprintf("%d-%d", a, b)
}
