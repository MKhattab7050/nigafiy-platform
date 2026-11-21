package router

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// MaxResponseBytes caps every response a driver reads, so a misbehaving device cannot exhaust memory.
const MaxResponseBytes = 8 << 20

// BaseURL returns the scheme://address:port prefix for t.
func (t Target) BaseURL() string {
	scheme := "https"
	if t.Transport == TransportHTTP {
		scheme = "http"
	}
	return scheme + "://" + netip.AddrPortFrom(t.Address, uint16(t.port())).String()
}

func (t Target) port() int {
	if t.Port != 0 {
		return t.Port
	}
	if t.Transport == TransportHTTP {
		return 80
	}
	return 443
}

func (t Target) timeout() time.Duration {
	if t.Timeout > 0 {
		return t.Timeout
	}
	return 15 * time.Second
}

// HTTPClient builds the client a driver must use for t:
//   - it dials exactly t.Address:port whatever host a URL names, so nothing can steer it elsewhere;
//   - it refuses redirects;
//   - it verifies TLS normally (TransportHTTPS) or against the pin (TransportHTTPSPinned);
//   - it keeps no cookie jar (drivers hold session cookies themselves so they can erase them);
//   - it ignores proxy settings (the router is on the LAN).
func HTTPClient(t Target) (*http.Client, error) {
	if err := t.Validate(); err != nil {
		return nil, err
	}
	fixed := netip.AddrPortFrom(t.Address, uint16(t.port())).String()
	dialer := &net.Dialer{Timeout: t.timeout()}
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", fixed)
		},
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   t.timeout(),
		ResponseHeaderTimeout: t.timeout(),
		ForceAttemptHTTP2:     false,
	}
	switch t.Transport {
	case TransportHTTPS:
		tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: t.Address.String()}
	case TransportHTTPSPinned:
		pin, _ := ParsePin(t.PinSHA256)
		tr.TLSClientConfig = PinnedTLSConfig(pin)
	}
	return &http.Client{
		Transport: tr,
		Timeout:   2 * t.timeout(),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("router redirected; redirects are not followed")
		},
	}, nil
}

// PinnedTLSConfig accepts exactly the certificate whose DER SHA-256 equals pin. Chain, name and
// expiry are not checked because the pin replaces them: a factory certificate is typically
// self-signed and long expired, yet pinning it still proves we talk to the same device.
// Normal verification is disabled ONLY together with this explicit pin check.
func PinnedTLSConfig(pin []byte) *tls.Config {
	want := append([]byte(nil), pin...)
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // replaced by VerifyConnection below; never used without a pin
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return &Error{Kind: ErrCertificate, Op: "tls", Detail: "no certificate presented"}
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
			if len(want) != 32 || subtle.ConstantTimeCompare(sum[:], want) != 1 {
				return &Error{Kind: ErrCertificate, Op: "tls", Detail: "presented " + FormatPin(sum[:])}
			}
			return nil
		},
	}
}

// FormatPin renders a fingerprint as colon-separated upper-case hex.
func FormatPin(sum []byte) string {
	h := strings.ToUpper(hex.EncodeToString(sum))
	var b strings.Builder
	for i := 0; i < len(h); i += 2 {
		if i > 0 {
			b.WriteByte(':')
		}
		b.WriteString(h[i : i+2])
	}
	return b.String()
}

// CertificateInfo is what an administrator needs to decide whether to trust a certificate.
type CertificateInfo struct {
	SHA256      string    `json:"sha256"` // FormatPin form; pass it as Target.PinSHA256
	Subject     string    `json:"subject"`
	Issuer      string    `json:"issuer"`
	NotBefore   time.Time `json:"not_before"`
	NotAfter    time.Time `json:"not_after"`
	SelfSigned  bool      `json:"self_signed"`
	Expired     bool      `json:"expired"`
	SystemTrust bool      `json:"system_trust"` // verifies against the system roots for this address
}

// FetchCertificate performs only a TLS handshake (no HTTP request) with an authorized router and
// returns its certificate, for trust-on-first-use. The caller shows it to the administrator, who
// confirms it before it is stored as the pin.
func FetchCertificate(ctx context.Context, addr netip.Addr, port int, opts Options) (CertificateInfo, error) {
	if err := Authorize(addr, opts.Authorized, opts.AllowLoopback); err != nil {
		return CertificateInfo{}, err
	}
	if port == 0 {
		port = 443
	}
	d := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 10 * time.Second},
		// Read-only inspection: the certificate is captured and evaluated below, no data is sent.
		Config: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true},
	}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		return CertificateInfo{}, &Error{Kind: ErrUnreachable, Op: "tls", Detail: safeNetErr(err)}
	}
	defer conn.Close()
	state := conn.(*tls.Conn).ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return CertificateInfo{}, &Error{Kind: ErrProtocol, Op: "tls", Detail: "no certificate presented"}
	}
	leaf := state.PeerCertificates[0]
	sum := sha256.Sum256(leaf.Raw)
	inter := x509.NewCertPool()
	for _, c := range state.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	_, verr := leaf.Verify(x509.VerifyOptions{DNSName: addr.String(), Intermediates: inter})
	return CertificateInfo{
		SHA256:      FormatPin(sum[:]),
		Subject:     leaf.Subject.String(),
		Issuer:      leaf.Issuer.String(),
		NotBefore:   leaf.NotBefore,
		NotAfter:    leaf.NotAfter,
		SelfSigned:  leaf.Subject.String() == leaf.Issuer.String(),
		Expired:     time.Now().After(leaf.NotAfter),
		SystemTrust: verr == nil,
	}, nil
}

// ReadBody reads at most MaxResponseBytes.
func ReadBody(r io.Reader) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxResponseBytes {
		return nil, Errorf(ErrProtocol, "read", "response larger than %d bytes", MaxResponseBytes)
	}
	return b, nil
}

// TransportError maps a client error to ErrCertificate or ErrUnreachable without echoing URLs
// (which could carry tokens) or payloads.
func TransportError(op string, err error) error {
	var re *Error
	if errors.As(err, &re) {
		return re
	}
	var unknownCA x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	var verify *tls.CertificateVerificationError
	if errors.As(err, &unknownCA) || errors.As(err, &invalid) || errors.As(err, &hostname) || errors.As(err, &verify) {
		return &Error{Kind: ErrCertificate, Op: op, Detail: "certificate not trusted by the system; confirm its fingerprint and use https-pinned"}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Kind: ErrUnreachable, Op: op, Detail: "timed out or cancelled"}
	}
	return &Error{Kind: ErrUnreachable, Op: op, Detail: safeNetErr(err)}
}

func safeNetErr(err error) string {
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		return op.Err.Error()
	}
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return safeNetErr(inner)
		}
	}
	s := err.Error()
	if i := strings.Index(s, "http"); i >= 0 { // drop any URL
		s = s[:i]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), ":"))
}
