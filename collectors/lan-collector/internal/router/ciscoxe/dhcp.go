package ciscoxe

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// DHCP reservations: IOS XE manual bindings, one pool per device (Cisco-IOS-XE-dhcp):
//
//	ip dhcp pool NIGAFIY-<MAC>
//	 host <address> <LAN mask>
//	 client-identifier 01<MAC>        (hardware type 1 + MAC, what Windows, macOS, iOS and Android send)
//	 client-name <name>               (a rename; only on a Nigafiy reservation)
//
// The administrator's manual bindings are listed (host + client-identifier or hardware-address) but
// never changed. A client that sends another client identifier (e.g. a DUID) does not match a
// "01<MAC>" binding; that is the documented IOS XE behaviour, not something Nigafiy can change.

const (
	dhcpPath       = nativePath + "/ip/Cisco-IOS-XE-dhcp:dhcp"
	mechReserve    = "IOS XE DHCP manual binding (ip dhcp pool NIGAFIY-<MAC>: host + client-identifier), RESTCONF"
	mechRename     = "IOS XE DHCP manual binding client-name of the Nigafiy reservation, RESTCONF"
	reservePrefix  = productPrefix
	maxPoolsListed = 512
)

func poolName(mac string) string { return reservePrefix + macKey(mac) }

func poolPath(name string) string { return dhcpPath + "/pool=" + name }

type pool struct {
	ID, MAC, IP, Name string
}

// macFromIdentifier reads "0100.1122.3344.55" (type 01 + MAC) or a dotted hardware address.
func macFromIdentifier(s string) (string, bool) {
	h := strings.ToLower(strings.NewReplacer(".", "", ":", "", "-", "").Replace(strings.TrimSpace(s)))
	if len(h) == 14 && strings.HasPrefix(h, "01") {
		h = h[2:]
	}
	if len(h) != 12 {
		return "", false
	}
	m, err := router.NormalizeMAC(h[0:2] + ":" + h[2:4] + ":" + h[4:6] + ":" + h[6:8] + ":" + h[8:10] + ":" + h[10:12])
	return m, err == nil
}

func (d *Driver) pools(ctx context.Context, op string) ([]pool, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, dhcpPath, nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound || st == http.StatusNoContent {
		return []pool{}, nil
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "reading the DHCP pools returned HTTP %d", st)
	}
	var rep struct {
		DHCP struct {
			Pool []struct {
				ID   string `json:"id"`
				Host struct {
					Host string `json:"host"`
				} `json:"host"`
				ClientID struct {
					ID string `json:"unique-identifier"`
				} `json:"client-identifier"`
				HW struct {
					Addr string `json:"hardware-address"`
				} `json:"hardware-address"`
				Name string `json:"client-name"`
			} `json:"pool"`
		} `json:"Cisco-IOS-XE-dhcp:dhcp"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "not an IOS XE DHCP payload")
	}
	out := []pool{}
	for _, p := range rep.DHCP.Pool {
		if p.Host.Host == "" || len(out) >= maxPoolsListed {
			continue
		}
		mac, ok := macFromIdentifier(p.ClientID.ID)
		if !ok {
			mac, ok = macFromIdentifier(p.HW.Addr)
		}
		if !ok {
			continue
		}
		out = append(out, pool{ID: p.ID, MAC: mac, IP: p.Host.Host, Name: p.Name})
	}
	return out, nil
}

func (d *Driver) readReservations(ctx context.Context) ([]router.Reservation, error) {
	ps, err := d.pools(ctx, "settings")
	if err != nil {
		return nil, err
	}
	out := make([]router.Reservation, 0, len(ps))
	for _, p := range ps {
		out = append(out, router.Reservation{ID: p.ID, MAC: p.MAC, IP: p.IP, Enabled: true})
	}
	return out, nil
}

func maskOf(p netip.Prefix) string {
	v := ^uint32(0) << (32 - p.Bits())
	return fmt.Sprintf("%d.%d.%d.%d", v>>24, (v>>16)&0xff, (v>>8)&0xff, v&0xff)
}

func (d *Driver) AddReservation(ctx context.Context, mac, ip string) (router.Change, error) {
	const op = "reserve"
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	lan, err := d.lan(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	ps, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	existing := make([]router.Reservation, 0, len(ps))
	for _, p := range ps {
		existing = append(existing, router.Reservation{ID: p.ID, MAC: p.MAC, IP: p.IP, Enabled: true})
	}
	m, addr, err := router.ValidateReservation(mac, ip, existing, lan.Prefix, d.routerAddr())
	if err != nil {
		return router.Change{}, err
	}
	name := poolName(m)
	for _, p := range ps {
		if p.MAC != m {
			continue
		}
		if p.ID != name {
			return router.Change{}, router.Errorf(router.ErrRejected, op, "the administrator's DHCP pool %q already binds this device; Nigafiy does not change it", p.ID)
		}
		if p.IP == addr.String() {
			return router.Change{Action: "reserve", MAC: m, Mechanism: mechReserve, AlreadyInEffect: true, Detail: "already reserved: " + addr.String()}, nil
		}
	}
	body := map[string]any{"Cisco-IOS-XE-dhcp:pool": []any{map[string]any{
		"id":                name,
		"host":              map[string]any{"host": addr.String(), "mask": maskOf(lan.Prefix)},
		"client-identifier": map[string]any{"unique-identifier": "01" + ciscoDotted(m)},
	}}}
	if err := d.write(ctx, op, "DHCP manual bindings", http.MethodPut, poolPath(name), body); err != nil {
		return router.Change{}, err
	}
	after, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	ok := false
	for _, p := range after {
		ok = ok || (p.ID == name && p.IP == addr.String() && p.MAC == m)
	}
	if !ok {
		return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the reservation but pool %s does not show it when read back", name)
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "reserve", MAC: m, Mechanism: mechReserve, Applied: true,
		Detail: fmt.Sprintf("ip dhcp pool %s: host %s %s, client-identifier 01%s; saved with write memory", name, addr, maskOf(lan.Prefix), ciscoDotted(m)),
		Undo:   "Remove the reservation in Nigafiy, or on the router: no ip dhcp pool " + name + ", then write memory"}, nil
}

func (d *Driver) RemoveReservation(ctx context.Context, mac string) (router.Change, error) {
	const op = "unreserve"
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	ps, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	name := poolName(m)
	found := false
	for _, p := range ps {
		if p.MAC != m {
			continue
		}
		if p.ID != name {
			return router.Change{}, router.Errorf(router.ErrRejected, op, "this device's reservation is the administrator's DHCP pool %q; Nigafiy does not remove it", p.ID)
		}
		found = true
	}
	if !found {
		return router.Change{Action: "unreserve", MAC: m, Mechanism: mechReserve, Detail: "no Nigafiy reservation for this device"}, nil
	}
	if err := d.write(ctx, op, "DHCP manual bindings", http.MethodDelete, poolPath(name), nil); err != nil {
		return router.Change{}, err
	}
	after, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	for _, p := range after {
		if p.ID == name {
			return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the removal but pool %s is still there when read back", name)
		}
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unreserve", MAC: m, Mechanism: mechReserve, Applied: true, Detail: "no ip dhcp pool " + name + "; saved with write memory", Undo: "Reserve the address again in Nigafiy"}, nil
}

// RenameClient stores the name as the client-name of the device's Nigafiy reservation
// (Requires: reservation). The name is handed out as a DHCP host name, so it must be a host name.
func (d *Driver) RenameClient(ctx context.Context, mac, name string) (router.Change, error) {
	const op = "rename"
	m, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	n, err := router.CleanHostname(name)
	if err != nil {
		return router.Change{}, err
	}
	if err := d.writable(ctx, op); err != nil {
		return router.Change{}, err
	}
	ps, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	pn := poolName(m)
	var mine *pool
	for i := range ps {
		if ps[i].MAC == m && ps[i].ID == pn {
			mine = &ps[i]
		}
	}
	if mine == nil {
		return router.Change{}, router.Errorf(router.ErrNotFound, op, "IOS XE stores a device name on its DHCP reservation: reserve an address for this device in Nigafiy first")
	}
	if mine.Name == n {
		return router.Change{Action: "rename", MAC: m, Mechanism: mechRename, AlreadyInEffect: true, Detail: "the reservation already has this name"}, nil
	}
	body := map[string]any{"Cisco-IOS-XE-dhcp:pool": []any{map[string]any{"id": pn, "client-name": n}}}
	if err := d.write(ctx, op, "DHCP client names", http.MethodPatch, poolPath(pn), body); err != nil {
		return router.Change{}, err
	}
	after, err := d.pools(ctx, op)
	if err != nil {
		return router.Change{}, err
	}
	ok := false
	for _, p := range after {
		ok = ok || (p.ID == pn && p.Name == n)
	}
	if !ok {
		return router.Change{}, router.Errorf(router.ErrProtocol, op, "the router accepted the name but pool %s does not show it when read back", pn)
	}
	if err := d.save(ctx, op); err != nil {
		return router.Change{}, err
	}
	undo := "Rename again in Nigafiy, or on the router: ip dhcp pool " + pn + " / no client-name"
	if mine.Name != "" {
		undo = "Rename back to " + mine.Name + " in Nigafiy, or on the router: ip dhcp pool " + pn + " / client-name " + mine.Name
	}
	return router.Change{Action: "rename", MAC: m, Mechanism: mechRename, Applied: true, Detail: "client-name " + n + " on " + pn + "; saved with write memory", Undo: undo}, nil
}
