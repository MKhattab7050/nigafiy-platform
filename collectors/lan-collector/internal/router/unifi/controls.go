package unifi

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	mechOverview    = "UniFi device and health status (/stat/device, /stat/health)"
	mechWiFi        = "UniFi WLAN configuration (/rest/wlanconf)"
	mechReservation = "UniFi client fixed IP (/rest/user use_fixedip)"
	mechPortForward = "UniFi port forwarding (/rest/portforward)"
	mechRename      = "UniFi client alias (/rest/user name)"
	mechReboot      = "UniFi gateway restart (/cmd/devmgr restart)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

// findGateway returns the site's gateway device, or nil when the site has none. The error is a
// failure to ask (login, certificate, transport), which a caller about to act on the gateway reports.
func (d *Driver) findGateway(ctx context.Context) (map[string]any, error) {
	devs, err := d.call(ctx, "settings", http.MethodGet, "/stat/device", nil)
	if err != nil {
		return nil, err
	}
	for _, dev := range devs {
		t := strings.ToLower(str(dev["type"]))
		if t == "udm" || t == "ugw" || t == "uxg" {
			return dev, nil
		}
	}
	if len(devs) > 0 {
		return devs[0], nil
	}
	return nil, nil
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if gw, _ := d.findGateway(ctx); gw != nil {
		if up, ok := intOf(gw["uptime"]); ok && up > 0 {
			sec := int64(up)
			ov.UptimeSeconds = &sec
		}
		if ip := str(gw["ip"]); ip != "" {
			if a, err := netip.ParseAddr(ip); err == nil && a.Is4() && router.IsPrivate(a) {
				ov.LANIP = a.String()
			}
		}
		if wan1, ok := gw["wan1"].(map[string]any); ok {
			status := "down"
			if boolOf(wan1["up"]) {
				status = "up"
			}
			var dns []string
			if arr, ok := wan1["dns"].([]any); ok {
				for _, item := range arr {
					if s := str(item); s != "" {
						dns = append(dns, s)
					}
				}
			}
			ov.WAN = append(ov.WAN, router.WANLink{
				Name:   first(str(wan1["name"]), "WAN1"),
				Status: status,
				Type:   str(wan1["type"]),
				IPv4:   str(wan1["ip"]),
				DNS:    dns,
			})
		}
	}
	if len(ov.WAN) == 0 {
		if health, err := d.call(ctx, "settings", http.MethodGet, "/stat/health", nil); err == nil {
			for _, h := range health {
				if str(h["subsystem"]) == "wan" {
					st := "unknown"
					if str(h["status"]) == "ok" {
						st = "up"
					} else if str(h["status"]) != "" {
						st = "down"
					}
					ov.WAN = append(ov.WAN, router.WANLink{
						Name:   "WAN",
						Status: st,
						IPv4:   str(h["wan_ip"]),
					})
				}
			}
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	wlans, err := d.call(ctx, "settings", http.MethodGet, "/rest/wlanconf", nil)
	if err != nil {
		return nil, nil
	}
	clientsBySSID := map[string][]string{}
	if stas, err := d.call(ctx, "settings", http.MethodGet, "/stat/sta", nil); err == nil {
		for _, s := range stas {
			essid := str(s["essid"])
			if mac, err := router.NormalizeMAC(str(s["mac"])); err == nil && essid != "" {
				clientsBySSID[essid] = append(clientsBySSID[essid], mac)
			}
		}
	}
	out := make([]router.WiFiNetwork, 0, len(wlans))
	for _, w := range wlans {
		id := str(w["_id"])
		ssid := str(w["name"])
		if id == "" || ssid == "" {
			continue
		}
		guest := boolOf(w["is_guest"])
		band := str(w["wlan_band"])
		switch strings.ToLower(band) {
		case "2g":
			band = "2.4GHz"
		case "5g":
			band = "5GHz"
		case "both":
			band = "2.4GHz/5GHz"
		}
		out = append(out, router.WiFiNetwork{
			ID:         id,
			Band:       band,
			SSID:       ssid,
			Enabled:    boolOf(w["enabled"]),
			Main:       !guest,
			Guest:      guest,
			Hidden:     boolOf(w["hide_ssid"]),
			Security:   str(w["security"]),
			ClientMACs: clientsBySSID[ssid],
		})
	}
	return out, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	users, err := d.call(ctx, "settings", http.MethodGet, "/rest/user", nil)
	if err != nil {
		return nil, err
	}
	out := make([]router.Reservation, 0)
	for _, u := range users {
		if !boolOf(u["use_fixedip"]) {
			continue
		}
		mac, err := router.NormalizeMAC(str(u["mac"]))
		ip := strings.TrimSpace(str(u["fixed_ip"]))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      str(u["_id"]),
			MAC:     mac,
			IP:      ip,
			Enabled: true,
		})
	}
	return out, nil
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

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	rows, err := d.call(ctx, "settings", http.MethodGet, "/rest/portforward", nil)
	if err != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for _, r := range rows {
		proto, ok := router.NormalizeProtocol(str(r["proto"]))
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(str(r["dst_port"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(str(r["fwd_port"]))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(str(r["fwd"]))
		if ip == "" {
			continue
		}
		name := str(r["name"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(name, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            str(r["_id"]),
			Enabled:       boolOf(r["enabled"]),
			Description:   name,
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
	wifi, _ := d.readWiFi(ctx)
	res, err := d.readReservations(ctx)
	if err != nil {
		return router.Settings{}, err
	}
	pf, _ := d.readPortForwards(ctx)
	return router.Settings{
		Overview:     ov,
		WiFi:         wifi,
		Reservations: res,
		PortForwards: pf,
	}, nil
}

func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	_, err := d.call(ctx, "wifi", http.MethodPut, "/rest/wlanconf/"+url.PathEscape(id), map[string]any{"enabled": enabled})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set UniFi WLAN %s enabled=%v", id, enabled),
		Undo:      "Toggle the Wi-Fi network back in LAN Detective or UniFi Network Settings → WiFi",
	}, nil
}

func (d *Driver) findUserID(ctx context.Context, op, mac string) (string, error) {
	users, err := d.call(ctx, op, http.MethodGet, "/rest/user", nil)
	if err != nil {
		return "", err
	}
	for _, u := range users {
		if m, err := router.NormalizeMAC(str(u["mac"])); err == nil && m == mac {
			return str(u["_id"]), nil
		}
	}
	return "", nil
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
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already fixed for %s", ip, mac)}, nil
		}
	}
	uid, err := d.findUserID(ctx, "reserve", mac)
	if err != nil {
		return router.Change{}, err
	}
	if uid != "" {
		_, err = d.call(ctx, "reserve", http.MethodPut, "/rest/user/"+url.PathEscape(uid), map[string]any{"use_fixedip": true, "fixed_ip": ip.String()})
	} else {
		_, err = d.call(ctx, "reserve", http.MethodPost, "/rest/user", map[string]any{"mac": mac, "use_fixedip": true, "fixed_ip": ip.String()})
	}
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("set UniFi fixed IP %s for %s", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or disable Fixed IP Address on the client in UniFi",
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
		_, err = d.call(ctx, "unreserve", http.MethodPut, "/rest/user/"+url.PathEscape(r.ID), map[string]any{"use_fixedip": false, "fixed_ip": ""})
		if err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("cleared UniFi fixed IP %s for %s", r.IP, mac),
			Undo:      "Add the reservation again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no fixed IP configured for this MAC in UniFi"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	proto := clean.Protocol
	if proto == router.ProtoBoth {
		proto = "tcp_udp"
	}
	payload := map[string]any{
		"name":           clean.Description,
		"enabled":        true,
		"pfwd_interface": "wan",
		"proto":          proto,
		"dst_port":       formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		"fwd":            clean.InternalIP,
		"fwd_port":       formatPortRange(clean.InternalStart, clean.InternalEnd),
		"src":            "any",
	}
	_, err = d.call(ctx, "add_port_forward", http.MethodPost, "/rest/portforward", payload)
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added UniFi port forward %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in LAN Detective or UniFi Network Settings → Routing & Firewall → Port Forwarding",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "UniFi port-forward rule %s changed since it was last read", rule.ID)
		}
		_, err := d.call(ctx, "remove_port_forward", http.MethodDelete, "/rest/portforward/"+url.PathEscape(e.ID), nil)
		if err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed UniFi port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present on UniFi"}, nil
}

func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanName(rawName)
	if err != nil {
		return router.Change{}, err
	}
	uid, err := d.findUserID(ctx, "rename", mac)
	if err != nil {
		return router.Change{}, err
	}
	if uid == "" {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rename", "UniFi has no client record for %s", mac)
	}
	_, err = d.call(ctx, "rename", http.MethodPut, "/rest/user/"+url.PathEscape(uid), map[string]any{"name": name})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("renamed UniFi client %s to %q", mac, name),
		Undo:      "Rename the client again in LAN Detective or UniFi Network",
	}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	gw, err := d.findGateway(ctx)
	if err != nil {
		return router.Change{}, err
	}
	if gw == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "reboot", "no UniFi gateway device found in site")
	}
	gwMAC, err := router.NormalizeMAC(str(gw["mac"]))
	if err != nil {
		return router.Change{}, router.Errorf(router.ErrProtocol, "reboot", "UniFi gateway MAC missing")
	}
	_, err = d.call(ctx, "reboot", http.MethodPost, "/cmd/devmgr", map[string]any{"cmd": "restart", "mac": gwMAC})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    fmt.Sprintf("sent restart command to UniFi gateway %s", gwMAC),
	}, nil
}
