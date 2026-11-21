// Package zyxel drives Zyxel gateways with the ZCFG/DAL web API (the VMG3625-T50B family and its
// siblings that share the same web UI). It registers itself as router vendor "zyxel".
//
// Mechanisms used, all taken from the router's own web UI code:
//   - client list: GET /cgi-bin/DAL?oid=lanhosts  -> Object[0].lanhosts[]
//   - block/unblock: the per-device "Internet Blocking" switch of Home Networking > connected devices,
//     PUT /cgi-bin/DAL?oid=lanhosts {HostName, DeviceIcon, MacAddress, Internet_Blocking_Enable}.
//     It is a per-device flag, not a rule: it rewrites no administrator rule and is undone by turning
//     the same switch off. The router keeps no owner for it, so Change.AlreadyInEffect tells the
//     caller whether a block pre-existed (and must therefore never be lifted by the product).
//   - read-only context for Blocked: the MAC filter (oid=macfilter) and parental-control profiles
//     (oid=paren_ctl). They are the administrator's rules; this driver never writes them.
//
// Rate limiting and schedules are not offered: see the capability notes.
package zyxel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

// Vendor is the registry key.
const Vendor = "zyxel"

// TestedModels are models this driver's unauthenticated identification was checked against.
// Authenticated calls are implemented from the vendor UI code and exercised in tests only.
var TestedModels = map[string]bool{"VMG3625-T50B": true}

const (
	mechanismBlock = "per-device internet blocking (Home Networking > connected devices)"
	cacheTTL       = 5 * time.Second
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

// Driver is a router.Driver for one Zyxel gateway.
type Driver struct {
	target router.Target
	base   string
	http   *http.Client
	creds  router.CredentialSource
	sess   session
	info   *router.Info

	hostsCache       []host
	hostsCacheAt     time.Time
	hostsClientsUsed bool
	mfCache          *macFilter
	mfCacheAt        time.Time
}

func (d *Driver) invalidateCache() {
	d.hostsCache = nil
	d.hostsCacheAt = time.Time{}
	d.hostsClientsUsed = false
	d.mfCache = nil
	d.mfCacheAt = time.Time{}
}

// New builds a driver; the router package's Open is the normal entry point (it also authorizes).
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

// Logins reports how many login attempts this driver made (diagnostics and tests).
func (d *Driver) Logins() int { return d.sess.loginCount }

func (d *Driver) lang() string {
	if d.info != nil && d.info.Extra["language"] != "" {
		return d.info.Extra["language"]
	}
	return "en"
}

// Identify reads the public /getBasicInformation endpoint; no login is needed.
func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	status, raw, err := d.do(ctx, "identify", http.MethodGet, "/getBasicInformation", nil, false)
	if err != nil {
		return router.Info{}, err
	}
	var b struct {
		Result          string `json:"result"`
		ModelName       string `json:"ModelName"`
		SoftwareVersion string `json:"SoftwareVersion"`
		CurrentLanguage string `json:"CurrentLanguage"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &b) != nil || b.ModelName == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a Zyxel ZCFG device (HTTP %d)", status)
	}
	info := router.Info{Vendor: "Zyxel", Model: b.ModelName, Firmware: b.SoftwareVersion, Extra: map[string]string{}}
	if b.CurrentLanguage != "" {
		info.Extra["language"] = b.CurrentLanguage
	}
	d.info = &info
	return info, nil
}

// withSession logs in when needed and retries once with a fresh login if the router says the
// session is gone.
func (d *Driver) withSession(ctx context.Context, fn func() error) error {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return err
		}
	}
	if !d.sess.loggedIn {
		if err := d.login(ctx); err != nil {
			return err
		}
	}
	err := fn()
	if !isExpired(err) {
		return err
	}
	d.invalidateCache()
	d.sess.wipe()
	if err := d.login(ctx); err != nil {
		return err
	}
	return fn()
}

func isExpired(err error) bool { return errors.Is(err, router.ErrSessionExpired) }

type dalReply struct {
	Result            string            `json:"result"`
	ReplyMsg          string            `json:"ReplyMsg"`
	ReplyMsgMultiLang string            `json:"ReplyMsgMultiLang"`
	Object            []json.RawMessage `json:"Object"`
}

func (d *Driver) dal(ctx context.Context, op, method, oid string, obj any) (dalReply, error) {
	var body []byte
	if obj != nil {
		plain, err := json.Marshal(obj)
		if err != nil {
			return dalReply{}, router.Errorf(router.ErrInvalidArgument, op, "cannot encode request")
		}
		content, iv, err := encrypt(d.sess.aesKey, plain)
		router.Zero(plain)
		if err != nil {
			return dalReply{}, err
		}
		body, _ = json.Marshal(envelope{Content: content, IV: iv})
	}
	status, raw, err := d.do(ctx, op, method, "/cgi-bin/DAL?oid="+oid, body, method != http.MethodGet)
	router.Zero(body)
	if err != nil {
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			return dalReply{}, &router.Error{Kind: router.ErrSessionExpired, Op: op}
		}
		return dalReply{}, err
	}
	defer router.Zero(raw)
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return dalReply{}, &router.Error{Kind: router.ErrSessionExpired, Op: op, Detail: "HTTP " + strconv.Itoa(status)}
	}
	var rep dalReply
	if err := json.Unmarshal(raw, &rep); err != nil {
		return dalReply{}, router.Errorf(router.ErrProtocol, op, "unreadable reply (HTTP %d)", status)
	}
	if rep.Result == "No AesKey" {
		return dalReply{}, &router.Error{Kind: router.ErrSessionExpired, Op: op}
	}
	if status != http.StatusOK || rep.Result != "ZCFG_SUCCESS" {
		msg := rep.ReplyMsg
		if msg == "" {
			msg = rep.ReplyMsgMultiLang
		}
		kind := router.ErrRejected
		if method == http.MethodGet {
			kind = router.ErrUnsupported
		}
		return dalReply{}, router.Errorf(kind, op, "oid %s: HTTP %d, result %q %s", oid, status, truncate(rep.Result, 60), truncate(msg, 120))
	}
	return rep, nil
}

// host is one lanhosts entry kept as generic JSON, so unknown fields survive into Raw.
type host map[string]any

func (h host) str(k string) string {
	switch v := h[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func (h host) boolean(k string) (bool, bool) {
	switch v := h[k].(type) {
	case bool:
		return v, true
	case float64:
		return v != 0, true
	case string:
		switch strings.ToLower(v) {
		case "true", "1":
			return true, true
		case "false", "0":
			return false, true
		}
	}
	return false, false
}

func (h host) mac() string {
	m, err := router.NormalizeMAC(h.str("PhysAddress"))
	if err != nil {
		return ""
	}
	return m
}

func (d *Driver) lanhosts(ctx context.Context) ([]host, error) {
	if d.hostsCache != nil && time.Since(d.hostsCacheAt) < cacheTTL {
		return d.hostsCache, nil
	}
	rep, err := d.dal(ctx, "clients", http.MethodGet, "lanhosts", nil)
	if err != nil {
		return nil, err
	}
	if len(rep.Object) == 0 {
		return nil, router.Errorf(router.ErrProtocol, "clients", "lanhosts reply has no object")
	}
	var obj struct {
		LanHosts []host `json:"lanhosts"`
	}
	if err := json.Unmarshal(rep.Object[0], &obj); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "clients", "lanhosts has an unexpected shape")
	}
	d.hostsCache = obj.LanHosts
	d.hostsCacheAt = time.Now()
	d.hostsClientsUsed = false
	return obj.LanHosts, nil
}

func connection(s string) router.ConnectionType {
	l := strings.ToLower(s)
	switch {
	case l == "ethernet" || strings.Contains(l, "lan") || strings.Contains(l, "wired"):
		return router.ConnWired
	case strings.Contains(l, "2.4"):
		return router.ConnWiFi24
	case strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5g"):
		return router.ConnWiFi5
	case strings.Contains(l, "wi-fi") || strings.Contains(l, "wifi") || strings.Contains(l, "wireless") || strings.Contains(l, "wlan"):
		return router.ConnWiFi
	}
	return router.ConnUnknown
}

// toClient maps a lanhosts entry. Field names come from the router's web UI; optional TR-181 Host
// fields (Active, AddressSource, LeaseTimeRemaining, signal) are used only when present.
func toClient(h host) (router.Client, bool) {
	mac := h.mac()
	if mac == "" {
		return router.Client{}, false
	}
	c := router.Client{MAC: mac, IP: h.str("IPAddress"), Connection: connection(h.str("X_ZYXEL_ConnectionType")), Raw: map[string]string{}}
	for _, k := range []string{"curHostName", "HostName", "DeviceName"} {
		if v := strings.TrimSpace(h.str(k)); v != "" {
			c.Hostname = v
			break
		}
	}
	for _, k := range []string{"Layer1Interface", "X_ZYXEL_SSID", "SSID"} {
		if v := h.str(k); v != "" {
			c.Interface = v
			break
		}
	}
	if v, ok := h.boolean("Active"); ok {
		c.Active = &v
	}
	if v, ok := h.boolean("Internet_Blocking_Enable"); ok {
		c.Blocked = &v
	}
	for _, k := range []string{"SignalStrength", "X_ZYXEL_SignalStrength", "X_ZYXEL_RSSI", "RSSI"} {
		if v, err := strconv.Atoi(strings.TrimSpace(strings.TrimSuffix(h.str(k), "dBm"))); err == nil && v < 0 && v > -120 {
			c.SignalDBm = &v
			break
		}
	}
	src, remain := h.str("AddressSource"), h.str("LeaseTimeRemaining")
	if src != "" || remain != "" {
		l := &router.Lease{}
		switch strings.ToLower(src) {
		case "dhcp":
			l.Source = "dhcp"
		case "static":
			l.Source = "static"
		case "":
		default:
			l.Source = strings.ToLower(src)
		}
		if secs, err := strconv.Atoi(remain); err == nil && secs >= 0 {
			dur := time.Duration(secs) * time.Second
			l.Remaining = &dur
		}
		c.Lease = l
	}
	for k := range h {
		c.Raw[k] = h.str(k)
	}
	return c, true
}

// Clients returns the router's own host list.
func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	var out []router.Client
	if d.hostsClientsUsed {
		d.hostsCache = nil
		d.hostsCacheAt = time.Time{}
		d.hostsClientsUsed = false
	}
	err := d.withSession(ctx, func() error {
		hosts, err := d.lanhosts(ctx)
		if err != nil {
			return err
		}
		d.hostsClientsUsed = true
		out = out[:0]
		for _, h := range hosts {
			if c, ok := toClient(h); ok {
				out = append(out, c)
			}
		}
		return nil
	})
	router.SortClients(out)
	return out, err
}

type macFilter struct {
	MAC struct {
		FilterEnable any `json:"Filter_Enable"`
		Restrict     any `json:"Restrict"`
	} `json:"MAC"`
	Whitelist []struct {
		ListEnable any    `json:"List_Enable"`
		HostName   string `json:"HostName"`
		MACAddress string `json:"MACAddress"`
	} `json:"whitelist"`
}

func truthy(v any) bool {
	b, _ := host{"v": v}.boolean("v")
	return b
}

// macFilterState returns (enabled, denyMode, entries). Restrict true means "deny listed devices"
// per the web UI (restrictMode {false: allow, true: deny}).
func (d *Driver) macFilterState(ctx context.Context) (*macFilter, error) {
	if d.mfCache != nil && time.Since(d.mfCacheAt) < cacheTTL {
		return d.mfCache, nil
	}
	rep, err := d.dal(ctx, "mac filter", http.MethodGet, "macfilter", nil)
	if err != nil {
		return nil, err
	}
	if len(rep.Object) == 0 {
		return nil, router.Errorf(router.ErrProtocol, "mac filter", "no object")
	}
	var mf macFilter
	if err := json.Unmarshal(rep.Object[0], &mf); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "mac filter", "unexpected shape")
	}
	d.mfCache = &mf
	d.mfCacheAt = time.Now()
	return &mf, nil
}

type pcpProfile struct {
	Index         any    `json:"Index"`
	Name          string `json:"pcpName"`
	Enable        any    `json:"pcpEnable"`
	MACList       string `json:"MACAddressList"`
	Days          string `json:"Days"`
	TimeRangeList string `json:"TimeRangeList"`
	GlobalEnable  any    `json:"PrentalCtlEnable"`
}

func (d *Driver) parentalProfiles(ctx context.Context) (bool, []pcpProfile, error) {
	rep, err := d.dal(ctx, "parental control", http.MethodGet, "paren_ctl", nil)
	if err != nil {
		return false, nil, err
	}
	var all []pcpProfile
	for _, o := range rep.Object {
		var p pcpProfile
		if json.Unmarshal(o, &p) == nil {
			all = append(all, p)
		}
	}
	if len(all) == 0 {
		return false, nil, nil
	}
	// Object[0] carries the global switch; profiles follow (as the web UI reads it).
	return truthy(all[0].GlobalEnable), all[1:], nil
}

// Blocked lists the per-device internet blocks plus, read-only, the administrator's MAC-filter
// deny entries and active parental-control profiles.
func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	var out []router.BlockEntry
	err := d.withSession(ctx, func() error {
		out = out[:0]
		hosts, err := d.lanhosts(ctx)
		if err != nil {
			return err
		}
		for _, h := range hosts {
			if b, ok := h.boolean("Internet_Blocking_Enable"); ok && b {
				c, _ := toClient(h)
				out = append(out, router.BlockEntry{MAC: c.MAC, Name: c.Hostname, Mechanism: mechanismBlock,
					Owner: router.OwnerUnknown, Managed: true,
					Detail: "per-device switch; the router does not record who turned it on"})
			}
		}
		mf, err := d.macFilterState(ctx)
		switch {
		case err == nil:
			if truthy(mf.MAC.FilterEnable) && truthy(mf.MAC.Restrict) {
				for _, e := range mf.Whitelist {
					mac, merr := router.NormalizeMAC(e.MACAddress)
					if merr != nil || !truthy(e.ListEnable) {
						continue
					}
					out = append(out, router.BlockEntry{MAC: mac, Name: e.HostName, Mechanism: "MAC filter (deny list)",
						Owner: router.OwnerAdmin, Detail: "administrator rule under Security > MAC Filter; not modified by LAN Detective"})
				}
			}
		case isExpired(err):
			return err
		case !isUnsupported(err):
			return err
		}
		global, profiles, err := d.parentalProfiles(ctx)
		switch {
		case err == nil:
			if !global {
				break
			}
			for _, p := range profiles {
				if !truthy(p.Enable) {
					continue
				}
				for _, m := range strings.Split(p.MACList, ",") {
					mac, merr := router.NormalizeMAC(m)
					if merr != nil {
						continue
					}
					out = append(out, router.BlockEntry{MAC: mac, Name: p.Name, Mechanism: "parental control profile",
						Owner: router.OwnerAdmin, Partial: true,
						Detail: fmt.Sprintf("profile %q: internet allowed %s on %s; not modified by LAN Detective", p.Name, p.TimeRangeList, p.Days)})
				}
			}
		case isExpired(err):
			return err
		case !isUnsupported(err):
			return err
		}
		return nil
	})
	sort.SliceStable(out, func(i, j int) bool { return out[i].MAC < out[j].MAC })
	return out, err
}

func isUnsupported(err error) bool { return errors.Is(err, router.ErrUnsupported) }

// Capabilities probes what this router offers (it reads the host list and the MAC filter mode).
func (d *Driver) Capabilities(ctx context.Context) (router.Capabilities, error) {
	var caps router.Capabilities
	err := d.withSession(ctx, func() error {
		hosts, err := d.lanhosts(ctx)
		if err != nil {
			return err
		}
		blockField, leases := false, false
		for _, h := range hosts {
			if _, ok := h["Internet_Blocking_Enable"]; ok {
				blockField = true
			}
			if _, ok := h["AddressSource"]; ok {
				leases = true
			}
			if _, ok := h["LeaseTimeRemaining"]; ok {
				leases = true
			}
		}
		block := router.CapabilityStatus{Capability: router.CapBlock, Supported: blockField, Mechanism: mechanismBlock}
		switch {
		case len(hosts) == 0:
			block.Note = "the router lists no devices, so per-device blocking cannot be confirmed yet"
		case !blockField:
			block.Note = "this firmware's host list has no Internet Blocking switch"
		default:
			block.Note = "blocks internet access for the device; it stays on the LAN"
		}
		if mf, err := d.macFilterState(ctx); err == nil && truthy(mf.MAC.FilterEnable) && !truthy(mf.MAC.Restrict) {
			block.Note += "; note: the MAC filter is in allow-list mode, so unlisted devices are already refused by the administrator's rule"
		} else if isExpired(err) {
			return err
		}
		lease := router.CapabilityStatus{Capability: router.CapDHCPLeases, Supported: leases}
		if !leases {
			lease.Note = "the host list carries no lease source or remaining time on this firmware"
		}
		probe := func(c router.Capability, oid, mechanism, note string) (router.CapabilityStatus, error) {
			_, err := d.dal(ctx, "capabilities", http.MethodGet, oid, nil)
			switch {
			case err == nil:
				return router.CapabilityStatus{Capability: c, Supported: true, Mechanism: mechanism, Note: note}, nil
			case isExpired(err):
				return router.CapabilityStatus{}, err
			}
			return router.CapabilityStatus{Capability: c, Mechanism: mechanism, Note: "this firmware does not answer DAL " + oid}, nil
		}
		extra := make([]router.CapabilityStatus, 0, 6)
		for _, p := range []struct {
			c                    router.Capability
			oid, mechanism, note string
		}{
			{router.CapOverview, "status", "DAL status (uptime, WAN links)", ""},
			{router.CapWiFi, "wlan", mechanismWiFi, "turn a main or guest Wi-Fi network on or off; Wi-Fi keys are never read"},
			{router.CapReservations, "static_dhcp", mechanismReservation, "the router keeps no owner for a reservation"},
			{router.CapPortForward, "nat", mechanismPortForward, "rules made by LAN Detective are named \"LAN Detective: …\""},
		} {
			cs, err := probe(p.c, p.oid, p.mechanism, p.note)
			if err != nil {
				return err
			}
			if p.c == router.CapOverview && !cs.Supported {
				if c2, err := probe(p.c, "cardpage_status", "DAL cardpage_status (uptime, WAN links)", ""); err != nil {
					return err
				} else if c2.Supported {
					cs = c2
				}
			}
			extra = append(extra, cs)
		}
		rename := router.CapabilityStatus{Capability: router.CapRename, Supported: len(hosts) > 0, Mechanism: mechanismRename,
			Note: "sets the name the router shows for the device; the device itself is not renamed"}
		if len(hosts) == 0 {
			rename.Note = "the router lists no devices yet"
		}
		extra = append(extra, rename, router.CapabilityStatus{Capability: router.CapReboot, Supported: true, Mechanism: mechanismReboot,
			Note: "the router is unreachable for a few minutes and every device reconnects"})
		caps = router.Capabilities{
			{Capability: router.CapClients, Supported: true, Mechanism: "DAL lanhosts"},
			lease,
			block,
			{Capability: router.CapRateLimit, Supported: false,
				Note: "not offered: the firmware only has global QoS classes/policers (a class can match a source MAC), which would change the administrator's QoS setup and limit upload only; not implemented"},
			{Capability: router.CapSchedule, Supported: false,
				Note: "not offered: schedules exist only as parental-control profiles (allowed-time windows) that the administrator owns; not implemented"},
		}
		caps = append(caps, extra...)
		if d.info != nil && !TestedModels[d.info.Model] {
			for i := range caps {
				if caps[i].Supported {
					caps[i].Note = strings.TrimPrefix(caps[i].Note+"; model "+d.info.Model+" is untested with this driver", "; ")
				}
			}
		}
		return nil
	})
	return caps, err
}

func (d *Driver) findHost(ctx context.Context, mac string) (host, error) {
	hosts, err := d.lanhosts(ctx)
	if err != nil {
		return nil, err
	}
	for _, h := range hosts {
		if h.mac() == mac {
			return h, nil
		}
	}
	return nil, &router.Error{Kind: router.ErrNotFound, Op: "lookup", Detail: mac + " is not in the router's device list (it must have connected to this router)"}
}

func (d *Driver) setBlocking(ctx context.Context, action, mac string, want bool) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	d.invalidateCache()
	ch := router.Change{Action: action, MAC: norm, Mechanism: mechanismBlock}
	err = d.withSession(ctx, func() error {
		h, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		cur, ok := h.boolean("Internet_Blocking_Enable")
		if !ok {
			return &router.Error{Kind: router.ErrUnsupported, Op: action, Detail: "this firmware's host list has no Internet Blocking switch"}
		}
		if cur == want {
			ch.Applied, ch.AlreadyInEffect = false, true
			if want {
				ch.Detail = "already blocked on the router before this request; nothing changed (a pre-existing block belongs to the administrator)"
			} else {
				ch.Detail = "not blocked on the router; nothing changed"
			}
			return nil
		}
		// Exactly what the web UI sends for this switch: the current display name and icon are sent
		// back unchanged so only the blocking flag changes.
		name := h.str("curHostName")
		if name == "" {
			name = h.str("DeviceName")
		}
		req := map[string]any{
			"HostName":                 name,
			"DeviceIcon":               h.str("DeviceIcon"),
			"MacAddress":               h.str("PhysAddress"),
			"Internet_Blocking_Enable": want,
		}
		if _, err := d.dal(ctx, action, http.MethodPut, "lanhosts", req); err != nil {
			return err
		}
		d.invalidateCache()
		after, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		if now, _ := after.boolean("Internet_Blocking_Enable"); now != want {
			return &router.Error{Kind: router.ErrRejected, Op: action, Detail: "the router accepted the request but does not show the new state"}
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.Applied {
		if want {
			ch.Detail = "turned on Internet Blocking for " + norm
			ch.Undo = "unblock " + norm + " in LAN Detective (router-probe -unblock " + norm + "), or turn Internet Blocking off for this device in the router's Home Networking > connected devices page"
		} else {
			ch.Detail = "turned off Internet Blocking for " + norm
			ch.Undo = "block " + norm + " again in LAN Detective (router-probe -block " + norm + ")"
		}
	}
	return ch, nil
}

// Block turns on the router's per-device Internet Blocking for mac.
func (d *Driver) Block(ctx context.Context, mac string) (router.Change, error) {
	return d.setBlocking(ctx, "block", mac, true)
}

// Unblock turns it off. Callers must only unblock devices they blocked themselves (see Change.AlreadyInEffect).
func (d *Driver) Unblock(ctx context.Context, mac string) (router.Change, error) {
	return d.setBlocking(ctx, "unblock", mac, false)
}

// Close logs out and wipes the session, even if ctx is already cancelled.
func (d *Driver) Close(ctx context.Context) error {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	err := d.logout(cctx)
	d.http.CloseIdleConnections()
	return err
}

var _ router.Driver = (*Driver)(nil)
