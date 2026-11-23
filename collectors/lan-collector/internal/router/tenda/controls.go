package tenda

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "Tenda system & WAN status (/goform/getStatus)"
	mechWiFi        = "Tenda Wi-Fi toggle (/goform/setWifiBasicCfg)"
	mechReservation = "Tenda static IP binding (/goform/setStaticIP)"
	mechPortForward = "Tenda virtual server (/goform/setVirtualServer)"
	mechReboot      = "Tenda system reboot (/goform/sysReboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) postForm(ctx context.Context, op, path string, form url.Values) error {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return err
		}
	}
	st, _, err := d.rawDo(ctx, op, http.MethodPost, path, form)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "Tenda %s returned HTTP %d", path, st)
	}
	return nil
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	m, err := d.getJSON(ctx, "settings", "/goform/getStatus?modules=internetStatus,lanStatus")
	if err != nil {
		return ov, nil
	}
	if lan, ok := m["lanStatus"].(map[string]any); ok {
		if ip := strings.TrimSpace(str(lan["lanIP"])); ip != "" {
			ov.LANIP = ip
		}
	}
	if inet, ok := m["internetStatus"].(map[string]any); ok {
		if sec, err := strconv.ParseInt(strings.TrimSpace(str(inet["uptime"])), 10, 64); err == nil && sec > 0 {
			ov.UptimeSeconds = &sec
		}
		wanIP := strings.TrimSpace(str(inet["wanIP"]))
		if wanIP != "" && wanIP != "0.0.0.0" {
			st := "up"
			if strings.EqualFold(str(inet["wanStatus"]), "disconnected") || str(inet["wanStatus"]) == "0" {
				st = "down"
			}
			var dns []string
			for _, k := range []string{"wanDns1", "wanDns2"} {
				if a, err := netip.ParseAddr(strings.TrimSpace(str(inet[k]))); err == nil && a.Is4() {
					dns = append(dns, a.String())
				}
			}
			ov.WAN = []router.WANLink{{Name: "WAN", Status: st, Type: str(inet["wanConnectType"]), IPv4: wanIP, DNS: dns}}
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	m, err := d.getJSON(ctx, "settings", "/goform/getWifi?modules=wifiBasicCfg")
	if err != nil {
		return nil, nil
	}
	cfg, _ := m["wifiBasicCfg"].(map[string]any)
	if cfg == nil {
		cfg = m
	}
	var out []router.WiFiNetwork
	if ssid := strings.TrimSpace(str(cfg["wifiSSID"])); ssid != "" {
		out = append(out, router.WiFiNetwork{
			ID:       "2g",
			Band:     "2.4GHz",
			SSID:     ssid,
			Enabled:  strings.EqualFold(str(cfg["wifiEn"]), "true") || str(cfg["wifiEn"]) == "1",
			Main:     true,
			Guest:    false,
			Hidden:   strings.EqualFold(str(cfg["wifiHideSSID"]), "true") || str(cfg["wifiHideSSID"]) == "1",
			Security: str(cfg["wifiSecurityMode"]),
		})
	}
	if ssid := strings.TrimSpace(str(cfg["wifi5gSSID"])); ssid != "" {
		out = append(out, router.WiFiNetwork{
			ID:       "5g",
			Band:     "5GHz",
			SSID:     ssid,
			Enabled:  strings.EqualFold(str(cfg["wifi5gEn"]), "true") || str(cfg["wifi5gEn"]) == "1",
			Main:     true,
			Guest:    false,
			Hidden:   strings.EqualFold(str(cfg["wifi5gHideSSID"]), "true") || str(cfg["wifi5gHideSSID"]) == "1",
			Security: str(cfg["wifi5gSecurityMode"]),
		})
	}
	return out, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	m, err := d.getJSON(ctx, "settings", "/goform/getStaticIP?modules=staticList")
	if err != nil {
		return nil, nil
	}
	rows := sliceOfMaps(m["staticList"])
	out := make([]router.Reservation, 0, len(rows))
	for i, r := range rows {
		mac, err := router.NormalizeMAC(first(str(r["mac"]), str(r["staticMac"])))
		ip := strings.TrimSpace(first(str(r["ip"]), str(r["staticIP"])))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{ID: strconv.Itoa(i + 1), MAC: mac, IP: ip, Enabled: true})
	}
	return out, nil
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
	m, err := d.getJSON(ctx, "settings", "/goform/getVirtualServer?modules=virtualList")
	if err != nil {
		return nil, nil
	}
	rows := sliceOfMaps(m["virtualList"])
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto, ok := router.NormalizeProtocol(first(str(r["protocol"]), "both"))
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(first(str(r["wanPort"]), str(r["externalPort"])))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(first(str(r["lanPort"]), str(r["internalPort"])))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(first(str(r["ip"]), str(r["lanIP"])))
		if ip == "" {
			continue
		}
		desc := first(str(r["remark"]), str(r["name"]))
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            strconv.Itoa(i + 1),
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
	val := "false"
	if enabled {
		val = "true"
	}
	form := url.Values{}
	switch id {
	case "2g":
		form.Set("wifiEn", val)
	case "5g":
		form.Set("wifi5gEn", val)
	default:
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown Tenda Wi-Fi id %q", id)
	}
	if err := d.postForm(ctx, "wifi", "/goform/setWifiBasicCfg", form); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set Tenda Wi-Fi %s enabled=%s", id, val),
		Undo:      "Toggle the Wi-Fi network back in Nigafiy or Tenda Wireless Settings",
	}, nil
}

func renderTendaStaticList(rows []router.Reservation) string {
	lines := make([]string, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, fmt.Sprintf("%s\t%s\t", r.IP, strings.ToLower(r.MAC)))
	}
	return strings.Join(lines, "\n")
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, _ := d.readReservations(ctx)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	replaced := false
	for i := range existing {
		if existing[i].MAC == mac {
			if existing[i].IP == ip.String() {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			existing[i].IP = ip.String()
			replaced = true
			break
		}
	}
	if !replaced {
		existing = append(existing, router.Reservation{MAC: mac, IP: ip.String(), Enabled: true})
	}
	if err := d.postForm(ctx, "reserve", "/goform/setStaticIP", url.Values{"list": {renderTendaStaticList(existing)}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on Tenda router", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or under Advanced → Static IP Assignment on Tenda",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	existing, _ := d.readReservations(ctx)
	var kept []router.Reservation
	var removedIP string
	for _, r := range existing {
		if r.MAC == mac {
			removedIP = r.IP
			continue
		}
		kept = append(kept, r)
	}
	if removedIP == "" {
		return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no Tenda static IP reservation found for this MAC"}, nil
	}
	if err := d.postForm(ctx, "unreserve", "/goform/setStaticIP", url.Values{"list": {renderTendaStaticList(kept)}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unreserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("removed Tenda static IP reservation %s for %s", removedIP, mac),
		Undo:      "Add the reservation again in Nigafiy",
	}, nil
}

func renderTendaVSList(rows []router.PortForward) string {
	lines := make([]string, 0, len(rows))
	for _, r := range rows {
		proto := strings.ToUpper(r.Protocol)
		if r.Protocol == router.ProtoBoth {
			proto = "BOTH"
		}
		lines = append(lines, fmt.Sprintf("%s\t%s\t%s\t%s\t%s",
			r.InternalIP,
			formatPortRange(r.InternalStart, r.InternalEnd),
			formatPortRange(r.ExternalStart, r.ExternalEnd),
			proto,
			strings.ReplaceAll(r.Description, "\t", " "),
		))
	}
	return strings.Join(lines, "\n")
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	existing = append(existing, clean)
	if err := d.postForm(ctx, "add_port_forward", "/goform/setVirtualServer", url.Values{"list": {renderTendaVSList(existing)}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added Tenda virtual server %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in Nigafiy or under Advanced → Port Forwarding on Tenda",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "Tenda virtual server %s changed since it was last read", rule.ID)
		}
		kept := append(existing[:i], existing[i+1:]...)
		if err := d.postForm(ctx, "remove_port_forward", "/goform/setVirtualServer", url.Values{"list": {renderTendaVSList(kept)}}); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed Tenda virtual server %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "virtual server rule is no longer present on Tenda"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if err := d.postForm(ctx, "reboot", "/goform/sysReboot", url.Values{"module1": {"sysOperate"}, "action": {"reboot"}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "Tenda router accepted reboot request",
	}, nil
}
