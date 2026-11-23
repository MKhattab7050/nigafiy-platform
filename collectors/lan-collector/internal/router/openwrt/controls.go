package openwrt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "OpenWrt ubus system.info and network.interface.{lan,wan}.status"
	mechWiFi        = "OpenWrt UCI wireless interface toggle (uci.set wireless.<id>.disabled)"
	mechReservation = "OpenWrt UCI static DHCP host (uci dhcp @host)"
	mechPortForward = "OpenWrt UCI firewall DNAT redirect (uci firewall @redirect)"
	mechRename      = "OpenWrt UCI DHCP host label (uci dhcp @host.name)"
	mechReboot      = "OpenWrt ubus system.reboot"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) uciGetAll(ctx context.Context, op, cfg string) (map[string]map[string]any, error) {
	code, data, err := d.call(ctx, op, "uci", "get", map[string]string{"config": cfg})
	if err != nil {
		return nil, err
	}
	if code != ubusStatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "uci.get %s returned code %d", cfg, code)
	}
	var rep struct {
		Values map[string]map[string]any `json:"values"`
	}
	if err := json.Unmarshal(data, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable uci %s config", cfg)
	}
	return rep.Values, nil
}

func (d *Driver) commitAndReload(ctx context.Context, op, cfg, service string) error {
	code, _, err := d.call(ctx, op, "uci", "commit", map[string]string{"config": cfg})
	if err != nil {
		return err
	}
	if code != ubusStatusOK {
		return router.Errorf(router.ErrRejected, op, "uci.commit %s returned code %d", cfg, code)
	}
	if c, _, err := d.call(ctx, op, "luci", "setInitAction", map[string]string{"name": service, "action": "reload"}); err != nil || c != ubusStatusOK {
		_, _, _ = d.call(ctx, op, "rc", "init", map[string]string{"name": service, "action": "reload"})
	}
	return nil
}

func (d *Driver) lanPrefix(ctx context.Context) (netip.Prefix, netip.Addr) {
	code, data, err := d.call(ctx, "settings", "network.interface.lan", "status", nil)
	if err != nil || code != ubusStatusOK {
		return netip.Prefix{}, netip.Addr{}
	}
	var st struct {
		IPv4 []struct {
			Address string `json:"address"`
			Mask    int    `json:"mask"`
		} `json:"ipv4-address"`
	}
	if json.Unmarshal(data, &st) == nil && len(st.IPv4) > 0 {
		if a, err := netip.ParseAddr(st.IPv4[0].Address); err == nil && a.Is4() && st.IPv4[0].Mask >= 8 && st.IPv4[0].Mask <= 30 {
			return netip.PrefixFrom(a, st.IPv4[0].Mask).Masked(), a
		}
	}
	return netip.Prefix{}, netip.Addr{}
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{}
	if code, data, err := d.call(ctx, "settings", "system", "info", nil); err == nil && code == ubusStatusOK {
		var si struct {
			Uptime int64 `json:"uptime"`
		}
		if json.Unmarshal(data, &si) == nil && si.Uptime > 0 {
			u := si.Uptime
			ov.UptimeSeconds = &u
		}
	}
	if _, lanIP := d.lanPrefix(ctx); lanIP.IsValid() {
		ov.LANIP = lanIP.String()
	} else {
		ov.LANIP = d.target.Address.String()
	}
	if code, data, err := d.call(ctx, "settings", "network.interface.wan", "status", nil); err == nil && code == ubusStatusOK {
		var w struct {
			Up     bool   `json:"up"`
			Proto  string `json:"proto"`
			Uptime int64  `json:"uptime"`
			IPv4   []struct {
				Address string `json:"address"`
			} `json:"ipv4-address"`
			DNS []string `json:"dns-server"`
		}
		if json.Unmarshal(data, &w) == nil {
			status := "down"
			if w.Up {
				status = "up"
			}
			link := router.WANLink{Name: "wan", Status: status, Type: w.Proto, DNS: w.DNS}
			if len(w.IPv4) > 0 {
				link.IPv4 = w.IPv4[0].Address
			}
			if w.Uptime > 0 {
				u := w.Uptime
				link.UptimeSeconds = &u
			}
			ov.WAN = []router.WANLink{link}
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	vals, err := d.uciGetAll(ctx, "settings", "wireless")
	if err != nil {
		return nil, nil
	}
	radioBand := map[string]string{}
	for sec, v := range vals {
		if strVal(v[".type"]) == "wifi-device" {
			b := strings.ToLower(first(strVal(v["band"]), strVal(v["hwmode"])))
			switch {
			case strings.Contains(b, "6g"):
				radioBand[sec] = "6GHz"
			case strings.Contains(b, "5g") || strings.Contains(b, "a"):
				radioBand[sec] = "5GHz"
			case strings.Contains(b, "2g") || strings.Contains(b, "g") || strings.Contains(b, "b"):
				radioBand[sec] = "2.4GHz"
			}
		}
	}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var out []router.WiFiNetwork
	for _, sec := range keys {
		v := vals[sec]
		if strVal(v[".type"]) != "wifi-iface" {
			continue
		}
		ssid := strVal(v["ssid"])
		if ssid == "" {
			continue
		}
		netName := strings.ToLower(strVal(v["network"]))
		isGuest := strings.Contains(netName, "guest") || strings.Contains(strings.ToLower(ssid), "guest")
		out = append(out, router.WiFiNetwork{
			ID:       sec,
			Band:     radioBand[strVal(v["device"])],
			SSID:     ssid,
			Enabled:  strVal(v["disabled"]) != "1",
			Main:     !isGuest,
			Guest:    isGuest,
			Hidden:   strVal(v["hidden"]) == "1",
			Security: strVal(v["encryption"]),
		})
	}
	return out, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	vals, err := d.uciGetAll(ctx, "settings", "dhcp")
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]router.Reservation, 0)
	for _, sec := range keys {
		v := vals[sec]
		if strVal(v[".type"]) != "host" {
			continue
		}
		macs := macList(v["mac"])
		ip := strings.TrimSpace(strVal(v["ip"]))
		if len(macs) == 0 || ip == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      sec,
			MAC:     macs[0],
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
	return fmt.Sprintf("%d-%d", a, b)
}

func uciProto(v any) string {
	switch x := v.(type) {
	case string:
		p, ok := router.NormalizeProtocol(strings.ReplaceAll(x, " ", "/"))
		if ok {
			return p
		}
	case []any:
		var hasTCP, hasUDP bool
		for _, elem := range x {
			s := strings.ToLower(strVal(elem))
			if s == "tcp" {
				hasTCP = true
			} else if s == "udp" {
				hasUDP = true
			}
		}
		if hasTCP && hasUDP {
			return router.ProtoBoth
		}
		if hasTCP {
			return router.ProtoTCP
		}
		if hasUDP {
			return router.ProtoUDP
		}
	}
	return ""
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	vals, err := d.uciGetAll(ctx, "settings", "firewall")
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]router.PortForward, 0)
	for _, sec := range keys {
		v := vals[sec]
		if strVal(v[".type"]) != "redirect" || !strings.EqualFold(strVal(v["target"]), "DNAT") {
			continue
		}
		proto := uciProto(v["proto"])
		if proto == "" {
			continue
		}
		es, ee, ok := parsePortRange(strVal(v["src_dport"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(strVal(v["dest_port"]))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(strVal(v["dest_ip"]))
		if ip == "" {
			continue
		}
		name := strVal(v["name"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(name, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            sec,
			Enabled:       strVal(v["enabled"]) != "0",
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
	pf, err := d.readPortForwards(ctx)
	if err != nil {
		return router.Settings{}, err
	}
	return router.Settings{
		Overview:     ov,
		WiFi:         wifi,
		Reservations: res,
		PortForwards: pf,
	}, nil
}

func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	disabled := "1"
	if enabled {
		disabled = "0"
	}
	code, _, err := d.call(ctx, "wifi", "uci", "set", map[string]any{
		"config":  "wireless",
		"section": id,
		"values":  map[string]string{"disabled": disabled},
	})
	if err != nil {
		return router.Change{}, err
	}
	if code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "wifi", "uci.set wireless.%s returned code %d", id, code)
	}
	if err := d.commitAndReload(ctx, "wifi", "wireless", "network"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set OpenWrt wireless.%s disabled=%s", id, disabled),
		Undo:      "Toggle the Wi-Fi network back in Nigafiy or OpenWrt LuCI",
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
		if r.MAC == mac {
			if r.IP == ip.String() {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			code, _, err := d.call(ctx, "reserve", "uci", "set", map[string]any{
				"config":  "dhcp",
				"section": r.ID,
				"values":  map[string]string{"ip": ip.String(), "mac": strings.ToUpper(mac)},
			})
			if err != nil || code != ubusStatusOK {
				return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "uci.set dhcp.%s failed", r.ID)
			}
			if err := d.commitAndReload(ctx, "reserve", "dhcp", "dnsmasq"); err != nil {
				return router.Change{}, err
			}
			return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: true, Detail: fmt.Sprintf("updated OpenWrt static lease for %s to %s", mac, ip), Undo: "Remove the reservation in Nigafiy or LuCI"}, nil
		}
	}
	vals := map[string]string{"mac": strings.ToUpper(mac), "ip": ip.String()}
	code, data, err := d.call(ctx, "reserve", "uci", "add", map[string]any{"config": "dhcp", "type": "host", "values": vals})
	if err != nil || code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "uci.add dhcp host failed (code %d)", code)
	}
	var added struct{ Section string `json:"section"` }
	if json.Unmarshal(data, &added) == nil && added.Section != "" {
		_, _, _ = d.call(ctx, "reserve", "uci", "set", map[string]any{"config": "dhcp", "section": added.Section, "values": vals})
	}
	if err := d.commitAndReload(ctx, "reserve", "dhcp", "dnsmasq"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s in OpenWrt UCI dhcp", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or LuCI (Network → DHCP and DNS → Static Leases)",
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
		code, _, err := d.call(ctx, "unreserve", "uci", "delete", map[string]string{"config": "dhcp", "section": r.ID})
		if err != nil || code != ubusStatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "unreserve", "uci.delete dhcp.%s failed", r.ID)
		}
		if err := d.commitAndReload(ctx, "unreserve", "dhcp", "dnsmasq"); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("removed OpenWrt static lease %s for %s", r.IP, mac),
			Undo:      "Add the reservation again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no static lease found for this MAC"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, err := d.readPortForwards(ctx)
	if err != nil {
		return router.Change{}, err
	}
	lan, routerIP := d.lanPrefix(ctx)
	clean, err := router.ValidatePortForward(rule, existing, lan, routerIP)
	if err != nil {
		return router.Change{}, err
	}
	proto := clean.Protocol
	if proto == router.ProtoBoth {
		proto = "tcp udp"
	}
	vals := map[string]string{
		"name":      clean.Description,
		"src":       "wan",
		"dest":      "lan",
		"proto":     proto,
		"src_dport": formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		"dest_ip":   clean.InternalIP,
		"dest_port": formatPortRange(clean.InternalStart, clean.InternalEnd),
		"target":    "DNAT",
		"enabled":   "1",
	}
	code, data, err := d.call(ctx, "add_port_forward", "uci", "add", map[string]any{"config": "firewall", "type": "redirect", "values": vals})
	if err != nil || code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "add_port_forward", "uci.add firewall redirect failed")
	}
	var added struct{ Section string `json:"section"` }
	if json.Unmarshal(data, &added) == nil && added.Section != "" {
		_, _, _ = d.call(ctx, "add_port_forward", "uci", "set", map[string]any{"config": "firewall", "section": added.Section, "values": vals})
	}
	if err := d.commitAndReloadFirewall(ctx, "add_port_forward"); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added OpenWrt DNAT redirect %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the port forward in Nigafiy or OpenWrt LuCI (Network → Firewall → Port Forwards)",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, err := d.readPortForwards(ctx)
	if err != nil {
		return router.Change{}, err
	}
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "OpenWrt redirect %s changed since it was last read", rule.ID)
		}
		code, _, err := d.call(ctx, "remove_port_forward", "uci", "delete", map[string]string{"config": "firewall", "section": e.ID})
		if err != nil || code != ubusStatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "uci.delete firewall.%s failed", e.ID)
		}
		if err := d.commitAndReloadFirewall(ctx, "remove_port_forward"); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed OpenWrt redirect %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "redirect rule is no longer present on OpenWrt"}, nil
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
	vals, err := d.uciGetAll(ctx, "rename", "dhcp")
	if err != nil {
		return router.Change{}, err
	}
	for sec, v := range vals {
		if strVal(v[".type"]) != "host" {
			continue
		}
		for _, m := range macList(v["mac"]) {
			if m == mac {
				code, _, err := d.call(ctx, "rename", "uci", "set", map[string]any{"config": "dhcp", "section": sec, "values": map[string]string{"name": name}})
				if err != nil || code != ubusStatusOK {
					return router.Change{}, router.Errorf(router.ErrRejected, "rename", "uci.set dhcp.%s.name failed", sec)
				}
				if err := d.commitAndReload(ctx, "rename", "dhcp", "dnsmasq"); err != nil {
					return router.Change{}, err
				}
				return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: true, Detail: fmt.Sprintf("renamed OpenWrt host %s to %q", mac, name), Undo: "Rename the device again in Nigafiy or LuCI"}, nil
			}
		}
	}
	newVals := map[string]string{"mac": strings.ToUpper(mac), "name": name}
	code, data, err := d.call(ctx, "rename", "uci", "add", map[string]any{"config": "dhcp", "type": "host", "values": newVals})
	if err != nil || code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "rename", "uci.add dhcp host failed")
	}
	var added struct{ Section string `json:"section"` }
	if json.Unmarshal(data, &added) == nil && added.Section != "" {
		_, _, _ = d.call(ctx, "rename", "uci", "set", map[string]any{"config": "dhcp", "section": added.Section, "values": newVals})
	}
	if err := d.commitAndReload(ctx, "rename", "dhcp", "dnsmasq"); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: true, Detail: fmt.Sprintf("created OpenWrt DHCP host label %q for %s", name, mac), Undo: "Rename or remove the host entry in OpenWrt LuCI"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	code, _, err := d.call(ctx, "reboot", "system", "reboot", nil)
	if err != nil {
		return router.Change{}, err
	}
	if code != ubusStatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "reboot", "system.reboot returned code %d", code)
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "OpenWrt accepted system.reboot request",
	}, nil
}
