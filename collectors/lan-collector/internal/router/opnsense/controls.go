package opnsense

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
	mechOverview    = "OPNsense system time and interface diagnostics (/api/diagnostics/*)"
	mechReservation = "OPNsense Kea DHCPv4 reservations (/api/kea/dhcpv4/*)"
	mechReboot      = "OPNsense system reboot (/api/core/system/reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/api/diagnostics/system/systemTime", nil); err == nil && st == http.StatusOK {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if sec, ok := parseOpnUptime(str(m["uptime"])); ok {
				ov.UptimeSeconds = &sec
			}
		}
	}
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/api/diagnostics/interface/getInterfaceConfig", nil); err == nil && st == http.StatusOK {
		var ifaces map[string]map[string]any
		if json.Unmarshal(raw, &ifaces) == nil {
			for name, cfg := range ifaces {
				ip := firstIPv4FromOPN(cfg["ipv4"])
				if ip == "" {
					continue
				}
				if ip == d.target.Address.String() || strings.Contains(strings.ToLower(name), "lan") {
					ov.LANIP = ip
					continue
				}
				a, err := netip.ParseAddr(ip)
				if err == nil && (!router.IsPrivate(a) || strings.Contains(strings.ToLower(name), "wan")) {
					status := "down"
					if strings.EqualFold(str(cfg["status"]), "active") || strings.EqualFold(str(cfg["status"]), "up") {
						status = "up"
					}
					ov.WAN = append(ov.WAN, router.WANLink{Name: name, Status: status, IPv4: ip})
				}
			}
		}
	}
	return ov, nil
}

func firstIPv4FromOPN(v any) string {
	arr, ok := v.([]any)
	if !ok {
		return ""
	}
	for _, elem := range arr {
		if m, ok := elem.(map[string]any); ok {
			if ip := str(m["ipaddr"]); ip != "" {
				return ip
			}
		}
	}
	return ""
}

func parseOpnUptime(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
		return n, true
	}
	// Format like "2 days, 03:15:10" or "03:15:10"
	var total int64
	if i := strings.Index(s, "day"); i > 0 {
		if d, err := strconv.ParseInt(strings.TrimSpace(s[:i]), 10, 64); err == nil {
			total += d * 86400
		}
		if c := strings.IndexByte(s, ','); c >= 0 {
			s = strings.TrimSpace(s[c+1:])
		}
	}
	parts := strings.Split(s, ":")
	if len(parts) == 3 {
		h, e1 := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		m, e2 := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		sec, e3 := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		if e1 == nil && e2 == nil && e3 == nil {
			return total + h*3600 + m*60 + sec, true
		}
	}
	return 0, false
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	req := map[string]any{"current": 1, "rowCount": -1, "searchPhrase": ""}
	st, raw, err := d.do(ctx, "settings", http.MethodPost, "/api/kea/dhcpv4/searchReservation", req)
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return []router.Reservation{}, nil
	}
	var env struct {
		Rows []map[string]any `json:"rows"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return []router.Reservation{}, nil
	}
	out := make([]router.Reservation, 0, len(env.Rows))
	for _, r := range env.Rows {
		mac, err := router.NormalizeMAC(first(str(r["hw_address"]), str(r["mac"])))
		ip := strings.TrimSpace(first(str(r["ip_address"]), str(r["ip"])))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      str(r["uuid"]),
			MAC:     mac,
			IP:      ip,
			Enabled: true,
		})
	}
	return out, nil
}

func (d *Driver) findKeaSubnetUUID(ctx context.Context, ip netip.Addr) (string, netip.Prefix) {
	req := map[string]any{"current": 1, "rowCount": -1, "searchPhrase": ""}
	st, raw, err := d.do(ctx, "reserve", http.MethodPost, "/api/kea/dhcpv4/searchSubnet", req)
	if err != nil || st != http.StatusOK {
		return "", netip.Prefix{}
	}
	var env struct {
		Rows []struct {
			UUID   string `json:"uuid"`
			Subnet string `json:"subnet"`
		} `json:"rows"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return "", netip.Prefix{}
	}
	for _, s := range env.Rows {
		if p, err := netip.ParsePrefix(s.Subnet); err == nil && p.Contains(ip) {
			return s.UUID, p
		}
	}
	if len(env.Rows) > 0 {
		p, _ := netip.ParsePrefix(env.Rows[0].Subnet)
		return env.Rows[0].UUID, p
	}
	return "", netip.Prefix{}
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
	return router.Settings{
		Overview:     ov,
		Reservations: res,
	}, nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, err := d.readReservations(ctx)
	if err != nil {
		return router.Change{}, err
	}
	parsedIP, _ := netip.ParseAddr(strings.TrimSpace(rawIP))
	subnetUUID, lan := d.findKeaSubnetUUID(ctx, parsedIP)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, lan, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range existing {
		if r.MAC == mac && r.IP == ip.String() {
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
		}
	}
	payload := map[string]any{
		"reservation": map[string]any{
			"subnet":      subnetUUID,
			"hw_address":  mac,
			"ip_address":  ip.String(),
			"description": "Managed by Nigafiy",
		},
	}
	st, _, err := d.do(ctx, "reserve", http.MethodPost, "/api/kea/dhcpv4/addReservation", payload)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "Kea addReservation returned HTTP %d", st)
	}
	_, _, _ = d.do(ctx, "reserve", http.MethodPost, "/api/kea/service/reconfigure", map[string]any{})
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s in OPNsense Kea DHCPv4", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or under Services → Kea DHCP → Kea DHCPv4 → Reservations in OPNsense",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	existing, err := d.readReservations(ctx)
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range existing {
		if r.MAC != mac {
			continue
		}
		st, _, err := d.do(ctx, "unreserve", http.MethodPost, "/api/kea/dhcpv4/delReservation/"+url.PathEscape(r.ID), map[string]any{})
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "unreserve", "Kea delReservation returned HTTP %d", st)
		}
		_, _, _ = d.do(ctx, "unreserve", http.MethodPost, "/api/kea/service/reconfigure", map[string]any{})
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("removed OPNsense Kea DHCP reservation %s for %s", r.IP, mac),
			Undo:      "Add the reservation again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no Kea reservation found for this MAC"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	st, _, err := d.do(ctx, "reboot", http.MethodPost, "/api/core/system/reboot", map[string]any{})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reboot", "OPNsense reboot returned HTTP %d", st)
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "OPNsense accepted system reboot request",
	}, nil
}
