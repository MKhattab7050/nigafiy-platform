package huawei

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "Huawei gateway deviceinfo, LAN and WAN API (/api/system/deviceinfo, /api/ntwk/wan)"
	mechWiFi        = "Huawei gateway WLAN toggle (/api/ntwk/WlanBasic)"
	mechReservation = "Huawei gateway static DHCP (/api/ntwk/lan_dhcp_static)"
	mechPortForward = "Huawei gateway port mapping (/api/ntwk/portmapping)"
	mechRename      = "Huawei gateway HostInfo name (/api/system/HostInfo)"
	mechReboot      = "Huawei gateway reboot (/api/service/reboot.cgi)"
)

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if raw, err := d.getJSON(ctx, "settings", "/api/system/deviceinfo"); err == nil {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if sec, err := strconv.ParseInt(strings.TrimSpace(str(m["UpTime"])), 10, 64); err == nil && sec > 0 {
				ov.UptimeSeconds = &sec
			}
		}
	}
	if raw, err := d.getJSON(ctx, "settings", "/api/ntwk/lan_host"); err == nil {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if ip := strings.TrimSpace(str(m["IPAddress"])); ip != "" {
				ov.LANIP = ip
			}
		}
	}
	if raw, err := d.getJSON(ctx, "settings", "/api/ntwk/wan"); err == nil {
		var wans []map[string]any
		if json.Unmarshal(raw, &wans) != nil {
			var one map[string]any
			if json.Unmarshal(raw, &one) == nil && len(one) > 0 {
				wans = []map[string]any{one}
			}
		}
		for _, w := range wans {
			st := "down"
			cs := strings.ToLower(first(str(w["ConnectionStatus"]), str(w["Status"])))
			if cs == "connected" || cs == "up" {
				st = "up"
			} else if strings.Contains(cs, "connect") {
				st = "connecting"
			}
			var dns []string
			for _, tok := range strings.Split(str(w["DNSServers"]), ",") {
				tok = strings.TrimSpace(tok)
				if a, err := netip.ParseAddr(tok); err == nil && a.Is4() {
					dns = append(dns, a.String())
				}
			}
			ov.WAN = append(ov.WAN, router.WANLink{
				Name:   first(str(w["Name"]), str(w["ServiceList"]), "WAN"),
				Status: st,
				Type:   first(str(w["AccessType"]), str(w["ConnectionType"])),
				IPv4:   first(str(w["ExternalIPAddress"]), str(w["IPv4Address"])),
				DNS:    dns,
			})
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	raw, err := d.getJSON(ctx, "settings", "/api/ntwk/WlanBasic")
	if err != nil {
		return nil, nil
	}
	var ssids []map[string]any
	if json.Unmarshal(raw, &ssids) != nil {
		var one map[string]any
		if json.Unmarshal(raw, &one) == nil && len(one) > 0 {
			ssids = []map[string]any{one}
		}
	}
	out := make([]router.WiFiNetwork, 0, len(ssids))
	for i, w := range ssids {
		ssid := str(w["SSID"])
		if ssid == "" {
			continue
		}
		id := first(str(w["ID"]), strconv.Itoa(i+1))
		guest := boolOf(w["IsGuest"]) || strings.Contains(strings.ToLower(ssid), "guest")
		band := first(str(w["FrequencyBand"]), str(w["X_Band"]))
		switch {
		case strings.Contains(strings.ToLower(band), "5"):
			band = "5GHz"
		case strings.Contains(strings.ToLower(band), "2"):
			band = "2.4GHz"
		}
		hidden := false
		if v, ok := w["SSIDAdvertisementEnabled"]; ok {
			hidden = !boolOf(v)
		}
		out = append(out, router.WiFiNetwork{
			ID:       id,
			Band:     band,
			SSID:     ssid,
			Enabled:  boolOf(w["Enable"]),
			Main:     !guest,
			Guest:    guest,
			Hidden:   hidden,
			Security: first(str(w["BeaconType"]), str(w["SecurityMode"])),
		})
	}
	return out, nil
}

type hwStaticDHCP struct {
	ID         string `json:"ID,omitempty"`
	MACAddress string `json:"MACAddress"`
	IPAddress  string `json:"IPAddress"`
	Enable     bool   `json:"Enable"`
}

func (d *Driver) readStaticDHCP(ctx context.Context, op string) ([]hwStaticDHCP, error) {
	raw, err := d.getJSON(ctx, op, "/api/ntwk/lan_dhcp_static")
	if err != nil {
		return nil, err
	}
	var rows []hwStaticDHCP
	_ = json.Unmarshal(raw, &rows)
	return rows, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	rows, err := d.readStaticDHCP(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.Reservation, 0, len(rows))
	for i, r := range rows {
		mac, err := router.NormalizeMAC(r.MACAddress)
		if err != nil || r.IPAddress == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      first(r.ID, strconv.Itoa(i+1)),
			MAC:     mac,
			IP:      r.IPAddress,
			Enabled: r.Enable,
		})
	}
	return out, nil
}

type hwPortMap struct {
	ID                   string `json:"ID,omitempty"`
	Enable               bool   `json:"Enable"`
	Description          string `json:"Description"`
	Protocol             string `json:"Protocol"`
	ExternalPort         int    `json:"ExternalPort"`
	ExternalPortEndRange int    `json:"ExternalPortEndRange"`
	InternalPort         int    `json:"InternalPort"`
	InternalClient       string `json:"InternalClient"`
}

func (d *Driver) readPortMaps(ctx context.Context, op string) ([]hwPortMap, error) {
	raw, err := d.getJSON(ctx, op, "/api/ntwk/portmapping")
	if err != nil {
		return nil, err
	}
	var rows []hwPortMap
	_ = json.Unmarshal(raw, &rows)
	return rows, nil
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	rows, err := d.readPortMaps(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto, ok := router.NormalizeProtocol(r.Protocol)
		if !ok || r.ExternalPort < 1 || r.InternalClient == "" {
			continue
		}
		ee := r.ExternalPortEndRange
		if ee < r.ExternalPort {
			ee = r.ExternalPort
		}
		is := r.InternalPort
		if is < 1 {
			is = r.ExternalPort
		}
		ie := is + (ee - r.ExternalPort)
		owner := router.OwnerAdmin
		if strings.HasPrefix(r.Description, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            first(r.ID, strconv.Itoa(i+1)),
			Enabled:       r.Enable,
			Description:   r.Description,
			Protocol:      proto,
			ExternalStart: r.ExternalPort,
			ExternalEnd:   ee,
			InternalStart: is,
			InternalEnd:   ie,
			InternalIP:    r.InternalClient,
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
	if _, err := d.postJSON(ctx, "wifi", "/api/ntwk/WlanBasic", map[string]any{
		"ID":     id,
		"Enable": enabled,
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set Huawei WLAN %s Enable=%v", id, enabled),
		Undo:      "Toggle the Wi-Fi network back in LAN Detective or the Huawei gateway web UI",
	}, nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, _ := d.readReservations(ctx)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readStaticDHCP(ctx, "reserve")
	if err != nil {
		return router.Change{}, err
	}
	replaced := false
	for i := range rows {
		if m, err := router.NormalizeMAC(rows[i].MACAddress); err == nil && m == mac {
			if rows[i].IPAddress == ip.String() && rows[i].Enable {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			rows[i].IPAddress = ip.String()
			rows[i].Enable = true
			replaced = true
			break
		}
	}
	if !replaced {
		rows = append(rows, hwStaticDHCP{MACAddress: strings.ToUpper(mac), IPAddress: ip.String(), Enable: true})
	}
	if _, err := d.postJSON(ctx, "reserve", "/api/ntwk/lan_dhcp_static", rows); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on Huawei gateway", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or under Home Network → LAN Interface → Static IP",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readStaticDHCP(ctx, "unreserve")
	if err != nil {
		return router.Change{}, err
	}
	var kept []hwStaticDHCP
	var removedIP string
	for _, r := range rows {
		if m, err := router.NormalizeMAC(r.MACAddress); err == nil && m == mac {
			removedIP = r.IPAddress
			continue
		}
		kept = append(kept, r)
	}
	if removedIP == "" {
		return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no Huawei static DHCP entry found for this MAC"}, nil
	}
	if kept == nil {
		kept = []hwStaticDHCP{}
	}
	if _, err := d.postJSON(ctx, "unreserve", "/api/ntwk/lan_dhcp_static", kept); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unreserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("removed Huawei static DHCP reservation %s for %s", removedIP, mac),
		Undo:      "Add the reservation again in LAN Detective",
	}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readPortMaps(ctx, "add_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	proto := strings.ToUpper(clean.Protocol)
	if clean.Protocol == router.ProtoBoth {
		proto = "TCP/UDP"
	}
	rows = append(rows, hwPortMap{
		Enable:               true,
		Description:          clean.Description,
		Protocol:             proto,
		ExternalPort:         clean.ExternalStart,
		ExternalPortEndRange: clean.ExternalEnd,
		InternalPort:         clean.InternalStart,
		InternalClient:       clean.InternalIP,
	})
	if _, err := d.postJSON(ctx, "add_port_forward", "/api/ntwk/portmapping", rows); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added Huawei port mapping %s %d-%d → %s:%d", clean.Protocol, clean.ExternalStart, clean.ExternalEnd, clean.InternalIP, clean.InternalStart),
		Undo:      "Remove the rule in LAN Detective or under Internet → Forwarding → Port Mapping on the Huawei gateway",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	rows, err := d.readPortMaps(ctx, "remove_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "Huawei port-mapping rule %s changed since it was last read", rule.ID)
		}
		if i < len(rows) {
			rows = append(rows[:i], rows[i+1:]...)
		}
		if rows == nil {
			rows = []hwPortMap{}
		}
		if _, err := d.postJSON(ctx, "remove_port_forward", "/api/ntwk/portmapping", rows); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed Huawei port mapping %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-mapping rule is no longer present on Huawei gateway"}, nil
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
	if _, err := d.postJSON(ctx, "rename", "/api/system/HostInfo", map[string]any{
		"MACAddress": strings.ToUpper(mac),
		"HostName":   name,
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("renamed Huawei client %s to %q", mac, name),
		Undo:      "Rename the device again in LAN Detective or the Huawei gateway UI",
	}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if _, err := d.postJSON(ctx, "reboot", "/api/service/reboot.cgi", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "Huawei gateway accepted reboot request",
	}, nil
}
