package pfsense

import (
	"context"
	"fmt"
	"net/http"

	"github.com/nigafiy/sensor/internal/router"
)

// Rename on pfSense is stored on the device's DHCP static mapping: pfSense keeps no client alias table
// of its own, and the static mapping's `hostname` is the name pfSense hands out in DHCP and shows in
// Status → DHCP Leases and Diagnostics → ARP Table. So a rename needs a reservation first
// (capability Requires = "reservation"), and the name must be a valid host name.
//
// Source: pfSense-pkg-RESTAPI v2 (pfrest, pfSense CE 2.7.x / Plus 23.09+), model
// RESTAPI/Models/DHCPServerStaticMapping.inc: fields `parent_id`, `id`, `mac`, `ipaddr`, `hostname`
// (HostnameValidator), `descr`; endpoint PATCH /api/v2/services/dhcp_server/static_mapping, then
// POST /api/v2/services/dhcp_server/apply.
const mechRename = "pfSense DHCP static mapping host name (PATCH /api/v2/services/dhcp_server/static_mapping)"

var _ router.Renamer = (*Driver)(nil)

// RenameClient sets the host name of the device's static mapping and re-reads it.
func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanHostname(rawName)
	if err != nil {
		return router.Change{}, err
	}
	find := func(op string) (*pfStaticMap, error) {
		list, err := d.readStaticMappings(ctx, op)
		if err != nil {
			return nil, err
		}
		for i := range list {
			if m, err := router.NormalizeMAC(list[i].MAC); err == nil && m == mac {
				return &list[i], nil
			}
		}
		return nil, nil
	}
	sm, err := find("rename")
	if err != nil {
		return router.Change{}, err
	}
	if sm == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rename",
			"pfSense stores a device name on its DHCP static mapping and %s has none; reserve an address for it first", mac)
	}
	old := sm.Hostname
	if old == name {
		return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("the static mapping of %s is already named %q", mac, name)}, nil
	}
	parent := first(sm.ParentID, "lan")
	if _, _, err := d.do(ctx, "rename", http.MethodPatch, "/api/v2/services/dhcp_server/static_mapping", map[string]any{
		"parent_id": parent,
		"id":        sm.ID,
		"hostname":  name,
	}); err != nil {
		return router.Change{}, err
	}
	if _, _, err := d.do(ctx, "rename", http.MethodPost, "/api/v2/services/dhcp_server/apply", map[string]any{}); err != nil {
		return router.Change{}, err
	}
	after, err := find("rename")
	if err != nil {
		return router.Change{}, err
	}
	if after == nil || after.Hostname != name {
		return router.Change{}, router.Errorf(router.ErrProtocol, "rename", "pfSense accepted the change but the static mapping of %s does not show the new name", mac)
	}
	undo := "Rename it back in Nigafiy, or edit the static mapping under Services → DHCP Server in pfSense"
	if old != "" {
		undo = fmt.Sprintf("Rename it back to %q in Nigafiy, or edit the static mapping under Services → DHCP Server in pfSense", old)
	}
	return router.Change{
		Action:    "rename",
		MAC:       mac,
		Mechanism: mechRename,
		Applied:   true,
		Detail:    fmt.Sprintf("set the host name of the pfSense static mapping of %s (%s) to %q", mac, sm.IPAddr, name),
		Undo:      undo,
	}, nil
}
