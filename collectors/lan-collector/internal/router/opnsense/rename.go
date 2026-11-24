package opnsense

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Rename on OPNsense is stored on the device's Kea DHCPv4 reservation: OPNsense keeps no client alias
// table, and the reservation's `hostname` is the name Kea hands out and shows in the lease list. So a
// rename needs a reservation first (capability Requires = "reservation") and a valid host name.
//
// Source: OPNsense core, model OPNsense/Kea/KeaDhcpv4.xml (reservations.reservation: subnet,
// ip_address, hw_address, hostname (HostnameField), description) and the controller
// OPNsense/Kea/Api/Dhcpv4Controller (searchReservation, setReservation/{uuid}); the endpoints are the
// ones this driver already uses for reservations (OPNsense 24.1+ with Kea, docs.opnsense.org
// development/api/core/kea.html). setReservation changes only the fields it is given.
const mechRename = "OPNsense Kea DHCPv4 reservation host name (/api/kea/dhcpv4/setReservation)"

var _ router.Renamer = (*Driver)(nil)

type keaRow struct {
	UUID     string
	MAC      string
	IP       string
	Hostname string
}

func (d *Driver) keaReservation(ctx context.Context, mac string) (*keaRow, error) {
	st, raw, err := d.do(ctx, "rename", http.MethodPost, "/api/kea/dhcpv4/searchReservation", map[string]any{"current": 1, "rowCount": -1, "searchPhrase": ""})
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, "rename", "OPNsense Kea searchReservation returned HTTP %d", st)
	}
	var env struct {
		Rows []map[string]any `json:"rows"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return nil, router.Errorf(router.ErrProtocol, "rename", "unreadable OPNsense Kea reservation list")
	}
	for _, r := range env.Rows {
		m, err := router.NormalizeMAC(first(str(r["hw_address"]), str(r["mac"])))
		if err != nil || m != mac || str(r["uuid"]) == "" {
			continue
		}
		return &keaRow{UUID: str(r["uuid"]), MAC: m, IP: first(str(r["ip_address"]), str(r["ip"])), Hostname: strings.TrimSpace(str(r["hostname"]))}, nil
	}
	return nil, nil
}

// RenameClient sets the host name of the device's Kea reservation, reconfigures Kea and re-reads it.
func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanHostname(rawName)
	if err != nil {
		return router.Change{}, err
	}
	res, err := d.keaReservation(ctx, mac)
	if err != nil {
		return router.Change{}, err
	}
	if res == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rename",
			"OPNsense stores a device name on its Kea DHCP reservation and %s has none; reserve an address for it first", mac)
	}
	if res.Hostname == name {
		return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("the Kea reservation of %s is already named %q", mac, name)}, nil
	}
	st, raw, err := d.do(ctx, "rename", http.MethodPost, "/api/kea/dhcpv4/setReservation/"+url.PathEscape(res.UUID), map[string]any{
		"reservation": map[string]any{"hostname": name},
	})
	if err != nil {
		return router.Change{}, err
	}
	var out struct {
		Result string `json:"result"`
	}
	_ = json.Unmarshal(raw, &out)
	if st != http.StatusOK || !strings.EqualFold(out.Result, "saved") {
		return router.Change{}, router.Errorf(router.ErrRejected, "rename", "OPNsense Kea setReservation answered HTTP %d, result %q", st, out.Result)
	}
	_, _, _ = d.do(ctx, "rename", http.MethodPost, "/api/kea/service/reconfigure", map[string]any{})
	after, err := d.keaReservation(ctx, mac)
	if err != nil {
		return router.Change{}, err
	}
	if after == nil || after.Hostname != name {
		return router.Change{}, router.Errorf(router.ErrProtocol, "rename", "OPNsense saved the change but the Kea reservation of %s does not show the new name", mac)
	}
	undo := "Rename it back in Nigafiy, or edit the reservation under Services → Kea DHCP → Kea DHCPv4 → Reservations in OPNsense"
	if res.Hostname != "" {
		undo = fmt.Sprintf("Rename it back to %q in Nigafiy, or edit the reservation under Services → Kea DHCP → Kea DHCPv4 → Reservations in OPNsense", res.Hostname)
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("set the host name of the OPNsense Kea reservation of %s (%s) to %q", mac, res.IP, name),
		Undo:      undo,
	}, nil
}
