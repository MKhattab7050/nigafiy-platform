// Package router is the collector's vendor-neutral way to read and control the routers, firewalls
// and access points of a site: who is connected (the router's own client list and DHCP leases),
// blocking and unblocking one device, and optional extras such as rate limits and schedules.
//
// A site can have several routers. Each one is described by a Target (its own address, vendor,
// transport and certificate pin) and reached through a Driver opened with Open. Every operation is
// therefore addressed to one specific router. Vendor-specific behaviour lives entirely in driver
// packages (internal/router/zyxel, ...), which register themselves with Register; callers never
// import a driver's internals.
//
// Safety rules every driver follows:
//   - the router's address must be private and inside a scope the site authorized (Authorize);
//   - the HTTP/TLS client never leaves that one address (no redirects, fixed dialer);
//   - TLS is verified, either normally or against an explicit certificate pin; plain HTTP is an
//     explicit opt-in;
//   - credentials come from a CredentialSource only when a login is needed, are zeroed after use and
//     are never logged, printed or put in an error;
//   - changes are minimal and reversible, every Change says how to undo it, and Close logs out.
package router

import (
	"context"
	"net"
	"net/netip"
	"sort"
	"strings"
	"time"
)

// Capability names are deliberately general so that MikroTik RouterOS, enterprise firewalls and
// managed access points can report the same vocabulary.
type Capability string

const (
	CapClients    Capability = "clients"     // the router's own list of connected clients
	CapDHCPLeases Capability = "dhcp_leases" // lease details (address source, remaining time) on clients
	CapBlock      Capability = "block"       // Block / Unblock / Blocked
	CapRateLimit  Capability = "rate_limit"  // the driver implements RateLimiter
	CapSchedule   Capability = "schedule"    // the driver implements Scheduler

	CapOverview     Capability = "overview"     // SettingsReader reports Settings.Overview (uptime, WAN links)
	CapWiFi         Capability = "wifi"         // SettingsReader lists Wi-Fi networks; the driver implements WiFiController
	CapReservations Capability = "reservations" // SettingsReader lists DHCP reservations; the driver implements ReservationManager
	CapPortForward  Capability = "port_forward" // SettingsReader lists port forwards; the driver implements PortForwarder
	CapRename       Capability = "rename"       // the driver implements Renamer
	CapReboot       Capability = "reboot"       // the driver implements Rebooter
)

// AllCapabilities in display order.
var AllCapabilities = []Capability{CapClients, CapDHCPLeases, CapBlock, CapRateLimit, CapSchedule, CapOverview, CapWiFi, CapReservations, CapPortForward, CapRename, CapReboot}

// RequiresReservation (CapabilityStatus.Requires): the control acts on the device's DHCP reservation,
// so the device needs one on the router first (e.g. a rename stored as the reservation's host name).
const RequiresReservation = "reservation"

// CapabilityStatus says whether this router, with this firmware, can do one thing, and why not.
type CapabilityStatus struct {
	Capability Capability `json:"capability"`
	Supported  bool       `json:"supported"`
	// Mechanism names the router feature used, e.g. "per-device internet blocking".
	Mechanism string `json:"mechanism,omitempty"`
	// Note explains a refusal or a limitation in words an administrator understands.
	Note string `json:"note,omitempty"`
	// Requires names what the device needs on the router before the control applies (RequiresReservation:
	// a rename that is stored on the device's DHCP reservation). Empty: nothing beyond the capability.
	Requires string `json:"requires,omitempty"`
}

// Capabilities is the report a caller consults before offering an action in the UI.
type Capabilities []CapabilityStatus

// Supports reports whether c is supported.
func (cs Capabilities) Supports(c Capability) bool {
	for _, s := range cs {
		if s.Capability == c {
			return s.Supported
		}
	}
	return false
}

// Get returns the status of c (a zero, unsupported status if the driver did not report it).
func (cs Capabilities) Get(c Capability) CapabilityStatus {
	for _, s := range cs {
		if s.Capability == c {
			return s
		}
	}
	return CapabilityStatus{Capability: c, Note: "not reported by the driver"}
}

// Info identifies a router.
type Info struct {
	Vendor   string `json:"vendor"`
	Model    string `json:"model"`
	Firmware string `json:"firmware"`
	// Extra holds further identification the router volunteers (e.g. language, serial number).
	Extra map[string]string `json:"extra,omitempty"`
}

// ConnectionType is how a client reaches the router.
type ConnectionType string

const (
	ConnWired   ConnectionType = "wired"
	ConnWiFi24  ConnectionType = "wifi_2.4ghz"
	ConnWiFi5   ConnectionType = "wifi_5ghz"
	ConnWiFi6   ConnectionType = "wifi_6ghz"
	ConnWiFi    ConnectionType = "wifi" // wireless, band not given
	ConnUnknown ConnectionType = "unknown"
)

// Lease is DHCP information the router gives for a client, where it gives it.
type Lease struct {
	// Source is how the client got its address: "dhcp", "static" (configured on the client) or
	// "reserved" (a DHCP reservation); empty if not given.
	Source string `json:"source,omitempty"`
	// Remaining time of the lease; nil if not given.
	Remaining *time.Duration `json:"remaining,omitempty"`
}

// Client is one entry of the router's own client list.
type Client struct {
	MAC        string         `json:"mac"` // lower-case, colon separated
	IP         string         `json:"ip,omitempty"`
	Hostname   string         `json:"hostname,omitempty"`
	Connection ConnectionType `json:"connection"`
	// Interface is the router-side port or SSID name where given.
	Interface string `json:"interface,omitempty"`
	// SignalDBm is the received signal strength of a wireless client, where given.
	SignalDBm *int `json:"signal_dbm,omitempty"`
	// Active is false for clients the router remembers but does not currently see; nil if unknown.
	Active *bool  `json:"active,omitempty"`
	Lease  *Lease `json:"lease,omitempty"`
	// Blocked is the router's own block state for this client, where the router reports it per client.
	Blocked *bool `json:"blocked,omitempty"`
	// Raw is every field the router returned for this client, as text, so an administrator can
	// compare it with the router's own web page. It never contains credentials.
	Raw map[string]string `json:"raw,omitempty"`
}

// Owner says who created a block entry, as far as the driver can tell.
type Owner string

const (
	OwnerProduct Owner = "lan-detective" // created by this product (tagged/named recognisably)
	OwnerAdmin   Owner = "administrator" // a rule the administrator made; never modified by us
	OwnerUnknown Owner = "unknown"       // the router keeps no owner (e.g. a per-device switch)
)

// BlockEntry is one thing on the router that currently stops a device from using the network.
type BlockEntry struct {
	MAC       string `json:"mac"`
	Name      string `json:"name,omitempty"`
	Mechanism string `json:"mechanism"`
	Owner     Owner  `json:"owner"`
	// Partial is true when the entry only restricts some of the time or some services
	// (e.g. a parental-control schedule) rather than blocking outright.
	Partial bool   `json:"partial,omitempty"`
	Detail  string `json:"detail,omitempty"`
	// Managed is true if Unblock can remove this entry (it uses the mechanism Block uses).
	Managed bool `json:"managed"`
}

// Change describes what a control operation did on the router.
type Change struct {
	Action    string `json:"action"` // "block", "unblock", "rate_limit", ...
	MAC       string `json:"mac"`
	Mechanism string `json:"mechanism"`
	// Applied is false when nothing had to change (the router was already in the requested state).
	Applied bool `json:"applied"`
	// AlreadyInEffect is true when the requested state existed before this call. For Block, a caller
	// that keeps a ledger must NOT record such a block as its own, so it never lifts a block the
	// administrator made.
	AlreadyInEffect bool   `json:"already_in_effect"`
	Detail          string `json:"detail"`
	// Undo tells an administrator how to reverse the change, in the product and on the router itself.
	Undo string `json:"undo,omitempty"`
}

// RateLimit is a speed limit for one client, in kbit/s; 0 means "no limit in that direction".
type RateLimit struct {
	DownKbps int `json:"down_kbps"`
	UpKbps   int `json:"up_kbps"`
}

// Window is a weekly time window in the router's local time.
type Window struct {
	Days  []time.Weekday `json:"days"`
	Start string         `json:"start"` // "HH:MM"
	End   string         `json:"end"`   // "HH:MM"
}

// Driver talks to one router. It is not safe for concurrent use; open one per router and
// serialise calls on it. Read operations log in lazily; Close logs out and wipes session material.
type Driver interface {
	// Identify needs no login where the router allows it.
	Identify(ctx context.Context) (Info, error)
	Capabilities(ctx context.Context) (Capabilities, error)
	Clients(ctx context.Context) ([]Client, error)
	// Blocked lists every block in effect, including the administrator's own (read-only) rules.
	Blocked(ctx context.Context) ([]BlockEntry, error)
	// Block and Unblock act on one MAC address. They return ErrUnsupported when CapBlock is not supported.
	Block(ctx context.Context, mac string) (Change, error)
	Unblock(ctx context.Context, mac string) (Change, error)
	// Close logs out (if logged in) and erases keys, tokens and cookies. Always call it.
	Close(ctx context.Context) error
}

// RateLimiter is implemented by drivers that can limit a client's speed (CapRateLimit).
type RateLimiter interface {
	SetRateLimit(ctx context.Context, mac string, limit RateLimit) (Change, error)
	ClearRateLimit(ctx context.Context, mac string) (Change, error)
}

// Scheduler is implemented by drivers that can block a client during weekly windows (CapSchedule).
type Scheduler interface {
	SetSchedule(ctx context.Context, mac string, blocked []Window) (Change, error)
	ClearSchedule(ctx context.Context, mac string) (Change, error)
}

// NormalizeMAC returns a unicast 48-bit MAC address in lower-case colon form.
func NormalizeMAC(s string) (string, error) {
	hw, err := net.ParseMAC(strings.TrimSpace(s))
	if err != nil || len(hw) != 6 {
		return "", &Error{Kind: ErrInvalidArgument, Op: "mac", Detail: "not a 48-bit MAC address"}
	}
	if hw[0]&1 == 1 {
		return "", &Error{Kind: ErrInvalidArgument, Op: "mac", Detail: "multicast/broadcast MAC addresses cannot be controlled"}
	}
	zero := true
	for _, b := range hw {
		if b != 0 {
			zero = false
		}
	}
	if zero {
		return "", &Error{Kind: ErrInvalidArgument, Op: "mac", Detail: "all-zero MAC address"}
	}
	return hw.String(), nil
}

// SortClients orders clients by IP address then MAC, for stable output.
func SortClients(cs []Client) {
	sort.SliceStable(cs, func(i, j int) bool {
		a, errA := netip.ParseAddr(cs[i].IP)
		b, errB := netip.ParseAddr(cs[j].IP)
		switch {
		case errA == nil && errB == nil && a != b:
			return a.Less(b)
		case errA == nil && errB != nil:
			return true
		case errA != nil && errB == nil:
			return false
		}
		return cs[i].MAC < cs[j].MAC
	})
}
