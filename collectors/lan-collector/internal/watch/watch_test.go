package watch

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

var loopback = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}

func guard() Guard { return Guard{Scopes: loopback} }

func hostPortOf(t *testing.T, raw string) (string, int) {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(u.Port())
	return u.Hostname(), p
}

func boolp(b bool) *bool { return &b }
func intp(i int) *int    { return &i }

func TestGuardRule(t *testing.T) {
	g := Guard{Scopes: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24"), netip.MustParsePrefix("fd00:1::/64"), netip.MustParsePrefix("2a01:4f8:1:2::/64")}}
	cases := []struct {
		addr, why string
		public    bool
		ok        bool
	}{
		{"192.168.1.20", "inside the scope", false, true},
		{"192.168.2.20", "private, outside every scope", false, false},
		{"10.0.0.1", "private, outside every scope", true, false},
		{"169.254.169.254", "link-local (cloud metadata)", true, false},
		{"127.0.0.1", "loopback outside every scope", true, false},
		{"100.64.0.1", "CGNAT", true, false},
		{"224.0.0.1", "multicast", true, false},
		{"203.0.113.5", "documentation range", true, false},
		{"1.1.1.1", "public without opt-in", false, false},
		{"1.1.1.1", "public with opt-in", true, true},
		{"::1", "IPv6 loopback outside every scope", true, false},
		{"fd00:1::5", "IPv6 unique-local inside the scope", false, true},
		{"fd00:2::5", "IPv6 unique-local outside every scope", true, false},
		{"2a01:4f8:1:2::9", "global IPv6 inside a scope is a LAN address", false, true},
		{"2606:4700:4700::1111", "public IPv6 without opt-in", false, false},
		{"2606:4700:4700::1111", "public IPv6 with opt-in", true, true},
		{"fe80::1", "IPv6 link-local", true, false},
		{"2001:db8::1", "IPv6 documentation", true, false},
		{"ff02::1", "IPv6 multicast", true, false},
	}
	for _, c := range cases {
		g.AllowPublic = c.public
		err := g.Allow(netip.MustParseAddr(c.addr))
		if (err == nil) != c.ok {
			t.Errorf("%s (%s): got %v, want ok=%v", c.addr, c.why, err, c.ok)
		}
		if err != nil && !IsRefused(err) {
			t.Errorf("%s: refusal must be a RefusedError: %v", c.addr, err)
		}
	}
}

func TestGuardVetsEveryResolvedAddress(t *testing.T) {
	g := Guard{
		Scopes: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")},
		Resolve: func(_ context.Context, host string) ([]netip.Addr, error) {
			if host == "mixed.lan" {
				return []netip.Addr{netip.MustParseAddr("192.168.1.5"), netip.MustParseAddr("10.9.9.9")}, nil
			}
			return []netip.Addr{netip.MustParseAddr("192.168.1.7")}, nil
		},
	}
	if a, err := g.Vet(context.Background(), "nas.lan"); err != nil || a.String() != "192.168.1.7" {
		t.Fatalf("nas.lan: %v %v", a, err)
	}
	if _, err := g.Vet(context.Background(), "mixed.lan"); !IsRefused(err) {
		t.Fatalf("a name with one out-of-scope address must be refused: %v", err)
	}
}

func TestHTTPStatusBodyAndRedirects(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>status: All systems operational</html>"))
	})
	mux.HandleFunc("/down", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
	mux.HandleFunc("/hop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ok?token=secret", http.StatusFound)
	})
	mux.HandleFunc("/loop", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/loop", http.StatusFound) })
	mux.HandleFunc("/big", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", MaxBodyBytes+10) + "NEEDLE"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	host, port := hostPortOf(t, srv.URL)
	run := func(cfg HTTPConfig) Result {
		return HTTP(context.Background(), HTTPSpec{Scheme: "http", Host: host, Port: port, Config: cfg, Timeout: 3 * time.Second}, guard())
	}

	res := run(HTTPConfig{Path: "/ok", BodyMatch: &BodyMatch{Mode: "substring", Pattern: "operational"}})
	if !res.OK || res.Value == nil || *res.Value != 200 || res.LatencyMs == nil || res.Details["body_matched"] != true || res.Resolved != "127.0.0.1" {
		t.Fatalf("ok page: %+v", res)
	}
	res = run(HTTPConfig{Path: "/ok", BodyMatch: &BodyMatch{Mode: "regex", Pattern: `status:\s+All\s+\w+`}})
	if !res.OK {
		t.Fatalf("regex: %+v", res)
	}
	res = run(HTTPConfig{Path: "/ok", BodyMatch: &BodyMatch{Mode: "substring", Pattern: "operational", Negate: true}})
	if res.OK || !strings.Contains(res.Error, "forbidden") {
		t.Fatalf("negated match must fail: %+v", res)
	}
	res = run(HTTPConfig{Path: "/down"})
	if res.OK || res.Value == nil || *res.Value != 503 || !strings.Contains(res.Error, "unexpected HTTP status 503 (expected 200-299)") {
		t.Fatalf("503: %+v", res)
	}
	res = run(HTTPConfig{Path: "/down", ExpectStatus: &ExpectStatus{Min: 503, Max: 503}})
	if !res.OK {
		t.Fatalf("503 expected: %+v", res)
	}
	res = run(HTTPConfig{Path: "/hop"})
	if !res.OK || res.Details["redirects"] != 1 || res.Details["final_url"] != srv.URL+"/ok" {
		t.Fatalf("redirect followed, query dropped from evidence: %+v", res.Details)
	}
	res = run(HTTPConfig{Path: "/hop", FollowRedirects: boolp(false)})
	if res.OK || *res.Value != 302 {
		t.Fatalf("redirect not followed: %+v", res)
	}
	res = run(HTTPConfig{Path: "/hop", FollowRedirects: boolp(false), ExpectStatus: &ExpectStatus{Min: 300, Max: 399}})
	if !res.OK {
		t.Fatalf("a redirect can be the expected answer: %+v", res)
	}
	res = run(HTTPConfig{Path: "/loop", MaxRedirects: intp(3)})
	if res.OK || !strings.Contains(res.Error, "more than 3 redirects") {
		t.Fatalf("redirect loop: %+v", res)
	}
	res = run(HTTPConfig{Path: "/big", BodyMatch: &BodyMatch{Mode: "substring", Pattern: "NEEDLE"}})
	if res.OK || res.Details["body_bytes"] != MaxBodyBytes {
		t.Fatalf("only the first 256 KiB are read: %+v", res.Details)
	}
	res = run(HTTPConfig{Path: "/ok", Method: "HEAD"})
	if !res.OK {
		t.Fatalf("HEAD: %+v", res)
	}
}

func TestHTTPGuardRefusesBeforeConnecting(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++ }))
	defer srv.Close()
	host, port := hostPortOf(t, srv.URL)
	res := HTTP(context.Background(), HTTPSpec{Scheme: "http", Host: host, Port: port, Timeout: time.Second}, Guard{Scopes: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}})
	if res.OK || !strings.HasPrefix(res.Error, "refused:") || hits != 0 {
		t.Fatalf("out-of-scope target must be refused without a request: %+v hits=%d", res, hits)
	}
	// A redirect to an address outside the scopes is refused on that hop.
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer inner.Close()
	host, port = hostPortOf(t, inner.URL)
	res = HTTP(context.Background(), HTTPSpec{Scheme: "http", Host: host, Port: port, Timeout: time.Second}, guard())
	if res.OK || !strings.Contains(res.Error, "refused: 169.254.169.254") {
		t.Fatalf("redirect to metadata address: %+v", res)
	}
}

func TestHTTPConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	ln.Close()
	res := HTTP(context.Background(), HTTPSpec{Scheme: "http", Host: "127.0.0.1", Port: addr.Port, Timeout: 2 * time.Second}, guard())
	if res.OK || res.Error == "" {
		t.Fatalf("closed port: %+v", res)
	}
}

func certFingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

func TestHTTPSVerificationAndPin(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")) }))
	defer srv.Close()
	host, port := hostPortOf(t, srv.URL)
	leaf := srv.Certificate()
	run := func(cfg HTTPConfig) Result {
		return HTTP(context.Background(), HTTPSpec{Scheme: "https", Host: host, Port: port, Config: cfg, Timeout: 3 * time.Second}, guard())
	}

	// Verification is on by default: a certificate from an unknown authority fails.
	res := run(HTTPConfig{})
	if res.OK || !strings.HasPrefix(res.Error, "certificate not trusted") {
		t.Fatalf("self-signed must fail verification: %+v", res)
	}
	// Verification off: the request succeeds and the evidence says it would not have verified.
	res = run(HTTPConfig{TLSVerify: boolp(false)})
	if !res.OK || res.Details["verified"] != false || res.Details["cert_sha256"] != certFingerprint(leaf) || res.Details["cert_not_after"] == nil {
		t.Fatalf("verify off: %+v", res)
	}
	// Pin: the right fingerprint passes even without chain verification; a wrong one fails.
	res = run(HTTPConfig{TLSVerify: boolp(false), PinSHA256: strings.ToUpper(certFingerprint(leaf))})
	if !res.OK {
		t.Fatalf("matching pin: %+v", res)
	}
	res = run(HTTPConfig{TLSVerify: boolp(false), PinSHA256: strings.Repeat("ab", 32)})
	if res.OK || !strings.Contains(res.Error, "does not match the pinned SHA-256") {
		t.Fatalf("wrong pin: %+v", res)
	}
	// With the test CA trusted, verification passes.
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	testRoots = pool
	defer func() { testRoots = nil }()
	res = run(HTTPConfig{})
	if !res.OK || res.Details["verified"] != true || res.Details["tls_version"] == nil {
		t.Fatalf("trusted: %+v", res)
	}
}

func selfSigned(t *testing.T, notBefore, notAfter time.Time, cn string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"Test Org"}},
		Issuer:       pkix.Name{CommonName: cn},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		DNSNames:     []string{cn},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func tlsServer(t *testing.T, cert tls.Certificate) (string, int, func(string) string) {
	t.Helper()
	var sni string
	ln, err := tls.Listen("tcp4", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = h.ServerName
			return nil, nil
		},
	})
	if err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				_ = c.(*tls.Conn).Handshake()
				c.Close()
			}(c)
		}
	}()
	a := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port, func(string) string { return sni }
}

func TestTLSExpiry(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	host, port, sniSeen := tlsServer(t, selfSigned(t, now.Add(-24*time.Hour), now.Add(10*24*time.Hour+12*time.Hour), "nas.lan"))
	res := TLSExpiry(context.Background(), TLSSpec{Host: host, Port: port, Config: TLSConfig{SNI: "nas.lan"}, Timeout: 3 * time.Second, Now: now}, guard())
	if !res.OK || res.Value == nil || *res.Value != 10.5 {
		t.Fatalf("10.5 days remaining: %+v", res)
	}
	if sniSeen("") != "nas.lan" {
		t.Errorf("SNI sent: %q", sniSeen(""))
	}
	d := res.Details
	if !strings.Contains(d["cert_subject"].(string), "CN=nas.lan") || !strings.Contains(d["cert_issuer"].(string), "nas.lan") || d["cert_not_after"] != "2026-12-03T00:00:00Z" || d["verified"] != false {
		t.Fatalf("evidence: %+v", d)
	}

	// An expired certificate is still read (negative days), never refused by verification.
	host, port, _ = tlsServer(t, selfSigned(t, now.Add(-90*24*time.Hour), now.Add(-2*24*time.Hour), "old.lan"))
	res = TLSExpiry(context.Background(), TLSSpec{Host: host, Port: port, Timeout: 3 * time.Second, Now: now}, guard())
	if !res.OK || *res.Value != -2 {
		t.Fatalf("expired: %+v", res)
	}

	// Out of scope: refused before connecting.
	res = TLSExpiry(context.Background(), TLSSpec{Host: host, Port: port, Timeout: time.Second}, Guard{})
	if res.OK || !strings.HasPrefix(res.Error, "refused:") {
		t.Fatalf("refused: %+v", res)
	}
}

func TestTLSExpiryNotTLS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	host, port := hostPortOf(t, srv.URL)
	res := TLSExpiry(context.Background(), TLSSpec{Host: host, Port: port, Timeout: 2 * time.Second}, guard())
	if res.OK || !strings.HasPrefix(res.Error, "TLS handshake failed") {
		t.Fatalf("plain HTTP port: %+v", res)
	}
}

func TestCleanHTTPError(t *testing.T) {
	if got := cleanHTTPError(&url.Error{Op: "Get", URL: "http://x", Err: &RefusedError{"10.0.0.1 is outside"}}, time.Second); got != "refused: 10.0.0.1 is outside" {
		t.Errorf("refused: %q", got)
	}
	if got := cleanHTTPError(errors.New("name does not resolve"), time.Second); got != "name does not resolve" {
		t.Errorf("resolve: %q", got)
	}
}
