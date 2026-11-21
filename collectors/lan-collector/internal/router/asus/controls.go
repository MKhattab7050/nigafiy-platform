package asus

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
	mechOverview    = "Asuswrt NVRAM status (lan_ipaddr, wan0_*, uptime)"
	mechWiFi        = "Asuswrt wireless radio/guest toggle (applyapp.cgi restart_wireless)"
	mechReservation = "Asuswrt DHCP static lease table (dhcp_staticlist)"
	mechPortForward = "Asuswrt virtual server table (vts_rulelist)"
	mechRename      = "Asuswrt custom client list (custom_clientlist)"
	mechReboot      = "Asuswrt system reboot (applyapp.cgi rc_service=reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) applyNVRAM(ctx context.Context, op, rcService string, kv map[string]string) error {
	if len(d.token) == 0 {
		if err := d.login(ctx); err != nil {
			return err
		}
	}
	form := url.Values{
		"action_mode": {"apply"},
		"rc_service":  {rcService},
	}
	for k, v := range kv {
		form.Set(k, v)
	}
	st, _, err := d.rawDo(ctx, op, http.MethodPost, "/applyapp.cgi", form)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "applyapp.cgi returned HTTP %d", st)
	}
	return nil
}

func (d *Driver) lanPrefix(ctx context.Context) (netip.Prefix, netip.Addr) {
	m, err := d.appGet(ctx, "settings", "nvram_get(lan_ipaddr);nvram_get(lan_netmask)")
	if err != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	ip, err1 := netip.ParseAddr(strings.TrimSpace(str(m["lan_ipaddr"])))
	if err1 != nil || !ip.Is4() {
		return netip.Prefix{}, netip.Addr{}
	}
	bits := 24
	if mask, err2 := netip.ParseAddr(strings.TrimSpace(str(m["lan_netmask"]))); err2 == nil && mask.Is4() {
		b := mask.As4()
		v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
		n := 0
		for v&0x80000000 != 0 {
			n++
			v <<= 1
		}
		if v == 0 && n >= 8 && n <= 30 {
			bits = n
		}
	}
	return netip.PrefixFrom(ip, bits).Masked(), ip
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	m, err := d.appGet(ctx, "settings", "nvram_get(lan_ipaddr);nvram_get(wan0_ipaddr);nvram_get(wan0_state_t);nvram_get(wan0_proto);nvram_get(wan0_dns);uptime()")
	if err != nil {
		return nil, err
	}
	ov := &router.Overview{LANIP: first(str(m["lan_ipaddr"]), d.target.Address.String())}
	if upMap, ok := m["uptime"].(map[string]any); ok {
		if sec, err := strconv.ParseInt(strings.TrimSpace(str(upMap["uptime"])), 10, 64); err == nil && sec > 0 {
			ov.UptimeSeconds = &sec
		}
	} else if sec, err := strconv.ParseInt(strings.TrimSpace(str(m["uptime"])), 10, 64); err == nil && sec > 0 {
		ov.UptimeSeconds = &sec
	}
	if wanIP := strings.TrimSpace(str(m["wan0_ipaddr"])); wanIP != "" && wanIP != "0.0.0.0" {
		status := "down"
		if str(m["wan0_state_t"]) == "2" || strings.EqualFold(str(m["wan0_state_t"]), "up") {
			status = "up"
		}
		var dns []string
		for _, tok := range strings.Fields(str(m["wan0_dns"])) {
			if a, err := netip.ParseAddr(tok); err == nil && a.Is4() {
				dns = append(dns, a.String())
			}
		}
		ov.WAN = []router.WANLink{{Name: "WAN0", Status: status, Type: str(m["wan0_proto"]), IPv4: wanIP, DNS: dns}}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	hook := strings.Join([]string{
		"nvram_get(wl0_ssid);nvram_get(wl0_radio);nvram_get(wl0_closed);nvram_get(wl0_auth_mode_x)",
		"nvram_get(wl1_ssid);nvram_get(wl1_radio);nvram_get(wl1_closed);nvram_get(wl1_auth_mode_x)",
		"nvram_get(wl0.1_ssid);nvram_get(wl0.1_bss_enabled);nvram_get(wl0.1_closed);nvram_get(wl0.1_auth_mode_x)",
		"nvram_get(wl1.1_ssid);nvram_get(wl1.1_bss_enabled);nvram_get(wl1.1_closed);nvram_get(wl1.1_auth_mode_x)",
	}, ";")
	m, err := d.appGet(ctx, "settings", hook)
	if err != nil {
		return nil, err
	}
	specs := []struct {
		id, band, ssidKey, enKey, hideKey, secKey string
		guest                                     bool
	}{
		{"wl0", "2.4GHz", "wl0_ssid", "wl0_radio", "wl0_closed", "wl0_auth_mode_x", false},
		{"wl1", "5GHz", "wl1_ssid", "wl1_radio", "wl1_closed", "wl1_auth_mode_x", false},
		{"wl0.1", "2.4GHz", "wl0.1_ssid", "wl0.1_bss_enabled", "wl0.1_closed", "wl0.1_auth_mode_x", true},
		{"wl1.1", "5GHz", "wl1.1_ssid", "wl1.1_bss_enabled", "wl1.1_closed", "wl1.1_auth_mode_x", true},
	}
	var out []router.WiFiNetwork
	for _, sp := range specs {
		ssid := strings.TrimSpace(str(m[sp.ssidKey]))
		if ssid == "" {
			continue
		}
		out = append(out, router.WiFiNetwork{
			ID:       sp.id,
			Band:     sp.band,
			SSID:     ssid,
			Enabled:  str(m[sp.enKey]) != "0",
			Main:     !sp.guest,
			Guest:    sp.guest,
			Hidden:   str(m[sp.hideKey]) == "1",
			Security: str(m[sp.secKey]),
		})
	}
	return out, nil
}

type dhcpStaticRow struct {
	mac, ip, dns, name string
}

func parseDHCPStaticList(raw string) []dhcpStaticRow {
	var rows []dhcpStaticRow
	for _, entry := range strings.Split(raw, "<") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ">")
		if len(parts) < 2 {
			continue
		}
		mac, err := router.NormalizeMAC(parts[0])
		ip := strings.TrimSpace(parts[1])
		if err != nil || ip == "" {
			continue
		}
		row := dhcpStaticRow{mac: mac, ip: ip}
		if len(parts) > 2 {
			row.dns = parts[2]
		}
		if len(parts) > 3 {
			row.name = parts[3]
		}
		rows = append(rows, row)
	}
	return rows
}

func renderDHCPStaticList(rows []dhcpStaticRow) string {
	var b strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&b, "<%s>%s>%s>%s", strings.ToUpper(r.mac), r.ip, r.dns, r.name)
	}
	return b.String()
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	m, err := d.appGet(ctx, "settings", "nvram_get(dhcp_staticlist)")
	if err != nil {
		return nil, err
	}
	rows := parseDHCPStaticList(str(m["dhcp_staticlist"]))
	out := make([]router.Reservation, 0, len(rows))
	for i, r := range rows {
		out = append(out, router.Reservation{ID: strconv.Itoa(i + 1), MAC: r.mac, IP: r.ip, Enabled: true})
	}
	return out, nil
}

type vtsRow struct {
	desc, extPort, ip, intPort, proto string
}

func parseVTSList(raw string) []vtsRow {
	var rows []vtsRow
	for _, entry := range strings.Split(raw, "<") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ">")
		if len(parts) < 5 {
			continue
		}
		rows = append(rows, vtsRow{desc: parts[0], extPort: parts[1], ip: parts[2], intPort: parts[3], proto: parts[4]})
	}
	return rows
}

func renderVTSList(rows []vtsRow) string {
	var b strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&b, "<%s>%s>%s>%s>%s", r.desc, r.extPort, r.ip, r.intPort, r.proto)
	}
	return b.String()
}

func parsePortRange(s string) (int, int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, 0, false
	}
	if i := strings.IndexAny(s, ":-"); i > 0 {
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
	return fmt.Sprintf("%d:%d", a, b)
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	m, err := d.appGet(ctx, "settings", "nvram_get(vts_rulelist)")
	if err != nil {
		return nil, err
	}
	rows := parseVTSList(str(m["vts_rulelist"]))
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto, ok := router.NormalizeProtocol(r.proto)
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(r.extPort)
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(r.intPort)
		if !ok {
			is, ie = es, ee
		}
		owner := router.OwnerAdmin
		if strings.HasPrefix(r.desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            strconv.Itoa(i + 1),
			Enabled:       true,
			Description:   r.desc,
			Protocol:      proto,
			ExternalStart: es,
			ExternalEnd:   ee,
			InternalStart: is,
			InternalEnd:   ie,
			InternalIP:    r.ip,
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
	val := "0"
	if enabled {
		val = "1"
	}
	var key string
	switch id {
	case "wl0":
		key = "wl0_radio"
	case "wl1":
		key = "wl1_radio"
	case "wl0.1":
		key = "wl0.1_bss_enabled"
	case "wl1.1":
		key = "wl1.1_bss_enabled"
	default:
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown Asuswrt Wi-Fi id %q", id)
	}
	if err := d.applyNVRAM(ctx, "wifi", "restart_wireless", map[string]string{key: val}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set Asuswrt %s=%s", key, val),
		Undo:      "Toggle the Wi-Fi network back in LAN Detective or Asuswrt Wireless settings",
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
	m, err := d.appGet(ctx, "reserve", "nvram_get(dhcp_staticlist)")
	if err != nil {
		return router.Change{}, err
	}
	rows := parseDHCPStaticList(str(m["dhcp_staticlist"]))
	replaced := false
	for i := range rows {
		if rows[i].mac == mac {
			if rows[i].ip == ip.String() {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			rows[i].ip = ip.String()
			replaced = true
			break
		}
	}
	if !replaced {
		rows = append(rows, dhcpStaticRow{mac: mac, ip: ip.String()})
	}
	if err := d.applyNVRAM(ctx, "reserve", "restart_dnsmasq", map[string]string{
		"dhcp_static_x":   "1",
		"dhcp_staticlist": renderDHCPStaticList(rows),
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s in Asuswrt dhcp_staticlist", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or under LAN → DHCP Server in Asuswrt",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	m, err := d.appGet(ctx, "unreserve", "nvram_get(dhcp_staticlist)")
	if err != nil {
		return router.Change{}, err
	}
	rows := parseDHCPStaticList(str(m["dhcp_staticlist"]))
	var kept []dhcpStaticRow
	var removedIP string
	for _, r := range rows {
		if r.mac == mac {
			removedIP = r.ip
			continue
		}
		kept = append(kept, r)
	}
	if removedIP == "" {
		return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no reservation found in Asuswrt dhcp_staticlist"}, nil
	}
	if err := d.applyNVRAM(ctx, "unreserve", "restart_dnsmasq", map[string]string{
		"dhcp_staticlist": renderDHCPStaticList(kept),
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unreserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("removed Asuswrt DHCP reservation %s for %s", removedIP, mac),
		Undo:      "Add the reservation again in LAN Detective",
	}, nil
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
	m, err := d.appGet(ctx, "add_port_forward", "nvram_get(vts_rulelist)")
	if err != nil {
		return router.Change{}, err
	}
	rows := parseVTSList(str(m["vts_rulelist"]))
	proto := strings.ToUpper(clean.Protocol)
	if clean.Protocol == router.ProtoBoth {
		proto = "BOTH"
	}
	rows = append(rows, vtsRow{
		desc:    strings.NewReplacer("<", "", ">", "").Replace(clean.Description),
		extPort: formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		ip:      clean.InternalIP,
		intPort: formatPortRange(clean.InternalStart, clean.InternalEnd),
		proto:   proto,
	})
	if err := d.applyNVRAM(ctx, "add_port_forward", "restart_firewall", map[string]string{
		"vts_enable_x": "1",
		"vts_rulelist": renderVTSList(rows),
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added Asuswrt port forward %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in LAN Detective or under WAN → Virtual Server / Port Forwarding in Asuswrt",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, err := d.readPortForwards(ctx)
	if err != nil {
		return router.Change{}, err
	}
	m, err := d.appGet(ctx, "remove_port_forward", "nvram_get(vts_rulelist)")
	if err != nil {
		return router.Change{}, err
	}
	rows := parseVTSList(str(m["vts_rulelist"]))
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "Asuswrt rule %s changed since it was last read", rule.ID)
		}
		if i < len(rows) {
			rows = append(rows[:i], rows[i+1:]...)
		}
		if err := d.applyNVRAM(ctx, "remove_port_forward", "restart_firewall", map[string]string{
			"vts_rulelist": renderVTSList(rows),
		}); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed Asuswrt port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present on Asuswrt"}, nil
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
	safeName := strings.NewReplacer("<", "", ">", "").Replace(name)
	m, err := d.appGet(ctx, "rename", "nvram_get(custom_clientlist)")
	if err != nil {
		return router.Change{}, err
	}
	var kept []string
	updated := false
	for _, entry := range strings.Split(str(m["custom_clientlist"]), "<") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ">")
		if len(parts) >= 2 {
			if em, err := router.NormalizeMAC(parts[1]); err == nil && em == mac {
				parts[0] = safeName
				kept = append(kept, strings.Join(parts, ">"))
				updated = true
				continue
			}
		}
		kept = append(kept, entry)
	}
	if !updated {
		kept = append(kept, fmt.Sprintf("%s>%s>0>0>>", safeName, strings.ToUpper(mac)))
	}
	val := "<" + strings.Join(kept, "<")
	if err := d.applyNVRAM(ctx, "rename", "", map[string]string{"custom_clientlist": val}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("set Asuswrt client nickname for %s to %q", mac, safeName),
		Undo:      "Rename the client again in LAN Detective or Asuswrt Network Map",
	}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if err := d.applyNVRAM(ctx, "reboot", "reboot", nil); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "Asuswrt accepted reboot request",
	}, nil
}
