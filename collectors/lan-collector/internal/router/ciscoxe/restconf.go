package ciscoxe

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// RESTCONF writes (RFC 8040) on the Cisco-IOS-XE-native YANG model. Sources, all IOS XE 16.x/17.x:
//   - Cisco "Programmability Configuration Guide, Cisco IOS XE" (RESTCONF chapter: PATCH merges, PUT
//     replaces one list entry, DELETE removes it, each request is one transaction validated against
//     the YANG model; an invalid payload is refused with HTTP 400 and changes nothing);
//   - the published models in github.com/YangModels/yang, vendor/cisco/xe/<release>:
//     Cisco-IOS-XE-native, -acl (ip access-list extended, access-group), -dhcp (ip dhcp pool),
//     -nat (ip nat inside source static), -policy (class-map, policy-map, service-policy) and
//     cisco-ia (the save-config RPC = "write memory").
//
// Every write follows the same rules: only objects whose names start with "NIGAFIY-" are created,
// replaced or deleted; the administrator's ACLs, policies, pools and NAT rules are read, never
// changed; an interface that already carries the administrator's ACL or service policy is refused;
// the result is read back; "write memory" (save-config) runs only after the change was read back.
// None of this ran against a real IOS XE device here: it is tested with the RESTCONF protocol
// double in controls_test.go.

const (
	nativePath = "/restconf/data/Cisco-IOS-XE-native:native"
	saveRPC    = "/restconf/operations/cisco-ia:save-config"
	// productPrefix names every object Nigafiy creates on an IOS XE router.
	productPrefix = "NIGAFIY-"
	// minWriteMajor/minWriteMinor: RESTCONF configuration writes on the native model need IOS XE 16.6.
	minWriteMajor, minWriteMinor = 16, 6
)

// do sends one RESTCONF request with a JSON body (nil: none).
func (d *Driver) do(ctx context.Context, op, method, path string, body any) (int, []byte, error) {
	if err := d.ensureAuth(ctx); err != nil {
		return 0, nil, err
	}
	var rd *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request body")
		}
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, rd)
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Authorization", string(d.authHeader))
	req.Header.Set("Accept", yangJSON)
	if body != nil {
		req.Header.Set("Content-Type", yangJSON)
	}
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

// restconfError is the first error-message (or error-tag) of an RFC 8040 error body.
func restconfError(raw []byte) (tag, msg string) {
	var e struct {
		Errors struct {
			Error []struct {
				Tag     string `json:"error-tag"`
				Message string `json:"error-message"`
			} `json:"error"`
		} `json:"ietf-restconf:errors"`
	}
	if json.Unmarshal(raw, &e) == nil && len(e.Errors.Error) > 0 {
		return e.Errors.Error[0].Tag, clipText(e.Errors.Error[0].Message, 160)
	}
	return "", ""
}

func clipText(s string, n int) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r != 0x7f {
			b.WriteRune(r)
		}
		if b.Len() >= n {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

// write sends a change and maps a refusal to an error that names the feature. A model the device
// does not know (HTTP 404 on the path, or an "unknown-element"/"unknown-namespace" refusal) means this
// IOS XE version lacks the feature over RESTCONF: ErrUnsupported, nothing changed.
func (d *Driver) write(ctx context.Context, op, feature, method, path string, body any) error {
	st, raw, err := d.do(ctx, op, method, path, body)
	if err != nil {
		return err
	}
	if st >= 200 && st < 300 {
		return nil
	}
	tag, msg := restconfError(raw)
	fw := "this IOS XE version"
	if d.info != nil && d.info.Firmware != "" {
		fw = "IOS XE " + d.info.Firmware
	}
	if st == http.StatusNotFound && method != http.MethodDelete || tag == "unknown-element" || tag == "unknown-namespace" || tag == "operation-not-supported" {
		return router.Errorf(router.ErrUnsupported, op, "%s does not offer %s over RESTCONF (HTTP %d %s); nothing was changed", fw, feature, st, first(msg, tag))
	}
	if msg == "" {
		msg = "HTTP " + strconv.Itoa(st)
	}
	return router.Errorf(router.ErrRejected, op, "the router refused the %s change (%s); nothing was changed", feature, msg)
}

// save runs "write memory" (cisco-ia:save-config). Called only after a change was read back.
func (d *Driver) save(ctx context.Context, op string) error {
	st, raw, err := d.do(ctx, op, http.MethodPost, saveRPC, map[string]any{})
	if err != nil {
		return err
	}
	if st < 200 || st >= 300 {
		_, msg := restconfError(raw)
		return router.Errorf(router.ErrRejected, op, "the change is active but \"write memory\" (cisco-ia:save-config) failed (%s); it is lost at the next restart unless saved", first(msg, "HTTP "+strconv.Itoa(st)))
	}
	return nil
}

// versionAtLeast reports whether an IOS XE version string ("17.9", "16.12.4", "17.09.04a") is at
// least major.minor; ok is false when the version cannot be read.
func versionAtLeast(v string, major, minor int) (atLeast, ok bool) {
	parts := strings.Split(strings.TrimSpace(v), ".")
	if len(parts) < 2 {
		return false, false
	}
	num := func(s string) (int, bool) {
		end := 0
		for end < len(s) && s[end] >= '0' && s[end] <= '9' {
			end++
		}
		n, err := strconv.Atoi(s[:end])
		return n, err == nil
	}
	ma, ok1 := num(parts[0])
	mi, ok2 := num(parts[1])
	if !ok1 || !ok2 {
		return false, false
	}
	return ma > major || (ma == major && mi >= minor), true
}

// iface is one interface of the native configuration, as far as the controls need it.
type iface struct {
	Type    string // YANG list name: GigabitEthernet, Vlan, ...
	Name    string // "0/0/1", "10"
	Addr    netip.Addr
	Prefix  netip.Prefix
	ACLIn   string
	PolicyI string
	PolicyO string
	NATIn   bool
	NATOut  bool
}

func (i iface) path() string {
	return nativePath + "/interface/" + i.Type + "=" + url.PathEscape(i.Name)
}

func (i iface) label() string { return i.Type + i.Name }

func maskBits(mask string) int {
	a, err := netip.ParseAddr(mask)
	if err != nil || !a.Is4() {
		return -1
	}
	b := a.As4()
	v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	n := 0
	for v&0x80000000 != 0 {
		n++
		v <<= 1
	}
	if v != 0 {
		return -1
	}
	return n
}

// interfaces reads the configured interfaces (native/interface).
func (d *Driver) interfaces(ctx context.Context, op string) ([]iface, error) {
	st, raw, err := d.do(ctx, op, http.MethodGet, nativePath+"/interface", nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNotFound {
		return nil, router.Errorf(router.ErrUnsupported, op, "this IOS XE release does not offer the interface configuration (Cisco-IOS-XE-native:native/interface) over RESTCONF, so the LAN interface is unknown")
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "the interface configuration could not be read (HTTP %d)", st)
	}
	var rep struct {
		Types map[string][]struct {
			Name any `json:"name"`
			IP   struct {
				Address struct {
					Primary struct {
						Address string `json:"address"`
						Mask    string `json:"mask"`
					} `json:"primary"`
				} `json:"address"`
				AccessGroup struct {
					In struct {
						ACL struct {
							Name string `json:"acl-name"`
						} `json:"acl"`
					} `json:"in"`
				} `json:"access-group"`
				NAT struct {
					Inside  json.RawMessage `json:"inside"`
					Outside json.RawMessage `json:"outside"`
				} `json:"Cisco-IOS-XE-nat:nat"`
			} `json:"ip"`
			Policy struct {
				Input  string `json:"input"`
				Output string `json:"output"`
			} `json:"Cisco-IOS-XE-policy:service-policy"`
		} `json:"Cisco-IOS-XE-native:interface"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "not a Cisco IOS XE interface configuration")
	}
	var out []iface
	for typ, list := range rep.Types {
		for _, it := range list {
			name := strings.Trim(strings.TrimSpace(jsonScalar(it.Name)), "\"")
			x := iface{Type: typ, Name: name, ACLIn: it.IP.AccessGroup.In.ACL.Name, PolicyI: it.Policy.Input, PolicyO: it.Policy.Output,
				NATIn: len(it.IP.NAT.Inside) > 0, NATOut: len(it.IP.NAT.Outside) > 0}
			if a, err := netip.ParseAddr(it.IP.Address.Primary.Address); err == nil && a.Is4() {
				x.Addr = a
				if bits := maskBits(it.IP.Address.Primary.Mask); bits >= 0 {
					x.Prefix = netip.PrefixFrom(a, bits).Masked()
				}
			}
			out = append(out, x)
		}
	}
	return out, nil
}

func jsonScalar(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}

// lan is the interface that carries the router's own (target) address: the LAN the Sensor reaches.
func (d *Driver) lan(ctx context.Context, op string) (iface, error) {
	all, err := d.interfaces(ctx, op)
	if err != nil {
		return iface{}, err
	}
	for _, i := range all {
		if i.Addr == d.target.Address && i.Prefix.IsValid() {
			return i, nil
		}
	}
	return iface{}, router.Errorf(router.ErrUnsupported, op, "no interface has the router address %s as its primary address, so Nigafiy cannot tell which interface is the LAN", d.target.Address)
}

// writable checks the firmware version before any change.
func (d *Driver) writable(ctx context.Context, op string) error {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return err
		}
	}
	ok, known := versionAtLeast(d.info.Firmware, minWriteMajor, minWriteMinor)
	if !known || !ok {
		return router.Errorf(router.ErrUnsupported, op, "router changes over RESTCONF need IOS XE 16.6 or later (this router reports %q)", d.info.Firmware)
	}
	return nil
}

func macKey(mac string) string { return strings.ToUpper(strings.ReplaceAll(mac, ":", "")) }

// ciscoDotted is the IOS form of a MAC address ("aabb.ccdd.eeff").
func ciscoDotted(mac string) string {
	h := strings.ReplaceAll(mac, ":", "")
	return h[0:4] + "." + h[4:8] + "." + h[8:12]
}

// clientIP is the address the router currently has for mac (ARP or DHCP), or ErrNotFound.
func (d *Driver) clientIP(ctx context.Context, op, mac string) (netip.Addr, error) {
	cs, err := d.Clients(ctx)
	if err != nil {
		return netip.Addr{}, err
	}
	for _, c := range cs {
		if c.MAC == mac {
			if a, err := netip.ParseAddr(c.IP); err == nil && a.Is4() {
				return a, nil
			}
		}
	}
	return netip.Addr{}, router.Errorf(router.ErrNotFound, op, "the router has no IPv4 address for %s in its ARP table or DHCP bindings", mac)
}
