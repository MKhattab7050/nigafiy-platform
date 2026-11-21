package router

import (
	"context"
	"encoding/hex"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"
)

// Transport is how the driver reaches the router's management interface.
type Transport string

const (
	// TransportHTTPS verifies the certificate against the system roots (a router with a real certificate).
	TransportHTTPS Transport = "https"
	// TransportHTTPSPinned accepts exactly one certificate, identified by its SHA-256 fingerprint
	// (Target.PinSHA256). This is how a router with a self-signed or expired factory certificate is
	// trusted: the administrator confirms the fingerprint once (trust on first use, see
	// FetchCertificate) and every later connection must present the same certificate.
	TransportHTTPSPinned Transport = "https-pinned"
	// TransportHTTP is unencrypted. The administrator must choose it explicitly; the login itself is
	// still protected by the router's own RSA/AES scheme where the vendor has one, but the session
	// cookie travels in clear text on the LAN.
	TransportHTTP Transport = "http"
)

// Target is one router of a site.
type Target struct {
	ID        string     `json:"id"`     // the product's identifier for this router
	Vendor    string     `json:"vendor"` // registry key, e.g. "zyxel"
	Address   netip.Addr `json:"address"`
	Port      int        `json:"port,omitempty"` // 0: the transport's default
	Transport Transport  `json:"transport"`
	// PinSHA256 is the hex SHA-256 of the router's DER certificate (TransportHTTPSPinned).
	PinSHA256 string `json:"pin_sha256,omitempty"`
	// Timeout per HTTP request; 0 means 15 seconds.
	Timeout time.Duration `json:"timeout,omitempty"`
}

// CredentialSource hands the driver the administrator credentials when (and only when) a login is
// needed. The driver zeroes the password slice once the login request is built, so the source must
// return a fresh copy each time. The collector will back this with its secret store; router-probe
// with a hidden terminal prompt. Implementations must never log what they return.
type CredentialSource func(ctx context.Context) (username string, password []byte, err error)

// Options are the guard rails for one Open call.
type Options struct {
	// Authorized are the prefixes this collector may act in: the site's scopes that the cloud
	// delivered AND this collector's own scope.Policy accepted (the same set discovery and
	// Wake-on-LAN use). The router address must be inside one of them.
	Authorized []netip.Prefix
	// AllowLoopback permits 127.0.0.0/8 routers. Tests only, like scope.Policy.AllowLoopback.
	AllowLoopback bool
}

var privateRanges = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

var loopbackRange = netip.MustParsePrefix("127.0.0.0/8")

// IsPrivate reports whether addr is an RFC 1918 IPv4 address.
func IsPrivate(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.Is4() {
		return false
	}
	for _, p := range privateRanges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Authorize is the scope check every control path re-runs before contacting a router: the address
// must be a private IPv4 address (or loopback when allowLoopback, for tests) and inside one of the
// authorized prefixes. It mirrors how internal/agent re-checks SNMP targets and Wake-on-LAN
// broadcasts against the policy-checked scopes.
func Authorize(addr netip.Addr, authorized []netip.Prefix, allowLoopback bool) error {
	addr = addr.Unmap()
	if !addr.IsValid() {
		return &Error{Kind: ErrNotAuthorized, Op: "authorize", Detail: "no router address"}
	}
	if !IsPrivate(addr) && !(allowLoopback && loopbackRange.Contains(addr)) {
		return &Error{Kind: ErrNotAuthorized, Op: "authorize", Detail: addr.String() + " is not a private (RFC 1918) address"}
	}
	for _, p := range authorized {
		if p.Addr().Is4() && p.Contains(addr) {
			return nil
		}
	}
	return &Error{Kind: ErrNotAuthorized, Op: "authorize", Detail: addr.String() + " is not inside an authorized scope"}
}

// Validate checks a target's own fields (not its authorization).
func (t Target) Validate() error {
	if !t.Address.IsValid() {
		return Errorf(ErrInvalidArgument, "target", "no address")
	}
	if t.Port < 0 || t.Port > 65535 {
		return Errorf(ErrInvalidArgument, "target", "port out of range")
	}
	switch t.Transport {
	case TransportHTTPS, TransportHTTP:
	case TransportHTTPSPinned:
		if _, err := ParsePin(t.PinSHA256); err != nil {
			return err
		}
	default:
		return Errorf(ErrInvalidArgument, "target", "transport must be https, https-pinned or http")
	}
	return nil
}

// ParsePin accepts a SHA-256 fingerprint as 64 hex digits, with or without ':' separators.
func ParsePin(s string) ([]byte, error) {
	clean := strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimSpace(s)))
	b, err := hex.DecodeString(clean)
	if err != nil || len(b) != 32 {
		return nil, Errorf(ErrInvalidArgument, "target", "certificate pin must be a SHA-256 fingerprint (64 hex digits)")
	}
	return b, nil
}

// Factory creates a driver for an already validated and authorized target.
type Factory func(t Target, creds CredentialSource) (Driver, error)

var (
	registryMu sync.RWMutex
	registry   = map[string]Factory{}
)

// Register makes a driver available under a vendor key. Driver packages call it from init.
func Register(vendor string, f Factory) {
	registryMu.Lock()
	defer registryMu.Unlock()
	key := strings.ToLower(vendor)
	if _, dup := registry[key]; dup {
		panic("router: driver registered twice: " + key)
	}
	registry[key] = f
}

// Vendors lists registered vendor keys.
func Vendors() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Open validates the target, re-checks that it is authorized, and returns its vendor's driver.
// Nothing is sent to the router until the first operation.
func Open(t Target, creds CredentialSource, opts Options) (Driver, error) {
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if err := Authorize(t.Address, opts.Authorized, opts.AllowLoopback); err != nil {
		return nil, err
	}
	registryMu.RLock()
	f := registry[strings.ToLower(t.Vendor)]
	registryMu.RUnlock()
	if f == nil {
		return nil, Errorf(ErrUnknownVendor, "open", "%q", t.Vendor)
	}
	return f(t, creds)
}

// Zero overwrites b. Use it on passwords and key material once they are no longer needed.
func Zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
