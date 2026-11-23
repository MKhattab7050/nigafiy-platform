package tplink

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "TP-Link Archer status API (/admin/status?form=all)"
	mechWiFi        = "TP-Link Archer wireless toggle (/admin/wireless)"
	mechReservation = "TP-Link Archer DHCP address reservation (/admin/dhcps?form=reservation)"
	mechPortForward = "TP-Link Archer virtual server (/admin/nat?form=vs)"
	mechReboot      = "TP-Link Archer reboot (/admin/system?form=reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	data, err := d.adminCall(ctx, "settings", "/admin/status?form=all", url.Values{"operation": {"read"}})
	if err != nil {
		return ov, nil
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return ov, nil
	}
	if ip := strings.TrimSpace(str(m["lan_ipv4_ipaddr"])); ip != "" {
		ov.LANIP = ip
	}
	if sec, err := strconv.ParseInt(strings.TrimSpace(first(str(m["uptime"]), str(m["wan_ipv4_uptime"]))), 10, 64); err == nil && sec > 0 {
		ov.UptimeSeconds = &sec
	}
	if wanIP := strings.TrimSpace(str(m["wan_ipv4_ipaddr"])); wanIP != "" && wanIP != "0.0.0.0" {
		var dns []string
		for _, k := range []string{"wan_ipv4_pridns", "wan_ipv4_snddns"} {
			if a, err := netip.ParseAddr(strings.TrimSpace(str(m[k]))); err == nil && a.Is4() {
				dns = append(dns, a.String())
			}
		}
		ov.WAN = []router.WANLink{{
			Name:   "WAN",
			Status: "up",
			Type:   str(m["wan_ipv4_conntype"]),
			IPv4:   wanIP,
			DNS:    dns,
		}}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	forms := []struct {
		id, form, band string
		guest          bool
	}{
		{"wireless_2g", "/admin/wireless?form=wireless_2g", "2.4GHz", false},
		{"wireless_5g", "/admin/wireless?form=wireless_5g", "5GHz", false},
		{"guest_2g", "/admin/wireless?form=guest_2g", "2.4GHz", true},
		{"guest_5g", "/admin/wireless?form=guest_5g", "5GHz", true},
	}
	var out []router.WiFiNetwork
	for _, f := range forms {
		data, err := d.adminCall(ctx, "settings", f.form, url.Values{"operation": {"read"}})
		if err != nil {
			continue
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		ssid := strings.TrimSpace(str(m["ssid"]))
		if ssid == "" {
			continue
		}
		out = append(out, router.WiFiNetwork{
			ID:       f.id,
			Band:     f.band,
			SSID:     ssid,
			Enabled:  strings.EqualFold(str(m["enable"]), "on") || str(m["enable"]) == "1",
			Main:     !f.guest,
			Guest:    f.guest,
			Hidden:   strings.EqualFold(str(m["hidden"]), "on") || str(m["hidden"]) == "1",
			Security: str(m["encryption"]),
		})
	}
	return out, nil
}

type tpResRow struct {
	Key    string `json:"key"`
	MAC    string `json:"mac"`
	IP     string `json:"ip"`
	Enable string `json:"enable"`
}

func (d *Driver) readResRows(ctx context.Context, op string) ([]tpResRow, error) {
	data, err := d.adminCall(ctx, op, "/admin/dhcps?form=reservation", url.Values{"operation": {"load"}})
	if err != nil {
		return nil, err
	}
	var rows []tpResRow
	_ = json.Unmarshal(data, &rows)
	return rows, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	rows, err := d.readResRows(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.Reservation, 0, len(rows))
	for i, r := range rows {
		mac, err := router.NormalizeMAC(r.MAC)
		if err != nil || r.IP == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      first(r.Key, fmt.Sprintf("key-%d", i)),
			MAC:     mac,
			IP:      strings.TrimSpace(r.IP),
			Enabled: !strings.EqualFold(r.Enable, "off"),
		})
	}
	return out, nil
}

type tpVSRow struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	Enable       string `json:"enable"`
	Protocol     string `json:"protocol"`
	ExternalPort string `json:"external_port"`
	InternalIP   string `json:"internal_ip"`
	InternalPort string `json:"internal_port"`
}

func (d *Driver) readVSRows(ctx context.Context, op string) ([]tpVSRow, error) {
	data, err := d.adminCall(ctx, op, "/admin/nat?form=vs", url.Values{"operation": {"load"}})
	if err != nil {
		return nil, err
	}
	var rows []tpVSRow
	_ = json.Unmarshal(data, &rows)
	return rows, nil
}

func parsePortRange(s string) (int, int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, 0, false
	}
	if i := strings.IndexByte(s, '-'); i > 0 {
		a, e1 := strconv.Atoi(strings.TrimSpace(s[:i]))
		b, e2 := strconv.Atoi(strings.TrimSpace(s[i+1:]))
		if e1 == nil && e2 == nil && a >= 1 && b >= a && b <= 65535 {
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

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	rows, err := d.readVSRows(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto, ok := router.NormalizeProtocol(r.Protocol)
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(r.ExternalPort)
		if !ok || r.InternalIP == "" {
			continue
		}
		is, ie, ok := parsePortRange(r.InternalPort)
		if !ok {
			is, ie = es, ee
		}
		owner := router.OwnerAdmin
		if strings.HasPrefix(r.Name, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            first(r.Key, fmt.Sprintf("key-%d", i)),
			Enabled:       !strings.EqualFold(r.Enable, "off"),
			Description:   r.Name,
			Protocol:      proto,
			ExternalStart: es,
			ExternalEnd:   ee,
			InternalStart: is,
			InternalEnd:   ie,
			InternalIP:    strings.TrimSpace(r.InternalIP),
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
	wifi, _ := d.readWiFi(ctx)
	res, _ := d.readReservations(ctx)
	pf, _ := d.readPortForwards(ctx)
	return router.Settings{
		Overview:     ov,
		WiFi:         wifi,
		Reservations: res,
		PortForwards: pf,
	}, nil
}

func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	switch id {
	case "wireless_2g", "wireless_5g", "guest_2g", "guest_5g":
	default:
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown TP-Link Wi-Fi id %q", id)
	}
	en := "off"
	if enabled {
		en = "on"
	}
	if _, err := d.adminCall(ctx, "wifi", "/admin/wireless?form="+id, url.Values{"operation": {"write"}, "enable": {en}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set TP-Link %s enable=%s", id, en),
		Undo:      "Toggle the Wi-Fi network back in Nigafiy or TP-Link Wireless settings",
	}, nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, _ := d.readReservations(ctx)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range existing {
		if r.MAC == mac && r.IP == ip.String() {
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
		}
	}
	newJSON, _ := json.Marshal(map[string]string{
		"mac":    strings.ToUpper(strings.ReplaceAll(mac, ":", "-")),
		"ip":     ip.String(),
		"enable": "on",
	})
	if _, err := d.adminCall(ctx, "reserve", "/admin/dhcps?form=reservation", url.Values{
		"operation": {"insert"},
		"key":       {"add"},
		"index":     {"0"},
		"old":       {"add"},
		"new":       {string(newJSON)},
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on TP-Link DHCP server", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or under Network → DHCP Server → Address Reservation on TP-Link",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readResRows(ctx, "unreserve")
	if err != nil {
		return router.Change{}, err
	}
	for i, r := range rows {
		if m, err := router.NormalizeMAC(r.MAC); err == nil && m == mac {
			key := first(r.Key, fmt.Sprintf("key-%d", i))
			if _, err := d.adminCall(ctx, "unreserve", "/admin/dhcps?form=reservation", url.Values{
				"operation": {"remove"},
				"key":       {key},
				"index":     {strconv.Itoa(i)},
			}); err != nil {
				return router.Change{}, err
			}
			return router.Change{
				Action:    "unreserve",
				MAC:       mac,
				Mechanism: mechReservation,
				Applied:   true,
				Detail:    fmt.Sprintf("removed TP-Link DHCP reservation %s for %s", r.IP, mac),
				Undo:      "Add the reservation again in Nigafiy",
			}, nil
		}
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no TP-Link DHCP reservation found for this MAC"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	proto := strings.ToUpper(clean.Protocol)
	if clean.Protocol == router.ProtoBoth {
		proto = "ALL"
	}
	newJSON, _ := json.Marshal(map[string]string{
		"name":          clean.Description,
		"external_port": formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		"internal_ip":   clean.InternalIP,
		"internal_port": formatPortRange(clean.InternalStart, clean.InternalEnd),
		"protocol":      proto,
		"enable":        "on",
	})
	if _, err := d.adminCall(ctx, "add_port_forward", "/admin/nat?form=vs", url.Values{
		"operation": {"insert"},
		"key":       {"add"},
		"index":     {"0"},
		"old":       {"add"},
		"new":       {string(newJSON)},
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added TP-Link virtual server %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in Nigafiy or under NAT Forwarding → Port Forwarding on TP-Link",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "TP-Link virtual server %s changed since it was last read", rule.ID)
		}
		if _, err := d.adminCall(ctx, "remove_port_forward", "/admin/nat?form=vs", url.Values{
			"operation": {"remove"},
			"key":       {e.ID},
			"index":     {strconv.Itoa(i)},
		}); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed TP-Link virtual server %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "virtual server rule is no longer present on TP-Link"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if _, err := d.adminCall(ctx, "reboot", "/admin/system?form=reboot", url.Values{"operation": {"write"}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "TP-Link router accepted reboot request",
	}, nil
}
