package dlink

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	mechOverview    = "D-Link HNAP1 LAN & WAN settings (GetRouterLanSettings, GetWanSettings, GetWanStatus)"
	mechWiFi        = "D-Link HNAP1 WLAN radio toggle (SetWLanRadioSettings)"
	mechReservation = "D-Link HNAP1 static DHCP list (SetStaticDHCPList)"
	mechPortForward = "D-Link HNAP1 port forwarding (SetPortForwardingSettings)"
	mechReboot      = "D-Link HNAP1 Reboot"
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
	if raw, err := d.call(ctx, "settings", "GetRouterLanSettings", fmt.Sprintf(`<GetRouterLanSettings xmlns="%s"/>`, hnapNS)); err == nil {
		var env struct {
			Res struct {
				IP string `xml:"RouterIPAddress"`
			} `xml:"Body>GetRouterLanSettingsResponse"`
		}
		if xml.Unmarshal(raw, &env) == nil && env.Res.IP != "" {
			ov.LANIP = strings.TrimSpace(env.Res.IP)
		}
	}
	status := "unknown"
	if raw, err := d.call(ctx, "settings", "GetWanStatus", fmt.Sprintf(`<GetWanStatus xmlns="%s"/>`, hnapNS)); err == nil {
		var env struct {
			Res struct {
				Status string `xml:"Status"`
			} `xml:"Body>GetWanStatusResponse"`
		}
		if xml.Unmarshal(raw, &env) == nil {
			switch strings.ToUpper(strings.TrimSpace(env.Res.Status)) {
			case "CONNECTED":
				status = "up"
			case "DISCONNECTED":
				status = "down"
			case "CONNECTING":
				status = "connecting"
			}
		}
	}
	if raw, err := d.call(ctx, "settings", "GetWanSettings", fmt.Sprintf(`<GetWanSettings xmlns="%s"/>`, hnapNS)); err == nil {
		var env struct {
			Res struct {
				Type       string `xml:"Type"`
				IP         string `xml:"IPAddress"`
				PrimaryDNS string `xml:"RuntimeDNS>Primary"`
				SecondDNS  string `xml:"RuntimeDNS>Secondary"`
			} `xml:"Body>GetWanSettingsResponse"`
		}
		if xml.Unmarshal(raw, &env) == nil && (env.Res.IP != "" || status != "unknown") {
			var dns []string
			for _, x := range []string{env.Res.PrimaryDNS, env.Res.SecondDNS} {
				if a, err := netip.ParseAddr(strings.TrimSpace(x)); err == nil && a.Is4() {
					dns = append(dns, a.String())
				}
			}
			ov.WAN = []router.WANLink{{Name: "WAN", Status: status, Type: env.Res.Type, IPv4: strings.TrimSpace(env.Res.IP), DNS: dns}}
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	radios := []struct {
		id, band string
		guest    bool
	}{
		{"RADIO_2.4GHz", "2.4GHz", false},
		{"RADIO_5GHz", "5GHz", false},
		{"RADIO_2.4GHz_Guest", "2.4GHz", true},
		{"RADIO_5GHz_Guest", "5GHz", true},
	}
	var out []router.WiFiNetwork
	for _, r := range radios {
		raw, err := d.call(ctx, "settings", "GetWLanRadioSettings", fmt.Sprintf(`<GetWLanRadioSettings xmlns="%s"><RadioID>%s</RadioID></GetWLanRadioSettings>`, hnapNS, r.id))
		if err != nil {
			continue
		}
		var env struct {
			Res struct {
				Result        string `xml:"GetWLanRadioSettingsResult"`
				Enabled       string `xml:"Enabled"`
				SSID          string `xml:"SSID"`
				SSIDBroadcast string `xml:"SSIDBroadcast"`
			} `xml:"Body>GetWLanRadioSettingsResponse"`
		}
		if xml.Unmarshal(raw, &env) != nil || strings.TrimSpace(env.Res.SSID) == "" || strings.EqualFold(env.Res.Result, "ERROR") {
			continue
		}
		out = append(out, router.WiFiNetwork{
			ID:      r.id,
			Band:    r.band,
			SSID:    strings.TrimSpace(env.Res.SSID),
			Enabled: strings.EqualFold(env.Res.Enabled, "true"),
			Main:    !r.guest,
			Guest:   r.guest,
			Hidden:  strings.EqualFold(env.Res.SSIDBroadcast, "false"),
		})
	}
	return out, nil
}

type dlinkStaticRow struct {
	DeviceName string `xml:"DeviceName"`
	IPAddress  string `xml:"IPAddress"`
	MacAddress string `xml:"MacAddress"`
	Enabled    string `xml:"Enabled"`
}

func (d *Driver) readStaticRows(ctx context.Context, op string) ([]dlinkStaticRow, error) {
	raw, err := d.call(ctx, op, "GetStaticDHCPList", fmt.Sprintf(`<GetStaticDHCPList xmlns="%s"/>`, hnapNS))
	if err != nil {
		return nil, err
	}
	var env struct {
		Rows []dlinkStaticRow `xml:"Body>GetStaticDHCPListResponse>StaticDHCPList>StaticDHCPInfo"`
	}
	_ = xml.Unmarshal(raw, &env)
	return env.Rows, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	rows, err := d.readStaticRows(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.Reservation, 0, len(rows))
	for i, r := range rows {
		mac, err := router.NormalizeMAC(r.MacAddress)
		if err != nil || strings.TrimSpace(r.IPAddress) == "" {
			continue
		}
		out = append(out, router.Reservation{
			ID:      strconv.Itoa(i + 1),
			MAC:     mac,
			IP:      strings.TrimSpace(r.IPAddress),
			Enabled: !strings.EqualFold(r.Enabled, "false"),
		})
	}
	return out, nil
}

type dlinkPFRow struct {
	Enabled      string `xml:"Enabled"`
	Description  string `xml:"PortForwardingDescription"`
	InternalIP   string `xml:"InternalIPAddress"`
	ProtocolType string `xml:"ProtocolType"`
	TCPPorts     string `xml:"TCPPorts"`
	UDPPorts     string `xml:"UDPPorts"`
	ExternalPort string `xml:"ExternalPort"`
	InternalPort string `xml:"InternalPort"`
}

func (d *Driver) readPFRows(ctx context.Context, op string) ([]dlinkPFRow, error) {
	raw, err := d.call(ctx, op, "GetPortForwardingSettings", fmt.Sprintf(`<GetPortForwardingSettings xmlns="%s"/>`, hnapNS))
	if err != nil {
		return nil, err
	}
	var env struct {
		Rows []dlinkPFRow `xml:"Body>GetPortForwardingSettingsResponse>PortForwardingList>PortForwardingInfo"`
	}
	_ = xml.Unmarshal(raw, &env)
	return env.Rows, nil
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
	rows, err := d.readPFRows(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto, ok := router.NormalizeProtocol(r.ProtocolType)
		if !ok {
			if r.TCPPorts != "" && r.UDPPorts != "" {
				proto = router.ProtoBoth
			} else if r.TCPPorts != "" {
				proto = router.ProtoTCP
			} else if r.UDPPorts != "" {
				proto = router.ProtoUDP
			} else {
				continue
			}
		}
		es, ee, ok := parsePortRange(first(r.ExternalPort, r.TCPPorts, r.UDPPorts))
		if !ok || strings.TrimSpace(r.InternalIP) == "" {
			continue
		}
		is, ie, ok := parsePortRange(r.InternalPort)
		if !ok {
			is, ie = es, ee
		}
		owner := router.OwnerAdmin
		if strings.HasPrefix(r.Description, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            strconv.Itoa(i + 1),
			Enabled:       !strings.EqualFold(r.Enabled, "false"),
			Description:   r.Description,
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
	case "RADIO_2.4GHz", "RADIO_5GHz", "RADIO_2.4GHz_Guest", "RADIO_5GHz_Guest":
	default:
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown D-Link RadioID %q", id)
	}
	// Read current SSID so SetWLanRadioSettings preserves it without touching security keys.
	var ssid string
	if raw, err := d.call(ctx, "wifi", "GetWLanRadioSettings", fmt.Sprintf(`<GetWLanRadioSettings xmlns="%s"><RadioID>%s</RadioID></GetWLanRadioSettings>`, hnapNS, id)); err == nil {
		var env struct {
			Res struct{ SSID string `xml:"SSID"` } `xml:"Body>GetWLanRadioSettingsResponse"`
		}
		if xml.Unmarshal(raw, &env) == nil {
			ssid = env.Res.SSID
		}
	}
	body := fmt.Sprintf(`<SetWLanRadioSettings xmlns="%s"><RadioID>%s</RadioID><Enabled>%v</Enabled><SSID>%s</SSID></SetWLanRadioSettings>`,
		hnapNS, xmlEscape(id), enabled, xmlEscape(ssid))
	raw, err := d.call(ctx, "wifi", "SetWLanRadioSettings", body)
	if err != nil {
		return router.Change{}, err
	}
	var env struct {
		Res struct{ Result string `xml:"SetWLanRadioSettingsResult"` } `xml:"Body>SetWLanRadioSettingsResponse"`
	}
	if xml.Unmarshal(raw, &env) == nil && env.Res.Result != "" && !strings.EqualFold(env.Res.Result, "OK") && !strings.EqualFold(env.Res.Result, "REBOOT") {
		return router.Change{}, router.Errorf(router.ErrRejected, "wifi", "SetWLanRadioSettings returned %s", env.Res.Result)
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set D-Link %s Enabled=%v", id, enabled),
		Undo:      "Toggle the Wi-Fi radio back in LAN Detective or D-Link Wireless settings",
	}, nil
}

func (d *Driver) writeStaticRows(ctx context.Context, op string, rows []dlinkStaticRow) error {
	var b strings.Builder
	fmt.Fprintf(&b, `<SetStaticDHCPList xmlns="%s"><StaticDHCPList>`, hnapNS)
	for _, r := range rows {
		fmt.Fprintf(&b, `<StaticDHCPInfo><Enabled>%s</Enabled><DeviceName>%s</DeviceName><IPAddress>%s</IPAddress><MacAddress>%s</MacAddress></StaticDHCPInfo>`,
			xmlEscape(first(r.Enabled, "true")), xmlEscape(r.DeviceName), xmlEscape(r.IPAddress), xmlEscape(strings.ToUpper(r.MacAddress)))
	}
	b.WriteString(`</StaticDHCPList></SetStaticDHCPList>`)
	raw, err := d.call(ctx, op, "SetStaticDHCPList", b.String())
	if err != nil {
		return err
	}
	var env struct {
		Res struct{ Result string `xml:"SetStaticDHCPListResult"` } `xml:"Body>SetStaticDHCPListResponse"`
	}
	if xml.Unmarshal(raw, &env) == nil && env.Res.Result != "" && !strings.EqualFold(env.Res.Result, "OK") && !strings.EqualFold(env.Res.Result, "REBOOT") {
		return router.Errorf(router.ErrRejected, op, "SetStaticDHCPList returned %s", env.Res.Result)
	}
	return nil
}

func (d *Driver) AddReservation(ctx context.Context, rawMAC, rawIP string) (router.Change, error) {
	existing, _ := d.readReservations(ctx)
	mac, ip, err := router.ValidateReservation(rawMAC, rawIP, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readStaticRows(ctx, "reserve")
	if err != nil {
		return router.Change{}, err
	}
	replaced := false
	for i := range rows {
		if m, err := router.NormalizeMAC(rows[i].MacAddress); err == nil && m == mac {
			if strings.TrimSpace(rows[i].IPAddress) == ip.String() {
				return router.Change{Action: "reserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already reserved for %s", ip, mac)}, nil
			}
			rows[i].IPAddress = ip.String()
			rows[i].Enabled = "true"
			replaced = true
			break
		}
	}
	if !replaced {
		rows = append(rows, dlinkStaticRow{Enabled: "true", DeviceName: ldTagPrefix + mac, IPAddress: ip.String(), MacAddress: strings.ToUpper(mac)})
	}
	if err := d.writeStaticRows(ctx, "reserve", rows); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("reserved %s for %s on D-Link DHCP server", ip, mac),
		Undo:      "Remove the reservation in LAN Detective or under Settings → Network → DHCP Reservations on D-Link",
	}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readStaticRows(ctx, "unreserve")
	if err != nil {
		return router.Change{}, err
	}
	var kept []dlinkStaticRow
	var removedIP string
	for _, r := range rows {
		if m, err := router.NormalizeMAC(r.MacAddress); err == nil && m == mac {
			removedIP = r.IPAddress
			continue
		}
		kept = append(kept, r)
	}
	if removedIP == "" {
		return router.Change{Action: "unreserve", MAC: mac, Mechanism: mechReservation, Applied: false, AlreadyInEffect: true, Detail: "no D-Link DHCP reservation found for this MAC"}, nil
	}
	if err := d.writeStaticRows(ctx, "unreserve", kept); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "unreserve",
		MAC:       mac,
		Mechanism: mechReservation,
		Applied:   true,
		Detail:    fmt.Sprintf("removed D-Link DHCP reservation %s for %s", removedIP, mac),
		Undo:      "Add the reservation again in LAN Detective",
	}, nil
}

func (d *Driver) writePFRows(ctx context.Context, op string, rows []dlinkPFRow) error {
	var b strings.Builder
	fmt.Fprintf(&b, `<SetPortForwardingSettings xmlns="%s"><PortForwardingList>`, hnapNS)
	for _, r := range rows {
		fmt.Fprintf(&b, `<PortForwardingInfo><Enabled>%s</Enabled><PortForwardingDescription>%s</PortForwardingDescription><InternalIPAddress>%s</InternalIPAddress><ProtocolType>%s</ProtocolType><ExternalPort>%s</ExternalPort><InternalPort>%s</InternalPort></PortForwardingInfo>`,
			xmlEscape(first(r.Enabled, "true")), xmlEscape(r.Description), xmlEscape(r.InternalIP), xmlEscape(r.ProtocolType), xmlEscape(r.ExternalPort), xmlEscape(r.InternalPort))
	}
	b.WriteString(`</PortForwardingList></SetPortForwardingSettings>`)
	raw, err := d.call(ctx, op, "SetPortForwardingSettings", b.String())
	if err != nil {
		return err
	}
	var env struct {
		Res struct{ Result string `xml:"SetPortForwardingSettingsResult"` } `xml:"Body>SetPortForwardingSettingsResponse"`
	}
	if xml.Unmarshal(raw, &env) == nil && env.Res.Result != "" && !strings.EqualFold(env.Res.Result, "OK") && !strings.EqualFold(env.Res.Result, "REBOOT") {
		return router.Errorf(router.ErrRejected, op, "SetPortForwardingSettings returned %s", env.Res.Result)
	}
	return nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readPFRows(ctx, "add_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	proto := strings.ToUpper(clean.Protocol)
	if clean.Protocol == router.ProtoBoth {
		proto = "Both"
	}
	rows = append(rows, dlinkPFRow{
		Enabled:      "true",
		Description:  clean.Description,
		InternalIP:   clean.InternalIP,
		ProtocolType: proto,
		ExternalPort: formatPortRange(clean.ExternalStart, clean.ExternalEnd),
		InternalPort: formatPortRange(clean.InternalStart, clean.InternalEnd),
	})
	if err := d.writePFRows(ctx, "add_port_forward", rows); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added D-Link port forward %s %s → %s:%s", clean.Protocol, formatPortRange(clean.ExternalStart, clean.ExternalEnd), clean.InternalIP, formatPortRange(clean.InternalStart, clean.InternalEnd)),
		Undo:      "Remove the rule in LAN Detective or under Features → Port Forwarding on D-Link",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	rows, err := d.readPFRows(ctx, "remove_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "D-Link port-forward rule %s changed since it was last read", rule.ID)
		}
		if i < len(rows) {
			rows = append(rows[:i], rows[i+1:]...)
		}
		if err := d.writePFRows(ctx, "remove_port_forward", rows); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed D-Link port-forward rule %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "port-forward rule is no longer present on D-Link"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	if _, err := d.call(ctx, "reboot", "Reboot", fmt.Sprintf(`<Reboot xmlns="%s"/>`, hnapNS)); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "D-Link router accepted HNAP1 Reboot request",
	}, nil
}
