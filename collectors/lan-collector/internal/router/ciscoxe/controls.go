package ciscoxe

import (
	"context"
	"encoding/json"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

const mechOverview = "Cisco IOS XE RESTCONF interface & hardware operational data (read-only)"

var _ router.SettingsReader = (*Driver)(nil)

func (d *Driver) Settings(ctx context.Context) (router.Settings, error) {
	ov := &router.Overview{LANIP: d.target.Address.String()}

	if st, raw, err := d.get(ctx, "settings", "/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware/device-system-data"); err == nil && st == http.StatusOK {
		var rep struct {
			Data struct {
				BootTime string `json:"boot-time"`
			} `json:"Cisco-IOS-XE-device-hardware-oper:device-system-data"`
		}
		if json.Unmarshal(raw, &rep) == nil && rep.Data.BootTime != "" {
			if bt, err := time.Parse(time.RFC3339, rep.Data.BootTime); err == nil {
				if sec := int64(time.Since(bt).Seconds()); sec > 0 {
					ov.UptimeSeconds = &sec
				}
			}
		}
	}

	if st, raw, err := d.get(ctx, "settings", "/restconf/data/Cisco-IOS-XE-interfaces-oper:interfaces/interface"); err == nil && st == http.StatusOK {
		var rep struct {
			Ifaces []struct {
				Name       string `json:"name"`
				OperStatus string `json:"oper-status"`
				IPv4       string `json:"ipv4"`
				Type       string `json:"type"`
			} `json:"Cisco-IOS-XE-interfaces-oper:interface"`
		}
		if json.Unmarshal(raw, &rep) == nil {
			for _, it := range rep.Ifaces {
				ip := strings.TrimSpace(it.IPv4)
				if ip == "" || ip == "0.0.0.0" {
					continue
				}
				a, err := netip.ParseAddr(ip)
				if err != nil || !a.Is4() {
					continue
				}
				if a == d.target.Address {
					ov.LANIP = a.String()
					continue
				}
				if !router.IsPrivate(a) || strings.Contains(strings.ToLower(it.Name), "wan") || strings.Contains(strings.ToLower(it.Name), "dialer") {
					status := "down"
					if strings.Contains(strings.ToLower(it.OperStatus), "up") {
						status = "up"
					}
					ov.WAN = append(ov.WAN, router.WANLink{
						Name:   it.Name,
						Status: status,
						Type:   it.Type,
						IPv4:   a.String(),
					})
				}
			}
		}
	}

	return router.Settings{Overview: ov}, nil
}
