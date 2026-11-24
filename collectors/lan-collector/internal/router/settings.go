package router

import (
	"context"
	"fmt"
	"net/netip"
	"strings"
	"unicode"
)

// Router-wide settings and the controls beyond block/unblock (docs/features/router-controls.md).
// Every one is optional: a driver implements the interfaces for what its router offers and reports
// the matching capability. Secrets (Wi-Fi keys, RADIUS secrets, passwords) never appear here.

// WANLink is one internet connection of the router.
type WANLink struct {
	Name          string   `json:"name"`
	Status        string   `json:"status"` // "up", "down", "connecting", "unknown"
	Type          string   `json:"type,omitempty"`
	IPv4          string   `json:"ipv4,omitempty"`
	DNS           []string `json:"dns,omitempty"`
	UptimeSeconds *int64   `json:"uptime_seconds,omitempty"`
}

// Overview is the router's own status summary.
type Overview struct {
	UptimeSeconds *int64    `json:"uptime_seconds,omitempty"`
	LANIP         string    `json:"lan_ip,omitempty"`
	WAN           []WANLink `json:"wan,omitempty"`
}

// WiFiNetwork is one SSID the router broadcasts (or can broadcast).
type WiFiNetwork struct {
	ID       string `json:"id"`
	Band     string `json:"band,omitempty"`
	SSID     string `json:"ssid"`
	Enabled  bool   `json:"enabled"`
	Main     bool   `json:"main"`
	Guest    bool   `json:"guest"`
	Hidden   bool   `json:"hidden"`
	Security string `json:"security,omitempty"`
	// ClientMACs are the clients the router currently shows on this network (lower-case colon form).
	ClientMACs []string `json:"client_macs,omitempty"`
}

// Reservation is a DHCP reservation: the router always gives MAC the address IP.
type Reservation struct {
	ID      string `json:"id"`
	MAC     string `json:"mac"`
	IP      string `json:"ip"`
	Enabled bool   `json:"enabled"`
}

// Port-forward protocols.
const (
	ProtoTCP  = "tcp"
	ProtoUDP  = "udp"
	ProtoBoth = "both"
)

// PortForward is one port-forwarding (virtual server) rule.
type PortForward struct {
	ID            string `json:"id,omitempty"`
	Enabled       bool   `json:"enabled"`
	Description   string `json:"description"`
	Protocol      string `json:"protocol"`
	ExternalStart int    `json:"external_start"`
	ExternalEnd   int    `json:"external_end"`
	InternalStart int    `json:"internal_start"`
	InternalEnd   int    `json:"internal_end"`
	InternalIP    string `json:"internal_ip"`
	Owner         Owner  `json:"owner,omitempty"`
}

// ProductRulePrefix marks rules this product creates, so they are recognisable on the router. It is
// persisted on routers, so it keeps the name from before the rename (docs/architecture/naming.md).
const ProductRulePrefix = "LAN Detective: "

// Settings is what SettingsReader reports. A nil/empty part was not offered or not readable.
type Settings struct {
	Overview     *Overview     `json:"overview,omitempty"`
	WiFi         []WiFiNetwork `json:"wifi,omitempty"`
	Reservations []Reservation `json:"reservations,omitempty"`
	PortForwards []PortForward `json:"port_forwards,omitempty"`
}

// SettingsReader reads router-wide settings (CapOverview, CapWiFi, CapReservations, CapPortForward).
type SettingsReader interface {
	Settings(ctx context.Context) (Settings, error)
}

// Renamer sets the name the router shows for a client (CapRename).
type Renamer interface {
	RenameClient(ctx context.Context, mac, name string) (Change, error)
}

// WiFiController turns one Wi-Fi network on or off (CapWiFi).
type WiFiController interface {
	SetWiFiEnabled(ctx context.Context, id string, enabled bool) (Change, error)
}

// ReservationManager adds and removes DHCP reservations (CapReservations).
type ReservationManager interface {
	AddReservation(ctx context.Context, mac, ip string) (Change, error)
	RemoveReservation(ctx context.Context, mac string) (Change, error)
}

// PortForwarder adds and removes port-forwarding rules (CapPortForward). RemovePortForward gets the
// rule as the operator saw it and refuses if the router's rule with that ID no longer matches.
type PortForwarder interface {
	AddPortForward(ctx context.Context, rule PortForward) (Change, error)
	RemovePortForward(ctx context.Context, rule PortForward) (Change, error)
}

// Rebooter restarts the router (CapReboot). It returns once the router accepted the request.
type Rebooter interface {
	Reboot(ctx context.Context) (Change, error)
}

// ReservedManagementPorts are never forwarded: the router's own web, SSH, Telnet and TR-069 ports.
var ReservedManagementPorts = []int{22, 23, 80, 443, 7547}

// MaxPortsPerRule bounds one port-forward rule.
const MaxPortsPerRule = 1000

// CleanName validates a device name for Renamer: trimmed, 1–63 characters, no control characters.
func CleanName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" || len([]rune(n)) > 63 {
		return "", Errorf(ErrInvalidArgument, "rename", "the name must be 1 to 63 characters")
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return "", Errorf(ErrInvalidArgument, "rename", "the name contains control characters")
		}
	}
	return n, nil
}

// CleanHostname validates a name for routers that store a rename as a DHCP host name (an RFC 1123
// label: 1–63 letters, digits and hyphens, not starting or ending with a hyphen). Such routers refuse
// anything else (pfSense HostnameValidator, OPNsense Kea HostnameField, the DHCP option 12 the name
// is handed out in), so the name is refused here, before anything is sent, with a message that says why.
func CleanHostname(name string) (string, error) {
	n, err := CleanName(name)
	if err != nil {
		return "", err
	}
	for i, r := range n {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || (r == '-' && i > 0 && i < len(n)-1)
		if !ok {
			return "", Errorf(ErrInvalidArgument, "rename", "this router stores the name as a DHCP host name: use only letters, digits and hyphens (no spaces), not starting or ending with a hyphen")
		}
	}
	return n, nil
}

// NormalizeProtocol maps "tcp", "udp", "both" (and "tcp/udp", "all") to the canonical names.
func NormalizeProtocol(p string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "tcp":
		return ProtoTCP, true
	case "udp":
		return ProtoUDP, true
	case "both", "all", "tcp/udp", "tcpudp", "tcp_udp":
		return ProtoBoth, true
	}
	return "", false
}

func protoOverlap(a, b string) bool { return a == b || a == ProtoBoth || b == ProtoBoth }

// ValidatePortForward checks a new rule against the generic rules and the router's existing rules.
// lan is the router's LAN prefix (zero: unknown, then only "private IPv4" is required) and
// routerIP the router's own LAN address (zero: unknown). It returns the rule with a canonical protocol.
func ValidatePortForward(rule PortForward, existing []PortForward, lan netip.Prefix, routerIP netip.Addr) (PortForward, error) {
	bad := func(format string, a ...any) (PortForward, error) {
		return PortForward{}, Errorf(ErrInvalidArgument, "port_forward", format, a...)
	}
	proto, ok := NormalizeProtocol(rule.Protocol)
	if !ok {
		return bad("protocol must be tcp, udp or both")
	}
	rule.Protocol = proto
	if rule.ExternalEnd == 0 {
		rule.ExternalEnd = rule.ExternalStart
	}
	if rule.InternalStart == 0 {
		rule.InternalStart = rule.ExternalStart
	}
	if rule.InternalEnd == 0 {
		rule.InternalEnd = rule.InternalStart + (rule.ExternalEnd - rule.ExternalStart)
	}
	for _, p := range []int{rule.ExternalStart, rule.ExternalEnd, rule.InternalStart, rule.InternalEnd} {
		if p < 1 || p > 65535 {
			return bad("ports must be between 1 and 65535")
		}
	}
	if rule.ExternalEnd < rule.ExternalStart || rule.InternalEnd < rule.InternalStart {
		return bad("a port range must end at or after its start")
	}
	if rule.ExternalEnd-rule.ExternalStart != rule.InternalEnd-rule.InternalStart {
		return bad("the external and internal ranges must have the same number of ports")
	}
	if rule.ExternalEnd-rule.ExternalStart+1 > MaxPortsPerRule {
		return bad("at most %d ports per rule", MaxPortsPerRule)
	}
	for _, p := range ReservedManagementPorts {
		if p >= rule.ExternalStart && p <= rule.ExternalEnd {
			return bad("external port %d is the router's own management port and is never forwarded", p)
		}
	}
	ip, err := netip.ParseAddr(rule.InternalIP)
	if err != nil || !ip.Is4() || !ip.IsPrivate() {
		return bad("the internal address must be a private IPv4 address on the LAN")
	}
	if lan.IsValid() && !lan.Contains(ip) {
		return bad("%s is not on the router's LAN (%s)", ip, lan)
	}
	if routerIP.IsValid() && ip == routerIP {
		return bad("the internal address is the router itself")
	}
	for _, e := range existing {
		if protoOverlap(e.Protocol, rule.Protocol) && rule.ExternalStart <= e.ExternalEnd && e.ExternalStart <= rule.ExternalEnd {
			return bad("external ports %d-%d overlap the existing rule %q (%d-%d)", rule.ExternalStart, rule.ExternalEnd, e.Description, e.ExternalStart, e.ExternalEnd)
		}
	}
	desc := strings.TrimSpace(strings.TrimPrefix(rule.Description, ProductRulePrefix))
	if desc == "" {
		desc = fmt.Sprintf("%s %d", rule.Protocol, rule.ExternalStart)
	}
	if len([]rune(desc)) > 60 {
		return bad("the description must be at most 60 characters")
	}
	for _, r := range desc {
		if unicode.IsControl(r) {
			return bad("the description contains control characters")
		}
	}
	rule.Description = ProductRulePrefix + desc
	rule.Enabled = true
	rule.Owner = OwnerProduct
	return rule, nil
}

// SameRule reports whether two rules forward the same thing (protocol, external range, internal address and ports).
func SameRule(a, b PortForward) bool {
	pa, _ := NormalizeProtocol(a.Protocol)
	pb, _ := NormalizeProtocol(b.Protocol)
	return pa == pb && a.ExternalStart == b.ExternalStart && a.ExternalEnd == b.ExternalEnd &&
		a.InternalIP == b.InternalIP && a.InternalStart == b.InternalStart && a.InternalEnd == b.InternalEnd
}

// ValidateReservation checks a new reservation: an IPv4 on the LAN that is not the router, not the
// network or broadcast address and not reserved to another MAC.
func ValidateReservation(mac, ip string, existing []Reservation, lan netip.Prefix, routerIP netip.Addr) (string, netip.Addr, error) {
	m, err := NormalizeMAC(mac)
	if err != nil {
		return "", netip.Addr{}, err
	}
	bad := func(format string, a ...any) (string, netip.Addr, error) {
		return "", netip.Addr{}, Errorf(ErrInvalidArgument, "reserve", format, a...)
	}
	a, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil || !a.Is4() || !a.IsPrivate() {
		return bad("the address must be a private IPv4 address on the LAN")
	}
	if lan.IsValid() {
		lan = lan.Masked()
		if !lan.Contains(a) {
			return bad("%s is not on the router's LAN (%s)", a, lan)
		}
		if a == lan.Addr() || (lan.Bits() < 31 && a == lastAddr(lan)) {
			return bad("%s is the network or broadcast address", a)
		}
	}
	if routerIP.IsValid() && a == routerIP {
		return bad("%s is the router itself", a)
	}
	for _, r := range existing {
		if r.IP == a.String() && r.MAC != m {
			return bad("%s is already reserved for %s", a, r.MAC)
		}
	}
	return m, a, nil
}

func lastAddr(p netip.Prefix) netip.Addr {
	b := p.Addr().As4()
	host := uint32(1)<<(32-p.Bits()) - 1
	v := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])) | host
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)})
}
