package fortigate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Wi-Fi on FortiGate / FortiWiFi: each SSID is a wireless-controller VAP, and FortiOS creates a
// system interface of the same name for it. Taking that interface administratively down takes the
// SSID off the air (its clients disconnect); `up` brings it back.
//
// Sources:
//   - FortiOS CLI reference 6.0–7.4, `config wireless-controller vap` (name, ssid, broadcast-ssid,
//     security; the passphrase field is never read by this driver);
//   - Fortinet Community technical tip "How to enable and disable broadcast of SSID" (disabling an
//     SSID through `config system interface` → `edit <vap>` → `set status down`);
//   - monitor API /api/v2/monitor/wifi/client (connected Wi-Fi clients with `mac` and `vap_name`).
//
// Not covered: SSIDs pushed by FortiManager or tunnel-mode SSIDs on a remote FortiAP with no local
// interface — they have no system interface, so they are listed without being switchable.
const mechWiFi = "FortiOS SSID interface status (/api/v2/cmdb/wireless-controller/vap and /api/v2/cmdb/system/interface)"

// maxVAPs bounds one listing (the settings wire format holds at most 32 networks).
const maxVAPs = 32

var _ router.WiFiController = (*Driver)(nil)

type fgtVAP struct {
	Name          string `json:"name"`
	SSID          string `json:"ssid"`
	BroadcastSSID string `json:"broadcast-ssid"`
	Security      string `json:"security"`
}

// readVAPs lists the SSIDs. ok is false when the firewall has no wireless controller (HTTP 404 or
// an unreadable answer), so Wi-Fi is not offered.
func (d *Driver) readVAPs(ctx context.Context, op string) ([]fgtVAP, bool, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/v2/cmdb/wireless-controller/vap", nil)
	if err != nil {
		return nil, false, err
	}
	if st != http.StatusOK {
		return nil, false, nil
	}
	var rep struct {
		Results []fgtVAP `json:"results"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil, false, nil
	}
	out := make([]fgtVAP, 0, len(rep.Results))
	for _, v := range rep.Results {
		if v.Name == "" || len(v.Name) > 40 {
			continue
		}
		out = append(out, v)
		if len(out) >= maxVAPs {
			break
		}
	}
	return out, true, nil
}

// interfaceStatus returns "up" / "down" for the VAP's system interface; "" when it has none.
func (d *Driver) interfaceStatus(ctx context.Context, op, name string) (string, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/v2/cmdb/system/interface/"+url.PathEscape(name), nil)
	if err != nil {
		return "", err
	}
	if st != http.StatusOK {
		return "", nil
	}
	var rep struct {
		Results []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"results"`
	}
	if json.Unmarshal(raw, &rep) != nil || len(rep.Results) == 0 {
		return "", nil
	}
	return strings.ToLower(strings.TrimSpace(rep.Results[0].Status)), nil
}

func (d *Driver) wifiClients(ctx context.Context, op string) map[string][]string {
	out := map[string][]string{}
	st, raw, err := d.do(ctx, op, http.MethodGet, "/api/v2/monitor/wifi/client", nil)
	if err != nil || st != http.StatusOK {
		return out
	}
	var rep struct {
		Results []map[string]any `json:"results"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return out
	}
	for _, c := range rep.Results {
		mac, err := router.NormalizeMAC(str(c["mac"]))
		vap := str(c["vap_name"])
		if err != nil || vap == "" {
			continue
		}
		out[vap] = append(out[vap], mac)
	}
	for k := range out {
		sort.Strings(out[k])
	}
	return out
}

// readWiFi lists the SSIDs that have a system interface, with their state and clients.
func (d *Driver) readWiFi(ctx context.Context, op string) ([]router.WiFiNetwork, bool, error) {
	vaps, ok, err := d.readVAPs(ctx, op)
	if err != nil || !ok {
		return nil, ok, err
	}
	clients := d.wifiClients(ctx, op)
	out := make([]router.WiFiNetwork, 0, len(vaps))
	for _, v := range vaps {
		status, err := d.interfaceStatus(ctx, op, v.Name)
		if err != nil {
			return nil, true, err
		}
		if status != "up" && status != "down" {
			continue
		}
		out = append(out, router.WiFiNetwork{
			ID:       v.Name,
			SSID:     v.SSID,
			Enabled:  status == "up",
			Main:     true, // FortiOS has no main/guest distinction: every SSID is treated as a main network (off needs confirmation)
			Guest:    false,
			Hidden:   strings.EqualFold(v.BroadcastSSID, "disable"),
			Security: v.Security,
			// Only the clients of this SSID; never the passphrase.
			ClientMACs: clients[v.Name],
		})
	}
	return out, true, nil
}

// SetWiFiEnabled brings one SSID's interface up or down and re-reads it.
func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 40 || strings.ContainsAny(id, "/?#%\\ ") {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "not a FortiOS SSID name")
	}
	nets, ok, err := d.readWiFi(ctx, "wifi")
	if err != nil {
		return router.Change{}, err
	}
	if !ok {
		return router.Change{}, router.Errorf(router.ErrUnsupported, "wifi", "this FortiGate has no wireless controller SSIDs")
	}
	var cur *router.WiFiNetwork
	for i := range nets {
		if nets[i].ID == id {
			cur = &nets[i]
		}
	}
	if cur == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "wifi", "FortiGate has no switchable SSID %q", id)
	}
	word := map[bool]string{true: "on", false: "off"}
	if cur.Enabled == enabled {
		return router.Change{Action: "wifi", Mechanism: mechWiFi, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("SSID %q is already %s", cur.SSID, word[enabled])}, nil
	}
	status := map[bool]string{true: "up", false: "down"}[enabled]
	st, _, err := d.do(ctx, "wifi", http.MethodPut, "/api/v2/cmdb/system/interface/"+url.PathEscape(id), map[string]any{"status": status})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "wifi", "FortiOS interface update returned HTTP %d", st)
	}
	got, err := d.interfaceStatus(ctx, "wifi", id)
	if err != nil {
		return router.Change{}, err
	}
	if got != status {
		return router.Change{}, router.Errorf(router.ErrProtocol, "wifi", "FortiGate accepted the change but SSID %q still reads %q", cur.SSID, got)
	}
	return router.Change{
		Action:    "wifi",
		Mechanism: mechWiFi,
		Applied:   true,
		Detail:    fmt.Sprintf("turned SSID %q (%s) %s on FortiGate", cur.SSID, id, word[enabled]),
		Undo:      fmt.Sprintf("Turn it %s again in Nigafiy, or set the %s interface status under Network → Interfaces in FortiGate", word[!enabled], id),
	}, nil
}
