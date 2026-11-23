package omada

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
	mechOverview    = "TP-Link Omada gateway device status (/sites/{site}/devices)"
	mechWiFi        = "TP-Link Omada SSID toggle (/setting/wlans/{wlanId}/ssids/{ssidId})"
	mechReservation = "TP-Link Omada client fixed IP (/clients/{mac} ipSetting)"
	mechPortForward = "TP-Link Omada port forwarding (/setting/transmission/portForwarding)"
	mechRename      = "TP-Link Omada client name (/clients/{mac} name)"
	mechReboot      = "TP-Link Omada gateway reboot (/cmd/devices/{mac}/reboot)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) sitePrefix() string {
	return "/" + d.omadacID + "/api/v2/sites/" + d.siteID
}

func (d *Driver) ensureReady(ctx context.Context) error {
	if !d.loggedIn {
		return d.login(ctx)
	}
	return nil
}

func (d *Driver) findGateway(ctx context.Context) map[string]any {
	res, err := d.call(ctx, "settings", http.MethodGet, d.sitePrefix()+"/devices", nil)
	if err != nil {
		return nil
	}
	var devs []map[string]any
	if json.Unmarshal(res, &devs) != nil {
		var page struct {
			Data []map[string]any `json:"data"`
		}
		if json.Unmarshal(res, &page) == nil {
			devs = page.Data
		}
	}
	for _, dev := range devs {
		if strings.EqualFold(str(dev["type"]), "gateway") {
			return dev
		}
	}
	if len(devs) > 0 {
		return devs[0]
	}
	return nil
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if gw := d.findGateway(ctx); gw != nil {
		if up, ok := intOf(gw["uptimeLong"]); ok && up > 0 {
			sec := int64(up)
			ov.UptimeSeconds = &sec
		}
		if ip := str(gw["ip"]); ip != "" {
			if a, err := netip.ParseAddr(ip); err == nil && a.Is4() && router.IsPrivate(a) {
				ov.LANIP = a.String()
			}
		}
		if wanIP := str(gw["publicIp"]); wanIP != "" {
			ov.WAN = append(ov.WAN, router.WANLink{Name: "WAN", Status: "up", IPv4: wanIP})
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	res, err := d.call(ctx, "settings", http.MethodGet, d.sitePrefix()+"/setting/wlans", nil)
	if err != nil {
		return nil, nil
	}
	var wlans []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(res, &wlans) != nil {
		var page struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if json.Unmarshal(res, &page) == nil {
			wlans = page.Data
		}
	}
	var out []router.WiFiNetwork
	for _, w := range wlans {
		if w.ID == "" {
			continue
		}
		sres, err := d.call(ctx, "settings", http.MethodGet, d.sitePrefix()+"/setting/wlans/"+url.PathEscape(w.ID)+"/ssids", nil)
		if err != nil {
			continue
		}
		var ssids []map[string]any
		if json.Unmarshal(sres, &ssids) != nil {
			var page struct {
				Data []map[string]any `json:"data"`
			}
			if json.Unmarshal(sres, &page) == nil {
				ssids = page.Data
			}
		}
		for _, s := range ssids {
			id := str(s["id"])
			name := str(s["name"])
			if id == "" || name == "" {
				continue
			}
			enabled := true
			if v, ok := s["enable"]; ok {
				enabled = boolOf(v)
			} else if v, ok := s["broadcast"]; ok {
				enabled = boolOf(v)
			}
			guest := boolOf(s["guestNetEnable"])
			out = append(out, router.WiFiNetwork{
				ID:       w.ID + "/" + id,
				Band:     omadaBand(s["band"]),
				SSID:     name,
				Enabled:  enabled,
				Main:     !guest,
				Guest:    guest,
				Hidden:   s["broadcast"] != nil && !boolOf(s["broadcast"]),
				Security: omadaSecurity(s["security"]),
			})
		}
	}
	return out, nil
}

func omadaBand(v any) string {
	n, ok := intOf(v)
	if !ok {
		return ""
	}
	switch n {
	case 1:
		return "2.4GHz"
	case 2:
		return "5GHz"
	case 3:
		return "2.4GHz/5GHz"
	case 4:
		return "6GHz"
	default:
		return "2.4GHz/5GHz/6GHz"
	}
}

func omadaSecurity(v any) string {
	n, ok := intOf(v)
	if !ok {
		return str(v)
	}
	switch n {
	case 0:
		return "None"
	case 1:
		return "WEP"
	case 2:
		return "WPA-Enterprise"
	case 3:
		return "WPA-Personal"
	default:
		return ""
	}
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	res, err := d.call(ctx, "settings", http.MethodGet, d.sitePrefix()+"/clients?currentPage=1&currentPageSize=500", nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(res, &page)
	out := make([]router.Reservation, 0)
	for _, row := range page.Data {
		ipSet, ok := row["ipSetting"].(map[string]any)
		if !ok || !boolOf(ipSet["useFixedAddr"]) {
			continue
		}
		mac, err := router.NormalizeMAC(str(row["mac"]))
		ip := strings.TrimSpace(str(ipSet["ip"]))
		if err != nil || ip == "" {
			continue
		}
		out = append(out, router.Reservation{ID: omadaMAC(mac), MAC: mac, IP: ip, Enabled: true})
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
	res, err := d.call(ctx, "settings", http.MethodGet, d.sitePrefix()+"/setting/transmission/portForwarding?currentPage=1&currentPageSize=100", nil)
	if err != nil {
		return nil, nil
	}
	var page struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(res, &page)
	out := make([]router.PortForward, 0, len(page.Data))
	for _, r := range page.Data {
		proto := omadaProtoFrom(r["protocol"])
		if proto == "" {
			continue
		}
		es, ee, ok := parsePortRange(str(r["sourcePort"]))
		if !ok {
			continue
		}
		is, ie, ok := parsePortRange(str(r["destinationPort"]))
		if !ok {
			is, ie = es, ee
		}
		ip := strings.TrimSpace(str(r["destinationIp"]))
		if ip == "" {
			continue
		}
		name := str(r["name"])
		owner := router.OwnerAdmin
		if strings.HasPrefix(name, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            str(r["id"]),
			Enabled:       boolOf(r["status"]),
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

func omadaProtoFrom(v any) string {
	if n, ok := intOf(v); ok {
		switch n {
		case 1:
			return router.ProtoTCP
		case 2:
			return router.ProtoUDP
		case 0, 3:
			return router.ProtoBoth
		}
	}
	p, _ := router.NormalizeProtocol(str(v))
	return p
}

func omadaProtoTo(p string) int {
	switch p {
	case router.ProtoTCP:
		return 1
	case router.ProtoUDP:
		return 2
	default:
		return 3
	}
}

func (d *Driver) Settings(ctx context.Context) (router.Settings, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Settings{}, err
	}
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
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	parts := strings.SplitN(id, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "invalid Omada SSID id %q", id)
	}
	_, err := d.call(ctx, "wifi", http.MethodPatch, d.sitePrefix()+"/setting/wlans/"+url.PathEscape(parts[0])+"/ssids/"+url.PathEscape(parts[1]), map[string]any{
		"enable":    enabled,
		"broadcast": enabled,
	})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set Omada SSID %s enabled=%v", id, enabled),
		Undo:      "Toggle the SSID back in Nigafiy or Omada Controller Settings → Wireless Networks",
	}, nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
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
	_, err = d.call(ctx, "reserve", http.MethodPatch, d.sitePrefix()+"/clients/"+omadaMAC(mac), map[string]any{
		"ipSetting": map[string]any{"useFixedAddr": true, "ip": ip.String()},
	})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("set Omada fixed IP %s for %s", ip, mac),
		Undo:      "Remove the reservation in Nigafiy or disable Use Fixed IP Address on the client in Omada",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	_, err = d.call(ctx, "unreserve", http.MethodPatch, d.sitePrefix()+"/clients/"+omadaMAC(mac), map[string]any{
		"ipSetting": map[string]any{"useFixedAddr": false},
	})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unreserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("cleared Omada fixed IP for %s", mac),
		Undo:      "Add the reservation again in Nigafiy",
	}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	payload := map[string]any{
		"name":            clean.Description,
		"status":          true,
		"protocol":        omadaProtoTo(clean.Protocol),
		"sourcePort":      formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		"destinationIp":   clean.InternalIP,
		"destinationPort": formatPortRange(clean.InternalStart, clean.InternalEnd),
	}
	_, err = d.call(ctx, "add_port_forward", http.MethodPost, d.sitePrefix()+"/setting/transmission/portForwarding", payload)
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added Omada port forward %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in Nigafiy or Omada Settings → Transmission → NAT → Port Forwarding",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	existing, _ := d.readPortForwards(ctx)
	for _, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "Omada port-forward rule %s changed since it was last read", rule.ID)
		}
		_, err := d.call(ctx, "remove_port_forward", http.MethodDelete, d.sitePrefix()+"/setting/transmission/portForwarding/"+url.PathEscape(e.ID), nil)
		if err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed Omada port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in Nigafiy",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present in Omada"}, nil
}

func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanName(rawName)
	if err != nil {
		return router.Change{}, err
	}
	_, err = d.call(ctx, "rename", http.MethodPatch, d.sitePrefix()+"/clients/"+omadaMAC(mac), map[string]any{"name": name})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("renamed Omada client %s to %q", mac, name),
		Undo:      "Rename the client again in Nigafiy or Omada Controller",
	}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if err := d.ensureReady(ctx); err != nil {
		return router.Change{}, err
	}
	gw := d.findGateway(ctx)
	if gw == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "reboot", "no Omada gateway found in site")
	}
	gwMAC, err := router.NormalizeMAC(str(gw["mac"]))
	if err != nil {
		return router.Change{}, router.Errorf(router.ErrProtocol, "reboot", "Omada gateway MAC missing")
	}
	_, err = d.call(ctx, "reboot", http.MethodPost, d.sitePrefix()+"/cmd/devices/"+omadaMAC(gwMAC)+"/reboot", map[string]any{})
	if err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    fmt.Sprintf("sent reboot command to Omada gateway %s", omadaMAC(gwMAC)),
	}, nil
}
