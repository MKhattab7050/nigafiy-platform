// Package ciscoxe reads Cisco IOS XE routers and L3 gateways via RESTCONF (/restconf/data/*,
// YANG models Cisco-IOS-XE-native, Cisco-IOS-XE-arp-oper, Cisco-IOS-XE-dhcp-oper) using HTTP Basic
// Auth. It registers itself as vendor "cisco_xe".
//
// Mechanisms used:
//   - identify: GET /restconf/data/Cisco-IOS-XE-native:native/version & hostname
//   - clients:  merges GET /restconf/data/Cisco-IOS-XE-arp-oper:arp-data and
//               GET /restconf/data/Cisco-IOS-XE-dhcp-oper:dhcp-oper-data
//   - block:    deliberately unsupported here (enterprise IOS XE ACLs depend on interface, VRF and
//               direction; use Port Detective switch-port disable/quarantine instead).
package ciscoxe

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
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
	return router.Capabilities{
		{Capability: router.CapClients, Supported: true, Mechanism: "Cisco IOS XE RESTCONF ARP table (Cisco-IOS-XE-arp-oper)"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "Cisco IOS XE RESTCONF DHCP operational data (Cisco-IOS-XE-dhcp-oper)"},
		{Capability: router.CapBlock, Supported: false, Note: "IOS XE blocking depends on site-specific interface ACLs/VRFs; use Port Detective switch-port control or quarantine VLANs instead"},
		{Capability: router.CapRateLimit, Supported: false, Note: "IOS XE QoS uses class-map/policy-map templates per interface"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not offered over generic RESTCONF"},
	}, nil
}

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

	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		f := false
		c.Blocked = &f
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(context.Context) ([]router.BlockEntry, error) { return nil, nil }

func (d *Driver) Block(context.Context, string) (router.Change, error) {
	return router.Change{}, router.Errorf(router.ErrUnsupported, "block", "Cisco IOS XE driver is read-only; use switch-port quarantine or site ACLs")
}

func (d *Driver) Unblock(context.Context, string) (router.Change, error) {
	return router.Change{}, router.Errorf(router.ErrUnsupported, "unblock", "Cisco IOS XE driver is read-only")
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
