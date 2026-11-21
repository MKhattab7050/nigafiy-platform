package zyxel

// Router-wide settings and the controls beyond block/unblock (docs/features/router-controls.md),
// each taken from the router's own web UI code (the same requests its pages send):
//
//   - overview:      GET  DAL?oid=status (falls back to cardpage_status) -> DeviceInfo.UpTime, WanLanInfo[];
//                    GET  DAL?oid=lan -> the LAN address and mask
//   - Wi-Fi:         GET  DAL?oid=wlan -> Object[] (Index = position + 1, matches lanhosts' Device.WiFi.SSID.<n>);
//                    PUT  DAL?oid=wlan {Index, wlEnable}, then GET /cgi-bin/Wireless?action=WlCheck (the
//                    Connection Status card's own on/off switch)
//   - reservations:  GET/POST DAL?oid=static_dhcp {Index:0, BrWan:"Default", Enable, MACAddr, IPAddr};
//                    DELETE DAL?oid=static_dhcp&Index=<n>
//   - port forward:  GET/POST DAL?oid=nat {Index:0, Enable, Protocol TCP|UDP|ALL, Description, Interface:"",
//                    X_ZYXEL_AutoDetectWanStatus:true, External/InternalPortStart/End, InternalClient,
//                    SetOriginatingIP:false, OriginatingIpAddress:""}; DELETE DAL?oid=nat&Index=<n>
//   - rename:        PUT  DAL?oid=lanhosts {HostName, DeviceIcon, MacAddress, Internet_Blocking_Enable (unchanged)}
//   - reboot:        POST /cgi-bin/Reboot
//
// Fields that carry secrets in these replies (Wi-Fi keys: psk_value, wifiPassword, CurrentPSKValue,
// AutoGenPSKValue; RadiusSecret) are never read into the result.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

const (
	mechanismRename      = "device name (Home Networking > connected devices)"
	mechanismWiFi        = "Wi-Fi network on/off (Network Setting > Wireless)"
	mechanismReservation = "static DHCP table (Network Setting > Home Networking > Static DHCP)"
	mechanismPortForward = "port forwarding (Network Setting > NAT > Port Forwarding)"
	mechanismReboot      = "restart (Maintenance > Reboot)"
	wifiApplyWait        = 45 * time.Second
)

func (h host) integer(k string) (int, bool) {
	switch v := h[k].(type) {
	case float64:
		return int(v), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		return n, err == nil
	}
	return 0, false
}

func objects(rep dalReply) []host {
	out := make([]host, 0, len(rep.Object))
	for _, raw := range rep.Object {
		var h host
		if json.Unmarshal(raw, &h) == nil && h != nil {
			out = append(out, h)
		}
	}
	return out
}

// dalDelete sends DELETE DAL?oid=<oid>&Index=<n> (the web UI passes DELETE parameters in the query).
func (d *Driver) dalDelete(ctx context.Context, op, oid string, index int) error {
	_, err := d.dal(ctx, op, http.MethodDelete, oid+"&Index="+url.QueryEscape(strconv.Itoa(index)), nil)
	return err
}

// ---- reads ----

func (d *Driver) lanPrefix(ctx context.Context) (netip.Prefix, netip.Addr) {
	rep, err := d.dal(ctx, "settings", http.MethodGet, "lan", nil)
	if err != nil {
		return netip.Prefix{}, netip.Addr{}
	}
	for _, o := range objects(rep) {
		ip, err1 := netip.ParseAddr(o.str("IPAddress"))
		mask, err2 := netip.ParseAddr(o.str("SubnetMask"))
		if err1 != nil || !ip.Is4() {
			continue
		}
		bits := 24
		if err2 == nil && mask.Is4() {
			m := mask.As4()
			v := uint32(m[0])<<24 | uint32(m[1])<<16 | uint32(m[2])<<8 | uint32(m[3])
			n := 0
			for v&0x80000000 != 0 {
				n++
				v <<= 1
			}
			if v == 0 && n >= 8 && n <= 30 {
				bits = n
			}
		}
		return netip.PrefixFrom(ip, bits).Masked(), ip
	}
	return netip.Prefix{}, netip.Addr{}
}

func wanStatus(s string) string {
	switch strings.ToLower(s) {
	case "up", "connected":
		return "up"
	case "down", "lowerlayerdown", "disconnected", "error":
		return "down"
	case "connecting", "dormant":
		return "connecting"
	}
	return "unknown"
}

func firstIPv4(v any) string {
	switch t := v.(type) {
	case string:
		if a, err := netip.ParseAddr(strings.TrimSpace(t)); err == nil && a.Is4() && !a.IsUnspecified() {
			return a.String()
		}
	case []any:
		for _, x := range t {
			if s := firstIPv4(x); s != "" {
				return s
			}
		}
	case map[string]any:
		for _, k := range []string{"IPAddress", "DNSServer", "Address"} {
			if s := firstIPv4(t[k]); s != "" {
				return s
			}
		}
	}
	return ""
}

func ipv4List(v any) []string {
	var out []string
	add := func(s string) {
		for _, p := range strings.Split(s, ",") {
			if a := firstIPv4(p); a != "" && len(out) < 4 {
				out = append(out, a)
			}
		}
	}
	switch t := v.(type) {
	case string:
		add(t)
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				add(s)
			} else if s := firstIPv4(x); s != "" && len(out) < 4 {
				out = append(out, s)
			}
		}
	}
	return out
}

func (d *Driver) overview(ctx context.Context, lanIP netip.Addr) (*router.Overview, error) {
	rep, err := d.dal(ctx, "settings", http.MethodGet, "status", nil)
	if isUnsupported(err) {
		rep, err = d.dal(ctx, "settings", http.MethodGet, "cardpage_status", nil)
	}
	if err != nil {
		return nil, err
	}
	objs := objects(rep)
	if len(objs) == 0 {
		return nil, router.Errorf(router.ErrProtocol, "settings", "status reply has no object")
	}
	o := objs[0]
	ov := &router.Overview{}
	if lanIP.IsValid() {
		ov.LANIP = lanIP.String()
	}
	if di, ok := o["DeviceInfo"].(map[string]any); ok {
		if up, ok := host(di).integer("UpTime"); ok && up >= 0 {
			v := int64(up)
			ov.UptimeSeconds = &v
		}
	}
	dns := ipv4List(o["dnsv4Server"])
	wans, _ := o["WanLanInfo"].([]any)
	for _, w := range wans {
		m, ok := w.(map[string]any)
		if !ok {
			continue
		}
		h := host(m)
		if t := strings.ToUpper(h.str("X_ZYXEL_Type")); t == "LAN" {
			continue
		}
		if en, ok := h.boolean("Enable"); ok && !en {
			continue
		}
		name := h.str("X_ZYXEL_SrvName")
		if name == "" {
			name = h.str("Name")
		}
		if name == "" {
			name = h.str("X_ZYXEL_IfName")
		}
		link := router.WANLink{Name: clipText(name, 60), Status: wanStatus(h.str("Status")), Type: clipText(h.str("LinkType"), 20), IPv4: firstIPv4(m["IPv4Address"])}
		if link.Status == "unknown" && strings.EqualFold(h.str("pppConnectionStatus"), "Connected") {
			link.Status = "up"
		}
		if l := ipv4List(m["dnsv4Server"]); len(l) > 0 {
			link.DNS = l
		} else if link.Status == "up" {
			link.DNS = dns
		}
		if up, ok := h.integer("pppoeConnectionUpTime"); ok && up > 0 {
			v := int64(up)
			link.UptimeSeconds = &v
		}
		if link.Name == "" {
			link.Name = "WAN"
		}
		if len(ov.WAN) < 8 {
			ov.WAN = append(ov.WAN, link)
		}
	}
	return ov, nil
}

type wlanEntry struct {
	index int
	h     host
}

func (d *Driver) wlan(ctx context.Context) ([]wlanEntry, error) {
	rep, err := d.dal(ctx, "wifi", http.MethodGet, "wlan", nil)
	if err != nil {
		return nil, err
	}
	var out []wlanEntry
	for i, o := range objects(rep) {
		idx := i + 1
		if v, ok := o.integer("Index"); ok && v > 0 {
			idx = v
		}
		out = append(out, wlanEntry{index: idx, h: o})
	}
	return out, nil
}

func bandOf(h host) string {
	b := strings.ToLower(h.str("band"))
	switch {
	case strings.Contains(b, "2.4"):
		return "2.4GHz"
	case strings.Contains(b, "6"):
		return "6GHz"
	case strings.Contains(b, "5"):
		return "5GHz"
	}
	return clipText(h.str("band"), 20)
}

func (d *Driver) wifiNetworks(ctx context.Context, hosts []host) ([]router.WiFiNetwork, error) {
	entries, err := d.wlan(ctx)
	if err != nil {
		return nil, err
	}
	bySSID := map[int][]string{}
	for _, h := range hosts {
		l1 := h.str("Layer1Interface")
		if n, err := strconv.Atoi(strings.TrimPrefix(l1, "Device.WiFi.SSID.")); err == nil && strings.HasPrefix(l1, "Device.WiFi.SSID.") {
			if active, ok := h.boolean("Active"); !ok || active {
				if m := h.mac(); m != "" {
					bySSID[n] = append(bySSID[n], m)
				}
			}
		}
	}
	out := []router.WiFiNetwork{} // read: empty means none (nil means not read)
	for _, e := range entries {
		ssid := e.h.str("SSID")
		if ssid == "" {
			continue // unused slot
		}
		enabled, _ := e.h.boolean("wlEnable")
		main, _ := e.h.boolean("MainSSID")
		hidden, _ := e.h.boolean("wlHide")
		n := router.WiFiNetwork{ID: strconv.Itoa(e.index), Band: bandOf(e.h), SSID: clipText(ssid, 64), Enabled: enabled, Main: main, Guest: !main,
			Hidden: hidden, Security: clipText(e.h.str("SecurityMode"), 40), ClientMACs: bySSID[e.index]}
		if len(out) < 32 {
			out = append(out, n)
		}
	}
	return out, nil
}

func (d *Driver) reservations(ctx context.Context) ([]router.Reservation, error) {
	rep, err := d.dal(ctx, "reservations", http.MethodGet, "static_dhcp", nil)
	if err != nil {
		return nil, err
	}
	objs := objects(rep)
	out := []router.Reservation{} // read: empty means none (nil means not read)
	for i, o := range objs {
		m, err := router.NormalizeMAC(o.str("MACAddr"))
		if err != nil {
			continue
		}
		idx := i + 1
		if v, ok := o.integer("Index"); ok && v > 0 {
			idx = v
		}
		en, ok := o.boolean("Enable")
		if !ok {
			en = true
		}
		out = append(out, router.Reservation{ID: strconv.Itoa(idx), MAC: m, IP: firstIPv4(o.str("IPAddr")), Enabled: en})
	}
	return out, nil
}

func zyProto(p string) string {
	switch p {
	case router.ProtoTCP:
		return "TCP"
	case router.ProtoUDP:
		return "UDP"
	}
	return "ALL"
}

func (d *Driver) portForwards(ctx context.Context) ([]router.PortForward, error) {
	rep, err := d.dal(ctx, "port_forward", http.MethodGet, "nat", nil)
	if err != nil {
		return nil, err
	}
	out := []router.PortForward{} // read: empty means none (nil means not read)
	for i, o := range objects(rep) {
		idx := i + 1
		if v, ok := o.integer("Index"); ok && v > 0 {
			idx = v
		}
		proto, ok := router.NormalizeProtocol(o.str("Protocol"))
		if !ok {
			proto = router.ProtoBoth
		}
		es, _ := o.integer("ExternalPortStart")
		ee, _ := o.integer("ExternalPortEnd")
		is, _ := o.integer("InternalPortStart")
		ie, _ := o.integer("InternalPortEnd")
		if ee == 0 {
			ee = es
		}
		if ie == 0 {
			ie = is
		}
		en, _ := o.boolean("Enable")
		desc := o.str("Description")
		owner := router.OwnerAdmin
		if strings.HasPrefix(desc, router.ProductRulePrefix) {
			owner = router.OwnerProduct
		}
		out = append(out, router.PortForward{ID: strconv.Itoa(idx), Enabled: en, Description: clipText(desc, 120), Protocol: proto,
			ExternalStart: es, ExternalEnd: ee, InternalStart: is, InternalEnd: ie, InternalIP: firstIPv4(o.str("InternalClient")), Owner: owner})
	}
	return out, nil
}

// Settings reads the overview, Wi-Fi networks, DHCP reservations and port forwards. A part the
// firmware does not offer is left out; a session that expires is retried once (withSession).
func (d *Driver) Settings(ctx context.Context) (router.Settings, error) {
	var s router.Settings
	err := d.withSession(ctx, func() error {
		s = router.Settings{}
		hosts, err := d.lanhosts(ctx)
		if err != nil {
			return err
		}
		_, lanIP := d.lanPrefix(ctx)
		parts := []func() error{
			func() error {
				ov, err := d.overview(ctx, lanIP)
				s.Overview = ov
				return err
			},
			func() error {
				w, err := d.wifiNetworks(ctx, hosts)
				s.WiFi = w
				return err
			},
			func() error {
				r, err := d.reservations(ctx)
				s.Reservations = r
				return err
			},
			func() error {
				p, err := d.portForwards(ctx)
				s.PortForwards = p
				return err
			},
		}
		for _, part := range parts {
			if err := part(); err != nil && !isUnsupported(err) && !errors.Is(err, router.ErrProtocol) {
				return err
			}
		}
		return nil
	})
	return s, err
}

// ---- controls ----

// RenameClient sets the name the router shows for mac, keeping its icon and blocking switch.
func (d *Driver) RenameClient(ctx context.Context, mac, name string) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	clean, err := router.CleanName(name)
	if err != nil {
		return router.Change{}, err
	}
	ch := router.Change{Action: "rename", MAC: norm, Mechanism: mechanismRename}
	var old string
	err = d.withSession(ctx, func() error {
		d.invalidateCache()
		h, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		old = h.str("curHostName")
		if old == "" {
			old = h.str("DeviceName")
		}
		if old == "" {
			old = h.str("HostName")
		}
		if old == clean {
			ch.AlreadyInEffect = true
			return nil
		}
		req := map[string]any{"HostName": clean, "DeviceIcon": h.str("DeviceIcon"), "MacAddress": h.str("PhysAddress")}
		if b, ok := h.boolean("Internet_Blocking_Enable"); ok {
			req["Internet_Blocking_Enable"] = b
		}
		if _, err := d.dal(ctx, "rename", http.MethodPut, "lanhosts", req); err != nil {
			return err
		}
		d.invalidateCache()
		after, err := d.findHost(ctx, norm)
		if err != nil {
			return err
		}
		if got := after.str("curHostName"); got != clean && after.str("DeviceName") != clean && after.str("HostName") != clean {
			return &router.Error{Kind: router.ErrRejected, Op: "rename", Detail: "the router accepted the request but still shows another name"}
		}
		if b, ok := h.boolean("Internet_Blocking_Enable"); ok {
			if a, _ := after.boolean("Internet_Blocking_Enable"); a != b {
				return &router.Error{Kind: router.ErrRejected, Op: "rename", Detail: "renaming changed the device's Internet Blocking switch; check the device on the router"}
			}
		}
		ch.Applied = true
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	if ch.Applied {
		ch.Detail = "renamed " + norm + " on the router from \"" + clipText(old, 63) + "\" to \"" + clean + "\""
		ch.Undo = "rename the device back to \"" + clipText(old, 63) + "\" in LAN Detective or in the router's Home Networking > connected devices page"
	} else {
		ch.Detail = "the router already shows this name; nothing changed"
	}
	return ch, nil
}

// SetWiFiEnabled turns the Wi-Fi network with router index id on or off.
func (d *Driver) SetWiFiEnabled(ctx context.Context, id string, enabled bool) (router.Change, error) {
	idx, err := strconv.Atoi(strings.TrimSpace(id))
	if err != nil || idx < 1 || idx > 64 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "wifi", "unknown Wi-Fi network id")
	}
	ch := router.Change{Action: "wifi", Mechanism: mechanismWiFi}
	var ssid string
	err = d.withSession(ctx, func() error {
		entries, err := d.wlan(ctx)
		if err != nil {
			return err
		}
		var target *wlanEntry
		for i := range entries {
			if entries[i].index == idx && entries[i].h.str("SSID") != "" {
				target = &entries[i]
			}
		}
		if target == nil {
			return &router.Error{Kind: router.ErrNotFound, Op: "wifi", Detail: "the router has no Wi-Fi network " + id}
		}
		ssid = target.h.str("SSID")
		cur, _ := target.h.boolean("wlEnable")
		if cur == enabled {
			ch.AlreadyInEffect = true
			return nil
		}
		if main, _ := target.h.boolean("MainSSID"); !main && enabled {
			for _, e := range entries {
				if m, _ := e.h.boolean("MainSSID"); m && bandOf(e.h) == bandOf(target.h) {
					if on, _ := e.h.boolean("wlEnable"); !on {
						return &router.Error{Kind: router.ErrInvalidArgument, Op: "wifi", Detail: "turn on the main " + bandOf(e.h) + " network first; the router only runs a guest network next to its main network"}
					}
				}
			}
		}
		if _, err := d.dal(ctx, "wifi", http.MethodPut, "wlan", map[string]any{"Index": idx, "wlEnable": enabled}); err != nil {
			return err
		}
		// The web UI then asks the router to apply the wireless change and waits for it.
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		st, body, werr := d.do(cctx, "wifi", http.MethodGet, "/cgi-bin/Wireless?action=WlCheck", nil, false)
		cancel()
		router.Zero(body)
		if werr == nil && (st == http.StatusUnauthorized || st == http.StatusForbidden) {
			return &router.Error{Kind: router.ErrSessionExpired, Op: "wifi"}
		}
		deadline := time.Now().Add(wifiApplyWait)
		for {
			entries, err := d.wlan(ctx)
			if err == nil {
				for _, e := range entries {
					if e.index == idx {
						if now, _ := e.h.boolean("wlEnable"); now == enabled {
							ch.Applied = true
							return nil
						}
					}
				}
			} else if isExpired(err) {
				return err
			}
			if time.Now().After(deadline) {
				return &router.Error{Kind: router.ErrRejected, Op: "wifi", Detail: "the router accepted the request but does not show the new state"}
			}
			select {
			case <-ctx.Done():
				return router.TransportError("wifi", ctx.Err())
			case <-time.After(3 * time.Second):
			}
		}
	})
	if err != nil {
		return router.Change{}, err
	}
	state := map[bool]string{true: "on", false: "off"}
	if ch.Applied {
		ch.Detail = "turned Wi-Fi network \"" + clipText(ssid, 64) + "\" " + state[enabled]
		ch.Undo = "turn \"" + clipText(ssid, 64) + "\" " + state[!enabled] + " again in LAN Detective or in the router's Wireless page"
	} else {
		ch.Detail = "Wi-Fi network \"" + clipText(ssid, 64) + "\" was already " + state[enabled] + "; nothing changed"
	}
	return ch, nil
}

// AddReservation makes the router always give mac the address ip.
func (d *Driver) AddReservation(ctx context.Context, mac, ip string) (router.Change, error) {
	ch := router.Change{Action: "reserve", Mechanism: mechanismReservation}
	err := d.withSession(ctx, func() error {
		lan, routerIP := d.lanPrefix(ctx)
		existing, err := d.reservations(ctx)
		if err != nil {
			return err
		}
		m, addr, err := router.ValidateReservation(mac, ip, existing, lan, routerIP)
		if err != nil {
			return err
		}
		ch.MAC = m
		for _, r := range existing {
			if r.MAC == m {
				if r.IP == addr.String() {
					ch.AlreadyInEffect = true
					ch.Detail = m + " is already reserved to " + r.IP + "; nothing changed"
					return nil
				}
				return &router.Error{Kind: router.ErrInvalidArgument, Op: "reserve", Detail: m + " is already reserved to " + r.IP + "; remove that reservation first"}
			}
		}
		req := map[string]any{"Index": 0, "BrWan": "Default", "Enable": true, "MACAddr": m, "IPAddr": addr.String()}
		if _, err := d.dal(ctx, "reserve", http.MethodPost, "static_dhcp", req); err != nil {
			return err
		}
		after, err := d.reservations(ctx)
		if err != nil {
			return err
		}
		for _, r := range after {
			if r.MAC == m && r.IP == addr.String() {
				ch.Applied = true
				ch.Detail = "reserved " + addr.String() + " for " + m + "; the device gets it at its next DHCP renewal (or reconnect)"
				ch.Undo = "remove the reservation of " + m + " in LAN Detective or in the router's Static DHCP page"
				return nil
			}
		}
		return &router.Error{Kind: router.ErrRejected, Op: "reserve", Detail: "the router accepted the request but does not list the reservation"}
	})
	if err != nil {
		return router.Change{}, err
	}
	return ch, nil
}

// RemoveReservation deletes the reservation of mac.
func (d *Driver) RemoveReservation(ctx context.Context, mac string) (router.Change, error) {
	norm, err := router.NormalizeMAC(mac)
	if err != nil {
		return router.Change{}, err
	}
	ch := router.Change{Action: "unreserve", MAC: norm, Mechanism: mechanismReservation}
	err = d.withSession(ctx, func() error {
		existing, err := d.reservations(ctx)
		if err != nil {
			return err
		}
		var found *router.Reservation
		for i := range existing {
			if existing[i].MAC == norm {
				found = &existing[i]
			}
		}
		if found == nil {
			ch.AlreadyInEffect = true
			ch.Detail = norm + " has no reservation on the router; nothing changed"
			return nil
		}
		idx, _ := strconv.Atoi(found.ID)
		if err := d.dalDelete(ctx, "unreserve", "static_dhcp", idx); err != nil {
			return err
		}
		after, err := d.reservations(ctx)
		if err != nil {
			return err
		}
		for _, r := range after {
			if r.MAC == norm {
				return &router.Error{Kind: router.ErrRejected, Op: "unreserve", Detail: "the router accepted the request but still lists the reservation"}
			}
		}
		ch.Applied = true
		ch.Detail = "removed the reservation of " + found.IP + " for " + norm
		ch.Undo = "reserve " + found.IP + " for " + norm + " again in LAN Detective or in the router's Static DHCP page"
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	return ch, nil
}

func describeRule(r router.PortForward) string {
	s := strings.ToUpper(r.Protocol) + " " + strconv.Itoa(r.ExternalStart)
	if r.ExternalEnd != r.ExternalStart {
		s += "-" + strconv.Itoa(r.ExternalEnd)
	}
	s += " -> " + r.InternalIP + ":" + strconv.Itoa(r.InternalStart)
	if r.InternalEnd != r.InternalStart {
		s += "-" + strconv.Itoa(r.InternalEnd)
	}
	return s
}

// AddPortForward creates a port-forwarding rule on the default WAN, named "LAN Detective: …".
func (d *Driver) AddPortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	ch := router.Change{Action: "add_port_forward", Mechanism: mechanismPortForward}
	err := d.withSession(ctx, func() error {
		lan, routerIP := d.lanPrefix(ctx)
		existing, err := d.portForwards(ctx)
		if err != nil {
			return err
		}
		r, err := router.ValidatePortForward(rule, existing, lan, routerIP)
		if err != nil {
			return err
		}
		req := map[string]any{
			"Index": 0, "Enable": true, "Protocol": zyProto(r.Protocol), "Description": r.Description,
			"Interface": "", "X_ZYXEL_AutoDetectWanStatus": true,
			"ExternalPortStart": r.ExternalStart, "ExternalPortEnd": r.ExternalEnd,
			"InternalPortStart": r.InternalStart, "InternalPortEnd": r.InternalEnd,
			"InternalClient": r.InternalIP, "SetOriginatingIP": false, "OriginatingIpAddress": "",
		}
		if _, err := d.dal(ctx, "add_port_forward", http.MethodPost, "nat", req); err != nil {
			return err
		}
		after, err := d.portForwards(ctx)
		if err != nil {
			return err
		}
		for _, a := range after {
			if router.SameRule(a, r) {
				ch.Applied = true
				ch.Detail = "added port forward " + describeRule(r) + " (" + r.Description + ")"
				ch.Undo = "remove the rule \"" + r.Description + "\" in LAN Detective or in the router's NAT > Port Forwarding page"
				return nil
			}
		}
		return &router.Error{Kind: router.ErrRejected, Op: "add_port_forward", Detail: "the router accepted the request but does not list the rule"}
	})
	if err != nil {
		return router.Change{}, err
	}
	return ch, nil
}

// RemovePortForward deletes the rule with rule.ID, only if the router's rule still matches rule.
func (d *Driver) RemovePortForward(ctx context.Context, rule router.PortForward) (router.Change, error) {
	idx, err := strconv.Atoi(strings.TrimSpace(rule.ID))
	if err != nil || idx < 1 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "remove_port_forward", "unknown rule id")
	}
	ch := router.Change{Action: "remove_port_forward", Mechanism: mechanismPortForward}
	err = d.withSession(ctx, func() error {
		existing, err := d.portForwards(ctx)
		if err != nil {
			return err
		}
		var found *router.PortForward
		for i := range existing {
			if existing[i].ID == rule.ID {
				found = &existing[i]
			}
		}
		if found == nil || !router.SameRule(*found, rule) {
			return &router.Error{Kind: router.ErrNotFound, Op: "remove_port_forward", Detail: "the rule changed on the router; refresh and try again"}
		}
		if err := d.dalDelete(ctx, "remove_port_forward", "nat", idx); err != nil {
			return err
		}
		after, err := d.portForwards(ctx)
		if err != nil {
			return err
		}
		for _, a := range after {
			if router.SameRule(a, *found) && a.Description == found.Description {
				return &router.Error{Kind: router.ErrRejected, Op: "remove_port_forward", Detail: "the router accepted the request but still lists the rule"}
			}
		}
		ch.Applied = true
		ch.Detail = "removed port forward " + describeRule(*found) + " (" + clipText(found.Description, 120) + ")"
		ch.Undo = "add it again: " + describeRule(*found) + ", description \"" + clipText(found.Description, 120) + "\""
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	return ch, nil
}

// Reboot asks the router to restart. The session ends with the restart.
func (d *Driver) Reboot(ctx context.Context) (router.Change, error) {
	ch := router.Change{Action: "reboot", Mechanism: mechanismReboot}
	err := d.withSession(ctx, func() error {
		st, body, err := d.do(ctx, "reboot", http.MethodPost, "/cgi-bin/Reboot", nil, true)
		defer router.Zero(body)
		if err != nil {
			return err
		}
		if st == http.StatusUnauthorized || st == http.StatusForbidden {
			return &router.Error{Kind: router.ErrSessionExpired, Op: "reboot"}
		}
		if st != http.StatusOK {
			return router.Errorf(router.ErrRejected, "reboot", "HTTP %d", st)
		}
		var rep dalReply
		if json.Unmarshal(body, &rep) == nil && rep.Result != "" && rep.Result != "ZCFG_SUCCESS" {
			return router.Errorf(router.ErrRejected, "reboot", "result %q", truncate(rep.Result, 60))
		}
		return nil
	})
	if err != nil {
		return router.Change{}, err
	}
	d.invalidateCache()
	d.sess.wipe() // the restart ends the session; Close then has nothing to log out
	ch.Applied = true
	ch.Detail = "the router accepted the restart; it is unreachable for a few minutes and every device reconnects afterwards"
	ch.Undo = "a restart cannot be undone; the router comes back by itself"
	return ch, nil
}

func clipText(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

var (
	_ router.SettingsReader     = (*Driver)(nil)
	_ router.Renamer            = (*Driver)(nil)
	_ router.WiFiController     = (*Driver)(nil)
	_ router.ReservationManager = (*Driver)(nil)
	_ router.PortForwarder      = (*Driver)(nil)
	_ router.Rebooter           = (*Driver)(nil)
)
