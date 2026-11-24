package fortigate

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Rename on FortiGate is stored as the `description` of the device's DHCP reserved address: the
// monitor API's device inventory (/api/v2/monitor/user/device/query) is read-only, and FortiOS 7.0
// removed the `config user device` alias table. The reserved-address description is what the GUI
// shows next to the reservation (Network → Interfaces → DHCP Server → IP Address Assignment Rules).
// So a rename needs a reservation first (capability Requires = "reservation").
//
// Source: FortiOS CLI reference 6.4–7.4, `config system dhcp server` → `config reserved-address`
// (id, type, ip, mac, action, description — "Description", string, max 255); written through the
// CMDB REST API PUT /api/v2/cmdb/system.dhcp/server/{id} with the full reserved-address list, as
// AddReservation already does.
const mechRename = "FortiOS DHCP reserved-address description (/api/v2/cmdb/system.dhcp/server)"

var _ router.Renamer = (*Driver)(nil)

func (d *Driver) findReserved(ctx context.Context, op, mac string) (*fgtDHCPServer, int, error) {
	srvs, err := d.readDHCPServers(ctx, op)
	if err != nil {
		return nil, -1, err
	}
	for i := range srvs {
		for j, r := range srvs[i].ReservedAddress {
			if strings.EqualFold(str(r["action"]), "block") {
				continue
			}
			if m, err := router.NormalizeMAC(str(r["mac"])); err == nil && m == mac {
				return &srvs[i], j, nil
			}
		}
	}
	return nil, -1, nil
}

// RenameClient sets the description of the device's reserved address and re-reads it.
func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanName(rawName)
	if err != nil {
		return router.Change{}, err
	}
	srv, idx, err := d.findReserved(ctx, "rename", mac)
	if err != nil {
		return router.Change{}, err
	}
	if srv == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rename",
			"FortiGate stores a device name on its DHCP reservation and %s has none; reserve an address for it first", mac)
	}
	entry := srv.ReservedAddress[idx]
	old := strings.TrimSpace(str(entry["description"]))
	if old == name {
		return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("the reservation of %s is already described as %q", mac, name)}, nil
	}
	updated := make([]map[string]any, len(srv.ReservedAddress))
	for i, r := range srv.ReservedAddress {
		c := make(map[string]any, len(r))
		for k, v := range r {
			c[k] = v
		}
		if i == idx {
			c["description"] = name
		}
		updated[i] = c
	}
	st, _, err := d.do(ctx, "rename", http.MethodPut, fmt.Sprintf("/api/v2/cmdb/system.dhcp/server/%d", srv.ID), map[string]any{"reserved-address": updated})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "rename", "FortiOS DHCP server update returned HTTP %d", st)
	}
	after, j, err := d.findReserved(ctx, "rename", mac)
	if err != nil {
		return router.Change{}, err
	}
	if after == nil || strings.TrimSpace(str(after.ReservedAddress[j]["description"])) != name {
		return router.Change{}, router.Errorf(router.ErrProtocol, "rename", "FortiGate accepted the change but the reservation of %s does not show the new name", mac)
	}
	undo := "Rename it back in Nigafiy, or edit the reservation under Network → Interfaces → DHCP Server in FortiGate"
	if old != "" {
		undo = fmt.Sprintf("Rename it back to %q in Nigafiy, or edit the reservation under Network → Interfaces → DHCP Server in FortiGate", old)
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("set the description of the FortiGate DHCP reservation of %s (%s) to %q", mac, str(entry["ip"]), name),
		Undo:      undo,
	}, nil
}
