// Package ciscoxe reads and controls Cisco IOS XE routers and L3 gateways via RESTCONF
// (/restconf/data/*, YANG models Cisco-IOS-XE-native, -acl, -dhcp, -nat, -policy, -arp-oper,
// -dhcp-oper, cisco-ia) using HTTP Basic Auth. It registers itself as vendor "cisco_xe".
//
// Mechanisms used:
//   - identify: GET /restconf/data/Cisco-IOS-XE-native:native/version & hostname
//   - clients:  merges GET /restconf/data/Cisco-IOS-XE-arp-oper:arp-data and
//     GET /restconf/data/Cisco-IOS-XE-dhcp-oper:dhcp-oper-data
//   - block / schedule: acl.go (ACL NIGAFIY-LAN-IN inbound on the LAN interface, time-ranges)
//   - rate limit: qos.go (policy-maps with police), reservations and rename: dhcp.go (manual
//     bindings), port forwards: nat.go (static NAT), every write then "write memory" (restconf.go)
//   - Wi-Fi: not offered (IOS XE routers have no radios; the 9800 wireless controller is a
//     separate product with its own model, out of scope).
//
// Every control needs IOS XE 16.6 or later (RESTCONF configuration writes). No SSH CLI fallback is
// used: every control above has a native YANG model.
package ciscoxe

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "cisco_xe"

const yangJSON = "application/yang-data+json"

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one Cisco IOS XE router over RESTCONF.
type Driver struct {
	target     router.Target
	base       string
	http       *http.Client
	creds      router.CredentialSource
	authHeader []byte
	info       *router.Info
}

// New builds a Cisco IOS XE RESTCONF driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) ensureAuth(ctx context.Context) error {
	if len(d.authHeader) > 0 {
		return nil
	}
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)
	raw := make([]byte, 0, len(user)+1+len(pass))
	raw = append(raw, user...)
	raw = append(raw, ':')
	raw = append(raw, pass...)
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	router.Zero(raw)
	d.authHeader = append([]byte("Basic "), enc...)
	router.Zero(enc)
	return nil
}

func (d *Driver) get(ctx context.Context, op, path string) (int, []byte, error) {
	if err := d.ensureAuth(ctx); err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path, nil)
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Authorization", string(d.authHeader))
	req.Header.Set("Accept", yangJSON)
	resp, err := d.http.Do(req)
	if err != nil {
		return 0, nil, router.TransportError(op, err)
	}
	defer resp.Body.Close()
	raw, err := router.ReadBody(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrBadCredentials, Op: op, Detail: "RESTCONF rejected credentials (HTTP 401)"}
	case http.StatusForbidden:
		return resp.StatusCode, nil, &router.Error{Kind: router.ErrNotAuthorized, Op: op, Detail: "privilege 15 RESTCONF access required (HTTP 403)"}
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	st, raw, err := d.get(ctx, "identify", "/restconf/data/Cisco-IOS-XE-native:native/version")
	if err != nil {
		return router.Info{}, err
	}
	if st != http.StatusOK {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "RESTCONF returned HTTP %d (enable 'restconf' and 'ip http secure-server')", st)
	}
	var ver struct {
		Version string `json:"Cisco-IOS-XE-native:version"`
	}
	if err := json.Unmarshal(raw, &ver); err != nil || ver.Version == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a Cisco IOS XE RESTCONF version payload")
	}
	info := router.Info{Vendor: "Cisco", Model: "IOS XE", Firmware: ver.Version, Extra: map[string]string{}}
	if hst, hraw, herr := d.get(ctx, "identify", "/restconf/data/Cisco-IOS-XE-native:native/hostname"); herr == nil && hst == http.StatusOK {
		var hn struct {
			Hostname string `json:"Cisco-IOS-XE-native:hostname"`
		}
		if json.Unmarshal(hraw, &hn) == nil && hn.Hostname != "" {
			info.Extra["hostname"] = hn.Hostname
		}
	}
	if ist, iraw, ierr := d.get(ctx, "identify", "/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware/device-inventory"); ierr == nil && ist == http.StatusOK {
		var inv struct {
			Items []struct {
				HWType     string `json:"hw-type"`
				PartNumber string `json:"part-number"`
				Serial     string `json:"serial-number"`
			} `json:"Cisco-IOS-XE-device-hardware-oper:device-inventory"`
		}
		if json.Unmarshal(iraw, &inv) == nil {
			for _, it := range inv.Items {
				if strings.Contains(strings.ToLower(it.HWType), "chassis") && it.PartNumber != "" {
					info.Model = it.PartNumber
					if it.Serial != "" {
						info.Extra["serial"] = it.Serial
					}
					break
				}
			}
		}
	}
	d.info = &info
	return info, nil
}

func (d *Driver) Capabilities(ctx context.Context) (router.Capabilities, error) {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return nil, err
		}
	}
	caps := router.Capabilities{
		{Capability: router.CapClients, Supported: true, Mechanism: "Cisco IOS XE RESTCONF ARP table (Cisco-IOS-XE-arp-oper)"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "Cisco IOS XE RESTCONF DHCP operational data (Cisco-IOS-XE-dhcp-oper)"},
		{Capability: router.CapBlock, Mechanism: mechBlock},
		{Capability: router.CapRateLimit, Mechanism: mechRate},
		{Capability: router.CapSchedule, Mechanism: mechSchedule},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: false, Note: noteWiFi},
		{Capability: router.CapReservations, Mechanism: mechReserve},
		{Capability: router.CapPortForward, Mechanism: mechNAT},
		{Capability: router.CapRename, Mechanism: mechRename, Requires: router.RequiresReservation},
		{Capability: router.CapReboot, Supported: false, Note: "Restarting an enterprise IOS XE router is deliberately not offered (it drops every routed network at once)"},
	}
	set := func(c router.Capability, ok bool, note string) {
		for i := range caps {
			if caps[i].Capability == c {
				caps[i].Supported, caps[i].Note = ok, note
			}
		}
	}
	writes := []router.Capability{router.CapBlock, router.CapRateLimit, router.CapSchedule, router.CapReservations, router.CapPortForward, router.CapRename}
	if ok, known := versionAtLeast(d.info.Firmware, minWriteMajor, minWriteMinor); !known || !ok {
		for _, c := range writes {
			set(c, false, fmt.Sprintf("needs IOS XE 16.6 or later for RESTCONF configuration changes (this router reports %q)", d.info.Firmware))
		}
		return caps, nil
	}
	all, err := d.interfaces(ctx, "capabilities")
	if err != nil {
		var rerr *router.Error
		if !errors.As(err, &rerr) || (rerr.Kind != router.ErrProtocol && rerr.Kind != router.ErrUnsupported) {
			return nil, err
		}
		for _, c := range writes {
			set(c, false, rerr.Detail)
		}
		return caps, nil
	}
	var lan *iface
	natOut := false
	for i := range all {
		if all[i].Addr == d.target.Address && all[i].Prefix.IsValid() {
			lan = &all[i]
		}
		natOut = natOut || (all[i].NATOut && all[i].Addr.IsValid())
	}
	if lan == nil {
		for _, c := range writes {
			set(c, false, fmt.Sprintf("no interface has the router address %s as its primary address, so the LAN interface is unknown", d.target.Address))
		}
		return caps, nil
	}
	blockNote := "matches the device's current IPv4 address (IOS XE ACLs cannot match MAC addresses on a routed interface); reserve its address so it cannot escape the block"
	if lan.ACLIn != "" && lan.ACLIn != aclName {
		set(router.CapBlock, false, fmt.Sprintf("the LAN interface %s already has the administrator's inbound ACL %q; Nigafiy never replaces it", lan.label(), lan.ACLIn))
		set(router.CapSchedule, false, fmt.Sprintf("the LAN interface %s already has the administrator's inbound ACL %q; Nigafiy never replaces it", lan.label(), lan.ACLIn))
	} else {
		set(router.CapBlock, true, blockNote)
		set(router.CapSchedule, true, "router local time; a window to midnight ends at 23:59 (IOS time-ranges have no 24:00)")
	}
	switch {
	case lan.PolicyI != "" && lan.PolicyI != policyIn:
		set(router.CapRateLimit, false, fmt.Sprintf("the LAN interface %s already has the administrator's input service policy %q", lan.label(), lan.PolicyI))
	case lan.PolicyO != "" && lan.PolicyO != policyOut:
		set(router.CapRateLimit, false, fmt.Sprintf("the LAN interface %s already has the administrator's output service policy %q", lan.label(), lan.PolicyO))
	default:
		set(router.CapRateLimit, true, "police per device on the LAN interface; some platforms refuse an output policy with police, which Nigafiy reports")
	}
	set(router.CapReservations, true, "manual binding with client-identifier 01+MAC; clients that send another identifier (a DUID) do not match")
	set(router.CapRename, true, "stored as the client-name of the device's Nigafiy reservation (letters, digits and hyphens)")
	if lan.NATIn && natOut {
		set(router.CapPortForward, true, "one port per rule; every static NAT entry is shown as the administrator's (IOS XE static NAT has no description)")
	} else {
		set(router.CapPortForward, false, "NAT is not set up (\"ip nat inside\" on the LAN interface and \"ip nat outside\" on an interface with a static IPv4 address); Nigafiy never turns NAT on")
	}
	return caps, nil
}

// noteWiFi: the precise reason, also shown translated in the web app (routers.wifi.ciscoXeNote).
const noteWiFi = "Cisco IOS XE routers have no Wi-Fi radios; wireless is run by a separate controller (Catalyst 9800) with its own management, which this driver does not control"

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	byMAC := map[string]*router.Client{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnWired, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	st, raw, err := d.get(ctx, "clients", "/restconf/data/Cisco-IOS-XE-arp-oper:arp-data")
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK && st != http.StatusNoContent {
		return nil, router.Errorf(router.ErrProtocol, "clients", "arp-oper returned HTTP %d", st)
	}
	if st == http.StatusOK && len(raw) > 0 {
		var arpResp struct {
			Data struct {
				ArpVrf []struct {
					Vrf     string           `json:"vrf"`
					Entries []map[string]any `json:"arp-oper"`
				} `json:"arp-vrf"`
				Entries []map[string]any `json:"arp-entry"`
			} `json:"Cisco-IOS-XE-arp-oper:arp-data"`
		}
		if json.Unmarshal(raw, &arpResp) == nil {
			var all []map[string]any
			all = append(all, arpResp.Data.Entries...)
			for _, v := range arpResp.Data.ArpVrf {
				all = append(all, v.Entries...)
			}
			for _, e := range all {
				mac, err := parseCiscoMAC(first(str(e["hw-address"]), str(e["hardware"])))
				if err != nil {
					continue
				}
				c := ensure(mac)
				if ip := first(str(e["ip-address"]), str(e["address"])); ip != "" {
					c.IP = ip
				}
				if iface := str(e["interface"]); iface != "" {
					c.Interface = iface
				}
				t := true
				c.Active = &t
				for k, v := range e {
					if s := str(v); s != "" {
						c.Raw["arp."+k] = s
					}
				}
			}
		}
	}

	if dst, draw, derr := d.get(ctx, "clients", "/restconf/data/Cisco-IOS-XE-dhcp-oper:dhcp-oper-data"); derr == nil && dst == http.StatusOK && len(draw) > 0 {
		var dhcpResp struct {
			Data struct {
				Server []struct {
					ClientIP       string `json:"client-ip"`
					ClientMAC      string `json:"client-mac"`
					LeaseRemaining int64  `json:"lease-remaining"`
					Type           string `json:"type"`
				} `json:"dhcpv4-server-oper"`
			} `json:"Cisco-IOS-XE-dhcp-oper:dhcp-oper-data"`
		}
		if json.Unmarshal(draw, &dhcpResp) == nil {
			for _, b := range dhcpResp.Data.Server {
				mac, err := parseCiscoMAC(b.ClientMAC)
				if err != nil {
					continue
				}
				c := ensure(mac)
				if c.IP == "" && b.ClientIP != "" {
					c.IP = b.ClientIP
				}
				src := "dhcp"
				if strings.Contains(strings.ToLower(b.Type), "manual") || strings.Contains(strings.ToLower(b.Type), "static") {
					src = "reserved"
				}
				lease := &router.Lease{Source: src}
				if b.LeaseRemaining > 0 {
					dur := time.Duration(b.LeaseRemaining) * time.Second
					lease.Remaining = &dur
				}
				c.Lease = lease
			}
		}
	}

	// The router's own block state: a Nigafiy block entry in NIGAFIY-LAN-IN (an ACL that cannot be
	// read leaves the state unknown).
	blocked := map[string]bool{}
	known := false
	if es, _, err := d.readACL(ctx, "clients"); err == nil {
		known = true
		for _, p := range pairs(es) {
			if p.Kind == "block" {
				blocked[p.MAC] = true
			}
		}
	}
	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		if known {
			b := blocked[c.MAC]
			c.Blocked = &b
		}
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Close(context.Context) error {
	router.Zero(d.authHeader)
	d.authHeader = nil
	return nil
}

// parseCiscoMAC accepts both standard MACs and Cisco dotted format ("aabb.cc00.0300").
func parseCiscoMAC(s string) (string, error) {
	s = strings.TrimSpace(s)
	if m, err := router.NormalizeMAC(s); err == nil {
		return m, nil
	}
	clean := strings.ReplaceAll(s, ".", "")
	if len(clean) == 12 {
		colon := clean[0:2] + ":" + clean[2:4] + ":" + clean[4:6] + ":" + clean[6:8] + ":" + clean[8:10] + ":" + clean[10:12]
		return router.NormalizeMAC(colon)
	}
	return "", &router.Error{Kind: router.ErrInvalidArgument, Op: "mac", Detail: "invalid MAC"}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
