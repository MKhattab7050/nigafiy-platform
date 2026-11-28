package mikrotik

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
	mechOverview    = "RouterOS system resource, IP addresses and DNS (/rest/system/resource, /rest/ip/address)"
	mechWiFi        = "RouterOS Wi-Fi interface enable/disable (/rest/interface/wifi or /rest/interface/wireless)"
	mechReservation = "RouterOS static DHCP lease (/rest/ip/dhcp-server/lease)"
	mechPortForward = "RouterOS dst-nat rule (/rest/ip/firewall/nat)"
	mechRename      = "RouterOS DHCP lease comment (/rest/ip/dhcp-server/lease)"
	mechReboot      = "RouterOS system reboot (/rest/system/reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) lanPrefix(ctx context.Context) (netip.Prefix, netip.Addr) {
	addrs, _, err := d.getList(ctx, "settings", "/rest/ip/address")
	if err != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	for _, a := range addrs {
		if boolVal(a["disabled"]) {
			continue
		}
		p, err := netip.ParsePrefix(strVal(a["address"]))
		if err != nil || !p.Addr().Is4() {
			continue
		}
		if p.Addr() == d.target.Address || strings.Contains(strings.ToLower(strVal(a["interface"])), "bridge") || strings.Contains(strings.ToLower(strVal(a["interface"])), "lan") {
			return p.Masked(), p.Addr()
		}
	}
	return netip.Prefix{}, netip.Addr{}
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{}
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/rest/system/resource", nil); err == nil && st == http.StatusOK {
		if res, ok := decodeSingleObject(raw); ok {
			if dur, ok := parseROSDuration(strVal(res["uptime"])); ok {
				sec := int64(dur.Seconds())
				ov.UptimeSeconds = &sec
			}
		}
	}

	var dnsServers []string
	if st, raw, err := d.do(ctx, "settings", http.MethodGet, "/rest/ip/dns", nil); err == nil && st == http.StatusOK {
		if dns, ok := decodeSingleObject(raw); ok {
			for _, field := range []string{"servers", "dynamic-servers"} {
				for _, part := range strings.Split(strVal(dns[field]), ",") {
					part = strings.TrimSpace(part)
					if a, err := netip.ParseAddr(part); err == nil && a.Is4() {
						dnsServers = append(dnsServers, a.String())
					}
				}
			}
		}
	}

	addrs, _, _ := d.getList(ctx, "settings", "/rest/ip/address")
	for _, a := range addrs {
		if boolVal(a["disabled"]) {
			continue
		}
		p, err := netip.ParsePrefix(strVal(a["address"]))
		if err != nil || !p.Addr().Is4() {
			continue
		}
		iface := strVal(a["interface"])
		if p.Addr() == d.target.Address || (ov.LANIP == "" && router.IsPrivate(p.Addr()) && (strings.Contains(strings.ToLower(iface), "bridge") || strings.Contains(strings.ToLower(iface), "lan"))) {
			ov.LANIP = p.Addr().String()
			continue
		}
		if !router.IsPrivate(p.Addr()) || strings.Contains(strings.ToLower(iface), "wan") || strings.Contains(strings.ToLower(iface), "pppoe") || strings.EqualFold(iface, "ether1") {
			ov.WAN = append(ov.WAN, router.WANLink{
				Name:   firstNonEmpty(iface, "WAN"),
				Status: "up",
				IPv4:   p.Addr().String(),
				DNS:    dnsServers,
			})
		}
	}
	if ov.LANIP == "" {
		ov.LANIP = d.target.Address.String()
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	regClients := map[string][]string{}
	regs, _, _ := d.getList(ctx, "settings", "/rest/interface/wifi/registration-table")
	legacyRegs, _, _ := d.getList(ctx, "settings", "/rest/interface/wireless/registration-table")
	for _, r := range append(regs, legacyRegs...) {
		iface := strVal(r["interface"])
		mac, err := router.NormalizeMAC(strVal(r["mac-address"]))
		if iface != "" && err == nil {
			regClients[iface] = append(regClients[iface], mac)
		}
	}

	var out []router.WiFiNetwork
	// RouterOS 7.13+ wifiwave2 / wifi package
	wifiIfs, _, _ := d.getList(ctx, "settings", "/rest/interface/wifi")
	for _, w := range wifiIfs {
		id := strVal(w[".id"])
		name := strVal(w["name"])
		ssid := firstNonEmpty(strVal(w["configuration.ssid"]), strVal(w["ssid"]), name)
		if id == "" || ssid == "" {
			continue
		}
		master := strVal(w["master-interface"])
		isGuest := master != "" || strings.Contains(strings.ToLower(ssid), "guest")
		out = append(out, router.WiFiNetwork{
			ID:         "wifi:" + id,
			Band:       rosBandLabel(firstNonEmpty(strVal(w["channel.band"]), strVal(w["band"]), name)),
			SSID:       ssid,
			Enabled:    !boolVal(w["disabled"]),
			Main:       !isGuest,
			Guest:      isGuest,
			Hidden:     boolVal(w["configuration.hide-ssid"]),
			Security:   strVal(w["configuration.security.authentication-types"]),
			ClientMACs: regClients[name],
		})
	}
	// Legacy wireless package
	legacyIfs, _, _ := d.getList(ctx, "settings", "/rest/interface/wireless")
	for _, w := range legacyIfs {
		id := strVal(w[".id"])
		name := strVal(w["name"])
		ssid := firstNonEmpty(strVal(w["ssid"]), name)
		if id == "" || ssid == "" {
			continue
		}
		master := strVal(w["master-interface"])
		isGuest := master != "" || strings.Contains(strings.ToLower(ssid), "guest")
		out = append(out, router.WiFiNetwork{
			ID:         "wireless:" + id,
			Band:       rosBandLabel(firstNonEmpty(strVal(w["band"]), name)),
			SSID:       ssid,
			Enabled:    !boolVal(w["disabled"]),
			Main:       !isGuest,
			Guest:      isGuest,
			Hidden:     boolVal(w["hide-ssid"]),
			Security:   strVal(w["security-profile"]),
			ClientMACs: regClients[name],
		})
	}
	return out, nil
}

func rosBandLabel(s string) string {
	switch wifiBand(s) {
	case router.ConnWiFi6:
		return "6GHz"
	case router.ConnWiFi5:
		return "5GHz"
	case router.ConnWiFi24:
		return "2.4GHz"
	default:
		return ""
	}
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	leases, _, err := d.getList(ctx, "settings", "/rest/ip/dhcp-server/lease")
	if err != nil {
		return nil, err
	}
	out := make([]router.Reservation, 0)
	for _, l := range leases {
		if boolVal(l["dynamic"]) {
			continue
		}
		mac, err := router.NormalizeMAC(strVal(l["mac-address"]))
		ip := strings.TrimSpace(strVal(l["address"]))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      strVal(l[".id"]),
			MAC:     mac,
			IP:      ip,
			Enabled: !boolVal(l["disabled"]),
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
	rules, _, err := d.getList(ctx, "settings", "/rest/ip/firewall/nat")
	if err != nil {
		return nil, err
	}
	out := make([]router.PortForward, 0)
	for _, r := range rules {
		if strVal(r["chain"]) != "dstnat" || strVal(r["action"]) != "dst-nat" {
			continue
		}
		proto, ok := router.NormalizeProtocol(strVal(r["protocol"]))
		if !ok {
			continue
		}
		es, ee, ok := parsePortRange(strVal(r["dst-port"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(strVal(r["to-ports"]))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(strVal(r["to-addresses"]))
		if ip == "" {
			continue
		}
		desc := strVal(r["comment"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            strVal(r[".id"]),
			Enabled:       !boolVal(r["disabled"]),
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
	var path string
	switch {
	case strings.HasPrefix(id, "wifi:"):
		path = "/rest/interface/wifi/" + url.PathEscape(strings.TrimPrefix(id, "wifi:"))
	case strings.HasPrefix(id, "wireless:"):
		path = "/rest/interface/wireless/" + url.PathEscape(strings.TrimPrefix(id, "wireless:"))
	default:
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown MikroTik Wi-Fi id %q", id)
	}
	disabled := "true"
	if enabled {
		disabled = "false"
	}
	st, raw, err := d.do(ctx, "wifi", http.MethodPatch, path, map[string]any{"disabled": disabled})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "wifi", "cannot toggle Wi-Fi (%s)", apiErrDetail(raw, st))
	}
	state := "disabled"
	if enabled {
		state = "enabled"
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set MikroTik Wi-Fi %s to %s", id, state),
		Undo:      "Toggle the Wi-Fi network back in Nigafiy or WinBox/WebFig",
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
	leases, _, err := d.getList(ctx, "reserve", "/rest/ip/dhcp-server/lease")
	if err != nil {
		return router.Change{}, err
	}
	var existingID string
	var isDynamic bool
	for _, l := range leases {
		if m, err := router.NormalizeMAC(strVal(l["mac-address"])); err == nil && m == mac {
			existingID = strVal(l[".id"])
			isDynamic = boolVal(l["dynamic"])
			if !isDynamic && strings.TrimSpace(strVal(l["address"])) == ip.String() && !boolVal(l["disabled"]) {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			break
		}
	}
	if existingID != "" && isDynamic {
		_, _, _ = d.do(ctx, "reserve", http.MethodPost, "/rest/ip/dhcp-server/lease/make-static", map[string]any{".id": existingID})
	}
	if existingID != "" {
		st, raw, err := d.do(ctx, "reserve", http.MethodPatch, "/rest/ip/dhcp-server/lease/"+url.PathEscape(existingID), map[string]any{
			"address":  ip.String(),
			"disabled": "false",
		})
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK {
			return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "cannot update DHCP lease (%s)", apiErrDetail(raw, st))
		}
	} else {
		st, raw, err := d.do(ctx, "reserve", http.MethodPut, "/rest/ip/dhcp-server/lease", map[string]any{
			"mac-address": strings.ToUpper(mac),
			"address":     ip.String(),
		})
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusCreated {
			return router.Change{}, router.Errorf(router.ErrRejected, "reserve", "cannot add static DHCP lease (%s)", apiErrDetail(raw, st))
		}
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on MikroTik DHCP server", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or under IP → DHCP Server → Leases on MikroTik",
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
		st, raw, err := d.do(ctx, "unreserve", http.MethodDelete, "/rest/ip/dhcp-server/lease/"+url.PathEscape(r.ID), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusNoContent {
			return router.Change{}, router.Errorf(router.ErrRejected, "unreserve", "cannot delete static lease (%s)", apiErrDetail(raw, st))
		}
		return router.Change{
			Action:    "unreserve",
			MAC:       mac,
			Mechanism: mechReservation,
			Applied:   true,
			Detail:    fmt.Sprintf("removed static DHCP reservation %s for %s", r.IP, mac),
			Undo:      "Add the reservation again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no static DHCP lease found for this MAC"}, nil
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
	protos := []string{clean.Protocol}
	if clean.Protocol == router.ProtoBoth {
		protos = []string{router.ProtoTCP, router.ProtoUDP}
	}
	for _, p := range protos {
		payload := map[string]any{
			"chain":        "dstnat",
			"action":       "dst-nat",
			"protocol":     p,
			"dst-port":     formatPortRange(clean.ExternalStart, clean.ExternalEnd),
			"to-addresses": clean.InternalIP,
			"to-ports":     formatPortRange(clean.InternalStart, clean.InternalEnd),
			"comment":      clean.Description,
			// Only packets addressed to the router itself. Without a destination matcher a dstnat
			// rule catches every packet to that port crossing the router: forwarding 443 would send
			// all LAN clients' outbound HTTPS (and this REST session) to the internal host.
			"dst-address-type": "local",
		}
		if routerIP.IsValid() {
			// Not the router's LAN address: WebFig / REST / SSH from the LAN keep reaching the router
			// itself; the WAN address (and hairpin to it) is still forwarded.
			payload["dst-address"] = "!" + routerIP.String()
		}
		st, raw, err := d.do(ctx, "add_port_forward", http.MethodPut, "/rest/ip/firewall/nat", payload)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusCreated {
			return router.Change{}, router.Errorf(router.ErrRejected, "add_port_forward", "cannot add dst-nat rule (%s)", apiErrDetail(raw, st))
		}
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("forwarded %s %s → %s:%s (%s)", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd), clean.Description),
		Undo:      "Remove the port forward in Nigafiy or under IP → Firewall → NAT on MikroTik",
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
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "NAT rule %s changed on the router since it was last read", rule.ID)
		}
		st, raw, err := d.do(ctx, "remove_port_forward", http.MethodDelete, "/rest/ip/firewall/nat/"+url.PathEscape(e.ID), nil)
		if err != nil {
			return router.Change{}, err
		}
		if st != http.StatusOK && st != http.StatusNoContent {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "cannot remove NAT rule (%s)", apiErrDetail(raw, st))
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed dst-nat rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "NAT rule is no longer present on MikroTik"}, nil
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
	leases, _, err := d.getList(ctx, "rename", "/rest/ip/dhcp-server/lease")
	if err != nil {
		return router.Change{}, err
	}
	for _, l := range leases {
		if m, err := router.NormalizeMAC(strVal(l["mac-address"])); err == nil && m == mac {
			id := strVal(l[".id"])
			st, raw, err := d.do(ctx, "rename", http.MethodPatch, "/rest/ip/dhcp-server/lease/"+url.PathEscape(id), map[string]any{"comment": name})
			if err != nil {
				return router.Change{}, err
			}
			if st != http.StatusOK {
				return router.Change{}, router.Errorf(router.ErrRejected, "rename", "cannot update lease comment (%s)", apiErrDetail(raw, st))
			}
			return router.Change{
				Action:    "rename",
				MAC:       mac,
				Mechanism: mechRename,
				Applied:   true,
				Detail:    fmt.Sprintf("set MikroTik DHCP lease comment for %s to %q", mac, name),
				Undo:      "Rename the device again in Nigafiy or WinBox",
			}, nil
		}
	}
	return router.Change{}, router.Errorf(router.ErrNotFound, "rename", "MikroTik has no DHCP lease for %s", mac)
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	st, raw, err := d.do(ctx, "reboot", http.MethodPost, "/rest/system/reboot", map[string]any{})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK && st != http.StatusNoContent {
		return router.Change{}, router.Errorf(router.ErrRejected, "reboot", "reboot rejected (%s)", apiErrDetail(raw, st))
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "MikroTik accepted system reboot request",
	}, nil
}
