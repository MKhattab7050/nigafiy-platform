package huaweilte

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechOverview    = "Huawei HiLink WAN & DHCP status (/api/monitoring/status, /api/dhcp/settings)"
	mechWiFi        = "Huawei HiLink WLAN SSID toggle (/api/wlan/multi-basic-settings)"
	mechPortForward = "Huawei HiLink virtual servers (/api/security/virtual-servers)"
	mechReboot      = "Huawei HiLink device reboot (/api/device/control)"
)

var (
	_ router.SettingsReader = (*Driver)(nil)
	_ router.WiFiController = (*Driver)(nil)
	_ router.PortForwarder  = (*Driver)(nil)
	_ router.Rebooter       = (*Driver)(nil)
)

func (d *Driver) postXML(ctx context.Context, op, path string, body []byte) error {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return err
		}
	}
	if err := d.refreshSesTok(ctx, op); err != nil {
		return err
	}
	st, raw, err := d.rawDo(ctx, op, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	if code, isErr := parseHiLinkError(raw); isErr || st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "HiLink %s failed (HTTP %d, code %d)", path, st, code)
	}
	return nil
}

func (d *Driver) readOverview(ctx context.Context) (*router.Overview, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}
	if raw, err := d.getXML(ctx, "settings", "/api/dhcp/settings"); err == nil {
		var s struct {
			DhcpIPAddress string `xml:"DhcpIPAddress"`
		}
		if xml.Unmarshal(raw, &s) == nil && s.DhcpIPAddress != "" {
			ov.LANIP = strings.TrimSpace(s.DhcpIPAddress)
		}
	}
	if raw, err := d.getXML(ctx, "settings", "/api/monitoring/status"); err == nil {
		var m struct {
			ConnectionStatus string `xml:"ConnectionStatus"`
			WanIPAddress     string `xml:"WanIPAddress"`
			PrimaryDns       string `xml:"PrimaryDns"`
			SecondaryDns     string `xml:"SecondaryDns"`
		}
		if xml.Unmarshal(raw, &m) == nil {
			st := "down"
			if m.ConnectionStatus == "901" {
				st = "up"
			} else if m.ConnectionStatus == "900" {
				st = "connecting"
			}
			var dns []string
			for _, x := range []string{m.PrimaryDns, m.SecondaryDns} {
				if a, err := netip.ParseAddr(strings.TrimSpace(x)); err == nil && a.Is4() {
					dns = append(dns, a.String())
				}
			}
			ov.WAN = []router.WANLink{{Name: "Cellular WAN", Status: st, Type: "4G/5G", IPv4: strings.TrimSpace(m.WanIPAddress), DNS: dns}}
		}
	}
	return ov, nil
}

func (d *Driver) readWiFi(ctx context.Context) ([]router.WiFiNetwork, error) {
	raw, err := d.getXML(ctx, "settings", "/api/wlan/multi-basic-settings")
	if err != nil {
		return nil, nil
	}
	var doc struct {
		Ssids []struct {
			Index        string `xml:"Index"`
			WifiEnable   string `xml:"WifiEnable"`
			WifiSsid     string `xml:"WifiSsid"`
			WifiHide     string `xml:"WifiHide"`
			WifiAuthmode string `xml:"WifiAuthmode"`
			ID           string `xml:"ID"`
		} `xml:"Ssids>Ssid"`
	}
	if xml.Unmarshal(raw, &doc) != nil {
		return nil, nil
	}
	out := make([]router.WiFiNetwork, 0, len(doc.Ssids))
	for i, s := range doc.Ssids {
		if strings.TrimSpace(s.WifiSsid) == "" {
			continue
		}
		idx := s.Index
		if idx == "" {
			idx = strconv.Itoa(i)
		}
		guest := strings.Contains(strings.ToLower(s.WifiSsid), "guest") || i >= 2
		band := "2.4GHz"
		if strings.Contains(strings.ToLower(s.ID), "5g") || i == 1 || i == 3 {
			band = "5GHz"
		}
		out = append(out, router.WiFiNetwork{
			ID:       idx,
			Band:     band,
			SSID:     s.WifiSsid,
			Enabled:  s.WifiEnable == "1",
			Main:     !guest,
			Guest:    guest,
			Hidden:   s.WifiHide == "1",
			Security: s.WifiAuthmode,
		})
	}
	return out, nil
}

type hiLinkVS struct {
	Status   string `xml:"VirtualServerStatus"`
	Name     string `xml:"VirtualServerName"`
	Proto    string `xml:"VirtualServerProtocol"`
	WanPort  string `xml:"VirtualServerWanPort"`
	IP       string `xml:"VirtualServerIPAddress"`
	LanPort  string `xml:"VirtualServerLanPort"`
}

func (d *Driver) readVirtualServers(ctx context.Context, op string) ([]hiLinkVS, error) {
	raw, err := d.getXML(ctx, op, "/api/security/virtual-servers")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Servers []hiLinkVS `xml:"Servers>Server"`
	}
	_ = xml.Unmarshal(raw, &doc)
	return doc.Servers, nil
}

func renderVirtualServers(list []hiLinkVS) []byte {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><request><Servers>`)
	for _, s := range list {
		fmt.Fprintf(&b, `<Server><VirtualServerStatus>%s</VirtualServerStatus><VirtualServerName>%s</VirtualServerName><VirtualServerProtocol>%s</VirtualServerProtocol><VirtualServerWanPort>%s</VirtualServerWanPort><VirtualServerIPAddress>%s</VirtualServerIPAddress><VirtualServerLanPort>%s</VirtualServerLanPort></Server>`,
			xmlEscape(s.Status), xmlEscape(s.Name), xmlEscape(s.Proto), xmlEscape(s.WanPort), xmlEscape(s.IP), xmlEscape(s.LanPort))
	}
	b.WriteString(`</Servers></request>`)
	return b.Bytes()
}

func hiLinkProtoFrom(p string) string {
	switch strings.ToUpper(strings.TrimSpace(p)) {
	case "6", "TCP":
		return router.ProtoTCP
	case "17", "UDP":
		return router.ProtoUDP
	case "0", "BOTH", "ALL", "TCP/UDP":
		return router.ProtoBoth
	}
	return ""
}

func hiLinkProtoTo(p string) string {
	switch p {
	case router.ProtoTCP:
		return "6"
	case router.ProtoUDP:
		return "17"
	default:
		return "0"
	}
}

func (d *Driver) readPortForwards(ctx context.Context) ([]router.PortForward, error) {
	rows, err := d.readVirtualServers(ctx, "settings")
	if err != nil {
		return nil, nil
	}
	out := make([]router.PortForward, 0, len(rows))
	for i, r := range rows {
		proto := hiLinkProtoFrom(r.Proto)
		ep, err1 := strconv.Atoi(strings.TrimSpace(r.WanPort))
		lp, err2 := strconv.Atoi(strings.TrimSpace(r.LanPort))
		if proto == "" || err1 != nil || ep < 1 || r.IP == "" {
			continue
		}
		if err2 != nil || lp < 1 {
			lp = ep
		}
		owner := router.OwnerAdmin
		if strings.HasPrefix(r.Name, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{
			ID:            strconv.Itoa(i + 1),
			Enabled:       r.Status != "0",
			Description:   r.Name,
			Protocol:      proto,
			ExternalStart: ep,
			ExternalEnd:   ep,
			InternalStart: lp,
			InternalEnd:   lp,
			InternalIP:    strings.TrimSpace(r.IP),
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
	pf, _ := d.readPortForwards(ctx)
	return router.Settings{
		Overview:     ov,
		WiFi:         wifi,
		PortForwards: pf,
	}, nil
}

func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	en := "0"
	if enabled {
		en = "1"
	}
	body := []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><request><Ssids><Ssid><Index>%s</Index><WifiEnable>%s</WifiEnable></Ssid></Ssids></request>`,
		xmlEscape(id), en))
	if err := d.postXML(ctx, "wifi", "/api/wlan/multi-basic-settings", body); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("set Huawei HiLink SSID %s WifiEnable=%s", id, en),
		Undo:      "Toggle the Wi-Fi network back in LAN Detective or the Huawei CPE web UI",
	}, nil
}

func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	clean, err := router.ValidatePortForward(rule, existing, netip.Prefix{}, d.target.Address)
	if err != nil {
		return router.Change{}, err
	}
	if clean.ExternalStart != clean.ExternalEnd {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "add_port_forward", "Huawei HiLink virtual servers forward one port per rule")
	}
	rows, err := d.readVirtualServers(ctx, "add_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	rows = append(rows, hiLinkVS{
		Status:  "1",
		Name:    clean.Description,
		Proto:   hiLinkProtoTo(clean.Protocol),
		WanPort: strconv.Itoa(clean.ExternalStart),
		IP:      clean.InternalIP,
		LanPort: strconv.Itoa(clean.InternalStart),
	})
	if err := d.postXML(ctx, "add_port_forward", "/api/security/virtual-servers", renderVirtualServers(rows)); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "add_port_forward",
		Mechanism: mechPortForward,
		Applied:   true,
		Detail:    fmt.Sprintf("added Huawei HiLink virtual server %s %d → %s:%d", clean.Protocol, clean.ExternalStart, clean.InternalIP, clean.InternalStart),
		Undo:      "Remove the rule in LAN Detective or under Security → Virtual Server on the Huawei CPE",
	}, nil
}

func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	existing, _ := d.readPortForwards(ctx)
	rows, err := d.readVirtualServers(ctx, "remove_port_forward")
	if err != nil {
		return router.Change{}, err
	}
	for i, e := range existing {
		if e.ID != rule.ID {
			continue
		}
		if !router.SameRule(e, rule) {
			return router.Change{}, router.Errorf(router.ErrRejected, "remove_port_forward", "Huawei HiLink virtual server %s changed since it was last read", rule.ID)
		}
		if i < len(rows) {
			rows = append(rows[:i], rows[i+1:]...)
		}
		if err := d.postXML(ctx, "remove_port_forward", "/api/security/virtual-servers", renderVirtualServers(rows)); err != nil {
			return router.Change{}, err
		}
		return router.Change{
			Action:    "remove_port_forward",
			Mechanism: mechPortForward,
			Applied:   true,
			Detail:    fmt.Sprintf("removed Huawei HiLink virtual server %s (%s)", e.ID, e.Description),
			Undo:      "Add the port forward again in LAN Detective",
		}, nil
	}
	return router.Change{Action: "remove_port_forward", Mechanism: mechPortForward, Applied: false, AlreadyInEffect: true, Detail: "virtual server rule is no longer present on Huawei CPE"}, nil
}

func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	body := []byte(`<?xml version="1.0" encoding="UTF-8"?><request><Control>1</Control></request>`)
	if err := d.postXML(ctx, "reboot", "/api/device/control", body); err != nil {
		return router.Change{}, err
	}
	return router.Change{
		Action:    "reboot",
		Mechanism: mechReboot,
		Applied:   true,
		Detail:    "Huawei HiLink CPE accepted reboot command",
	}, nil
}
