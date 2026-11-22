package watch

import (
	"context"
	"crypto/tls"
	"errors"
	"math"
	"net"
	"net/netip"
	"strconv"
	"time"
)

// TLSConfig is a tls_expiry check's settings as delivered by the cloud. The thresholds are applied by
// the cloud (the collector reports the measured days); only the connection settings matter here.
type TLSConfig struct {
	SNI         string `json:"sni"`
	AllowPublic bool   `json:"allow_public"`
}

// TLSSpec is one certificate to read.
type TLSSpec struct {
	Host    string
	Port    int
	Config  TLSConfig
	Timeout time.Duration
	// Now is the reference time for "days remaining" (time.Now when zero).
	Now time.Time
}

// TLSExpiry connects, completes a TLS handshake (without trusting the chain: an expired or self-signed
// certificate must still be read) and reports the days until the leaf certificate expires, with the
// issuer, subject and notAfter as evidence and whether the chain verifies for the name.
func TLSExpiry(ctx context.Context, spec TLSSpec, g Guard) Result {
	timeout := spec.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if spec.Port <= 0 || spec.Port > 65535 {
		return Result{Error: "a certificate check needs a port"}
	}
	sni := spec.Config.SNI
	if sni == "" {
		if _, err := netip.ParseAddr(spec.Host); err != nil {
			sni = spec.Host // a name: send it as SNI
		}
	}
	dial := newDialer(g, timeout)
	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	raw, err := dial.DialContext(dctx, "tcp", net.JoinHostPort(spec.Host, strconv.Itoa(spec.Port)))
	if err != nil {
		return Result{Error: cleanHTTPError(err, timeout), Resolved: dial.last()}
	}
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(timeout))
	conn := tls.Client(raw, &tls.Config{
		ServerName: sni,
		// Old devices still serve TLS 1.0/1.1; only the certificate is read, nothing secret is sent.
		MinVersion:         tls.VersionTLS10, //nolint:gosec // read-only certificate inspection
		InsecureSkipVerify: true,             //nolint:gosec // the chain is verified below and reported, never trusted blindly
	})
	if err := conn.HandshakeContext(dctx); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Result{Error: "no TLS handshake within " + timeout.Round(time.Second).String(), Resolved: dial.last()}
		}
		return Result{Error: "TLS handshake failed: " + clip(err.Error(), 200), Resolved: dial.last()}
	}
	latency := time.Since(start)
	cs := conn.ConnectionState()
	if len(cs.PeerCertificates) == 0 {
		return Result{Error: "the server presented no certificate", Resolved: dial.last()}
	}
	now := spec.Now
	if now.IsZero() {
		now = time.Now()
	}
	leaf := cs.PeerCertificates[0]
	days := math.Round(leaf.NotAfter.Sub(now).Hours()/24*100) / 100
	details := map[string]any{}
	name := sni
	if name == "" {
		name = spec.Host
	}
	addCertDetails(details, cs, name, false)
	return Result{OK: true, LatencyMs: ms(latency), Value: num(days), Resolved: dial.last(), Details: details}
}
