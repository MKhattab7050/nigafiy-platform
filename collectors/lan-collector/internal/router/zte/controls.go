package zte

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
	mechOverview    = "ZTE ZXHN CGILua status (devmgr_statusmgr_lua, status_wan_if_lua, localnet_lan_lua)"
	mechWiFi        = "ZTE ZXHN WLAN toggle (wlan_basicadconf_lua)"
	mechReservation = "ZTE ZXHN static DHCP table (localnet_lan_dhcps_lua)"
	mechPortForward = "ZTE ZXHN port forwarding (app_portforwarding_lua)"
	mechReboot      = "ZTE ZXHN device restart (devmgr_restart_lua)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) postMenuData(ctx context.Context, op, tag string, form url.Values) error {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return err
		}
	}
	if len(d.sessToken) > 0 {
		form.Set("_sessionTOKEN", string(d.sessToken))
	}
	st, _, err := d.rawDo(ctx, op, http.MethodPost, "/?_type=menuData&_tag="+url.QueryEscape(tag), form)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "ZTE %s returned HTTP %d", tag, st)
	}
	return nil
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if raw, err := d.getMenuData(ctx, "settings", "devmgr_statusmgr_lua.lua"); err == nil {
		for _, m := range parseZTEInstances(raw) {
			if sec, err := strconv.ParseInt(strings.TrimSpace(first(m["PowerOnTime"], m["UpTime"])), 10, 64); err == nil && sec > 0 {
				ov.UptimeSeconds = &sec
				break
			}
		}
	}
	if raw, err := d.getMenuData(ctx, "settings", "localnet_lan_lua.lua"); err == nil {
		for _, m := range parseZTEInstances(raw) {
			if ip := first(m["IPAddr"], m["IPAddress"]); ip != "" {
				ov.LANIP = ip
				break
			}
		}
	}
	if raw, err := d.getMenuData(ctx, "settings", "status_wan_if_lua.lua"); err == nil {
		for _, m := range parseZTEInstances(raw) {
			name := first(m["WANCName"], m["Name"])
			ip := first(m["IPAddress"], m["ExternalIPAddress"])
			if name == "" && ip == "" {
				continue
			}
			st := "down"
			cs := strings.ToLower(first(m["ConnStatus"], m["Status"]))
			if cs == "connected" || cs == "up" {
				st = "up"
			} else if strings.Contains(cs, "connect") {
				st = "connecting"
			}
			var dns []string
			for _, x := range []string{m["DNS1"], m["DNS2"]} {
				if a, err := netip.ParseAddr(strings.TrimSpace(x)); err == nil && a.Is4() {
					dns = append(dns, a.String())
				}
			}
			ov.WAN = append(ov.WAN, router.WANLink{
				Name:   first(name, "WAN"),
				Status: st,
				Type:   first(m["TransType"], m["LinkMode"]),
				IPv4:   ip,
				DNS:    dns,
			})
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	raw, err := d.getMenuData(ctx, "settings", "wlan_basicadconf_lua.lua")
	if err != nil {
		return nil, nil
	}
	insts := parseZTEInstances(raw)
	out := make([]router.WiFiNetwork, 0, len(insts))
	for i, m := range insts {
		ssid := first(m["ESSID"], m["SSID"])
		if ssid == "" {
			continue
		}
		id := first(m["_InstID"], m["InstID"], strconv.Itoa(i+1))
		guest := strings.Contains(strings.ToLower(ssid), "guest")
		band := first(m["RFBand"], m["Band"])
		switch {
		case strings.Contains(strings.ToLower(band), "5"):
			band = "5GHz"
		case strings.Contains(strings.ToLower(band), "2"):
			band = "2.4GHz"
		}
		out = append(out, router.WiFiNetwork{
			ID:       id,
			Band:     band,
			SSID:     ssid,
			Enabled:  m["Enable"] != "0",
			Main:     !guest,
			Guest:    guest,
			Hidden:   m["ESSIDHideEnable"] == "1",
			Security: first(m["BeaconType"], m["AuthMode"]),
		})
	}
	return out, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	raw, err := d.getMenuData(ctx, "settings", "localnet_lan_dhcps_lua.lua")
	if err != nil {
		return nil, nil
	}
	insts := parseZTEInstances(raw)
	out := make([]router.Reservation, 0)
	for i, m := range insts {
		mac, err := router.NormalizeMAC(first(m["MACAddr"], m["MACAddress"]))
		ip := strings.TrimSpace(first(m["IPAddr"], m["IPAddress"]))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      first(m["_InstID"], m["InstID"], strconv.Itoa(i+1)),
			MAC:     mac,
			IP:      ip,
			Enabled: m["Enable"] != "0",
		})
	}
	return out, nil
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	raw, err := d.getMenuData(ctx, "settings", "app_portforwarding_lua.lua")
	if err != nil {
		return nil, nil
	}
	insts := parseZTEInstances(raw)
	out := make([]router.PortForward, 0)
	for i, m := range insts {
		proto, ok := router.NormalizeProtocol(first(m["Protocol"], m["Proto"]))
		if !ok {
			continue
		}
		es, err1 := strconv.Atoi(strings.TrimSpace(first(m["MinExtPort"], m["ExternalPort"])))
		ee, err2 := strconv.Atoi(strings.TrimSpace(first(m["MaxExtPort"], m["MinExtPort"], m["ExternalPort"])))
		is, err3 := strconv.Atoi(strings.TrimSpace(first(m["MinIntPort"], m["InternalPort"])))
		ie, err4 := strconv.Atoi(strings.TrimSpace(first(m["MaxIntPort"], m["MinIntPort"], m["InternalPort"])))
		ip := strings.TrimSpace(first(m["InternalHost"], m["InternalClient"]))
		if err1 != nil || es < 1 || ip == "" {
			continue
		}
		if err2 != nil || ee < es {
			ee = es
		}
		if err3 != nil || is < 1 {
			is = es
		}
		if err4 != nil || ie < is {
			ie = is + (ee - es)
		}
		desc := first(m["Name"], m["Description"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            first(m["_InstID"], m["InstID"], strconv.Itoa(i+1)),
			Enabled:       m["Enable"] != "0",
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
	en := "0"
	if enabled {
		en = "1"
	}
	form := url.Values{
		"IF_ACTION": {"Apply"},
		"_InstID":   {id},
		"Enable":    {en},
	}
	if err := d.postMenuData(ctx, "wifi", "wlan_basicadconf_lua.lua", form); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set ZTE WLAN %s Enable=%s", id, en),
		Undo:      "Toggle the Wi-Fi network back in LAN Detective or the ZTE gateway UI",
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
	form := url.Values{
		"IF_ACTION":  {"Apply"},
		"Enable":     {"1"},
		"MACAddr":    {strings.ToUpper(mac)},
		"MACAddress": {strings.ToUpper(mac)},
		"IPAddr":     {ip.String()},
		"IPAddress":  {ip.String()},
	}
	if err := d.postMenuData(ctx, "reserve", "localnet_lan_dhcps_lua.lua", form); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on ZTE gateway", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or under Local Network → LAN → DHCP Binding on ZTE",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	existing, _ := d.readReservations(ctx)
	for _, r := range existing {
		if r.MAC != mac {
			continue
		}
		form := url.Values{
			"IF_ACTION": {"Delete"},
			"_InstID":   {r.ID},
			"MACAddr":   {strings.ToUpper(mac)},
		}
		if err := d.postMenuData(ctx, "unreserve", "localnet_lan_dhcps_lua.lua", form); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("removed ZTE DHCP reservation %s for %s", r.IP, mac),
			Undo:      "Add the reservation again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no ZTE DHCP reservation found for this MAC"}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	proto := strings.ToUpper(clean.Protocol)
	if clean.Protocol == router.ProtoBoth {
		proto = "TCP AND UDP"
	}
	form := url.Values{
		"IF_ACTION":    {"Apply"},
		"Enable":       {"1"},
		"Name":         {clean.Description},
		"Protocol":     {proto},
		"MinExtPort":   {strconv.Itoa(clean.ExternalStart)},
		"MaxExtPort":   {strconv.Itoa(clean.ExternalEnd)},
		"MinIntPort":   {strconv.Itoa(clean.InternalStart)},
		"MaxIntPort":   {strconv.Itoa(clean.InternalEnd)},
		"InternalHost": {clean.InternalIP},
	}
	if err := d.postMenuData(ctx, "add_port_forward", "app_portforwarding_lua.lua", form); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added ZTE port forward %s %d-%d → %s:%d-%d", clean.Protocol, clean.ExternalStart, clean.ExternalEnd, clean.InternalIP, clean.InternalStart, clean.InternalEnd),
		Undo:      "Remove the rule in LAN Detective or under Internet → Security → Port Forwarding on ZTE",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "ZTE port-forward rule %s changed since it was last read", rule.ID)
		}
		form := url.Values{
			"IF_ACTION": {"Delete"},
			"_InstID":   {e.ID},
		}
		if err := d.postMenuData(ctx, "remove_port_forward", "app_portforwarding_lua.lua", form); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed ZTE port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present on ZTE gateway"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if err := d.postMenuData(ctx, "reboot", "devmgr_restart_lua.lua", url.Values{"IF_ACTION": {"devrestart"}}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "ZTE gateway accepted restart request",
	}, nil
}
