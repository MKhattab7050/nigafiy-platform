package watch

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// MaxBodyBytes is how much of a response body is read for a body assertion; the rest is never read.
const MaxBodyBytes = 256 * 1024

// BodyMatch is the optional assertion on the response body.
type BodyMatch struct {
	Mode    string `json:"mode"` // "substring" | "regex" (Go RE2: linear time, no lookaround)
	Pattern string `json:"pattern"`
	Negate  bool   `json:"negate"` // fail when the pattern IS found
}

// ExpectStatus is the accepted status range (min = max for a single status).
type ExpectStatus struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// HTTPConfig is the check's settings as delivered by the cloud (validated there, re-checked here).
type HTTPConfig struct {
	Path            string        `json:"path"`
	Method          string        `json:"method"`
	ExpectStatus    *ExpectStatus `json:"expect_status"`
	BodyMatch       *BodyMatch    `json:"body_match"`
	FollowRedirects *bool         `json:"follow_redirects"`
	MaxRedirects    *int          `json:"max_redirects"`
	TLSVerify       *bool         `json:"tls_verify"`
	PinSHA256       string        `json:"pin_sha256"`
	AllowPublic     bool          `json:"allow_public"`
}

// HTTPSpec is one request to make.
type HTTPSpec struct {
	Scheme  string // "http" | "https"
	Host    string
	Port    int // 0 = scheme default
	Config  HTTPConfig
	Timeout time.Duration
}

func (s HTTPSpec) url() (*url.URL, error) {
	if s.Scheme != "http" && s.Scheme != "https" {
		return nil, errors.New("unsupported scheme")
	}
	host := s.Host
	if s.Port > 0 {
		host = net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	}
	path := s.Config.Path
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("the path must start with /")
	}
	u, err := url.Parse(s.Scheme + "://" + host + path)
	if err != nil || u.Host == "" || u.User != nil {
		return nil, errors.New("the URL is not valid")
	}
	return u, nil
}

// withoutQuery drops user info, query and fragment: evidence keeps where the request ended, not its parameters.
func withoutQuery(u *url.URL) string {
	c := *u
	c.User, c.RawQuery, c.ForceQuery, c.Fragment, c.RawFragment = nil, "", false, "", ""
	return c.String()
}

// errPinMismatch: the server presented a different certificate than the pinned one.
type errPinMismatch struct{ got string }

func (e errPinMismatch) Error() string {
	return "the server's certificate does not match the pinned SHA-256 (it presents " + e.got + ")"
}

// cleanHTTPError turns transport errors into short, stable messages (no URL repeated, no internals).
func cleanHTTPError(err error, timeout time.Duration) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var refused *RefusedError
	var pin errPinMismatch
	var unknownAuth x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verifyErr *tls.CertificateVerificationError
	var netErr net.Error
	switch {
	case errors.As(err, &refused):
		return refused.Error()
	case errors.As(err, &pin):
		return pin.Error()
	case errors.As(err, &hostErr):
		return "certificate not trusted: " + clip(hostErr.Error(), 200)
	case errors.As(err, &unknownAuth):
		return "certificate not trusted: it is signed by an unknown authority (self-signed or private CA)"
	case errors.As(err, &invalid):
		return "certificate not trusted: " + clip(invalid.Error(), 200)
	case errors.As(err, &verifyErr):
		return "certificate not trusted: " + clip(verifyErr.Err.Error(), 200)
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "refused"):
		return "connection refused (nothing is listening on that port)"
	case errors.As(err, &netErr) && netErr.Timeout(), errors.Is(err, context.DeadlineExceeded):
		return fmt.Sprintf("no answer within %s", timeout.Round(time.Second))
	case strings.Contains(err.Error(), "does not resolve"):
		return "name does not resolve"
	}
	return clip(err.Error(), 200)
}

// HTTP makes one request and judges it: status in the expected range, body assertion, redirect policy,
// TLS verification (and pin). The connection only ever goes to addresses the guard allows.
func HTTP(ctx context.Context, spec HTTPSpec, g Guard) Result {
	timeout := spec.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	u, err := spec.url()
	if err != nil {
		return Result{Error: err.Error()}
	}
	cfg := spec.Config
	method := cfg.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return Result{Error: "only GET and HEAD requests are made"}
	}
	expect := ExpectStatus{Min: 200, Max: 299}
	if cfg.ExpectStatus != nil {
		expect = *cfg.ExpectStatus
	}
	follow := cfg.FollowRedirects == nil || *cfg.FollowRedirects
	maxRedirects := 5
	if cfg.MaxRedirects != nil {
		maxRedirects = min(max(*cfg.MaxRedirects, 0), 10)
	}
	verify := spec.Scheme == "https" && (cfg.TLSVerify == nil || *cfg.TLSVerify)
	pin := strings.ToLower(strings.ReplaceAll(cfg.PinSHA256, ":", ""))
	var re *regexp.Regexp
	if m := cfg.BodyMatch; m != nil && m.Mode == "regex" {
		if re, err = regexp.Compile(m.Pattern); err != nil {
			return Result{Error: "the body pattern is not a valid regular expression"}
		}
	}

	dial := newDialer(g, timeout)
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Verification is done in VerifyConnection so that the pin is checked on every handshake, and so
		// that a check with verification turned off still reports whether the chain would have verified.
		InsecureSkipVerify: true, //nolint:gosec // replaced by VerifyConnection below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("the server presented no certificate")
			}
			leaf := cs.PeerCertificates[0]
			if pin != "" {
				sum := sha256.Sum256(leaf.Raw)
				if got := hex.EncodeToString(sum[:]); got != pin {
					return errPinMismatch{got: got}
				}
			}
			if verify {
				name := cs.ServerName
				if name == "" {
					name = dial.last() // an IP-literal URL sends no SNI: verify against the address dialed
				}
				return verifyChain(cs, name)
			}
			return nil
		},
	}
	transport := &http.Transport{
		Proxy:                  nil, // never an environment proxy: the guard decides where connections go
		DialContext:            dial.DialContext,
		TLSClientConfig:        tlsCfg,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 64 << 10,
	}
	defer transport.CloseIdleConnections()
	redirects := 0
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout + 5*time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if !follow {
				return http.ErrUseLastResponse
			}
			if len(via) > maxRedirects {
				return fmt.Errorf("more than %d redirects", maxRedirects)
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("redirect to an unsupported scheme")
			}
			redirects = len(via)
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return Result{Error: "the URL is not valid"}
	}
	req.Header.Set("User-Agent", "Nigafiy-Watch/1")
	req.Header.Set("Accept", "*/*")

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start) // time to the response headers
	if err != nil {
		res := Result{Error: cleanHTTPError(err, timeout), Resolved: dial.last()}
		if strings.Contains(err.Error(), "redirects") {
			res.Error = fmt.Sprintf("more than %d redirects", maxRedirects)
		}
		return res
	}
	defer resp.Body.Close()

	details := map[string]any{"status_code": resp.StatusCode, "final_url": clip(withoutQuery(resp.Request.URL), 500), "redirects": redirects}
	res := Result{LatencyMs: ms(latency), Value: num(float64(resp.StatusCode)), Resolved: dial.last(), Details: details}
	if resp.TLS != nil {
		addCertDetails(details, *resp.TLS, resp.Request.URL.Hostname(), verify)
	}

	if resp.StatusCode < expect.Min || resp.StatusCode > expect.Max {
		res.Error = fmt.Sprintf("unexpected HTTP status %d (expected %s)", resp.StatusCode, expectText(expect))
		return res
	}
	if m := cfg.BodyMatch; m != nil && method == http.MethodGet {
		body, rerr := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes))
		details["body_bytes"] = len(body)
		if rerr != nil && len(body) == 0 {
			res.Error = "the response body could not be read"
			return res
		}
		found := false
		if m.Mode == "regex" {
			found = re.Match(body)
		} else {
			found = strings.Contains(string(body), m.Pattern)
		}
		details["body_matched"] = found
		switch {
		case !m.Negate && !found:
			res.Error = fmt.Sprintf("the response body (first %d KiB) does not contain the expected %s", MaxBodyBytes/1024, patternWord(m.Mode))
			return res
		case m.Negate && found:
			res.Error = fmt.Sprintf("the response body contains the forbidden %s", patternWord(m.Mode))
			return res
		}
	}
	res.OK = true
	return res
}

func patternWord(mode string) string {
	if mode == "regex" {
		return "pattern"
	}
	return "text"
}

func expectText(e ExpectStatus) string {
	if e.Min == e.Max {
		return strconv.Itoa(e.Min)
	}
	return fmt.Sprintf("%d-%d", e.Min, e.Max)
}

// verifyChain verifies the presented chain against the system roots for the name that was dialed.
func verifyChain(cs tls.ConnectionState, name string) error {
	if name == "" {
		return errors.New("no server name to verify the certificate against")
	}
	leaf := cs.PeerCertificates[0]
	inter := x509.NewCertPool()
	for _, c := range cs.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: name, Intermediates: inter, Roots: testRoots})
	return err
}

// testRoots replaces the system roots in tests (nil = system roots).
var testRoots *x509.CertPool

// addCertDetails records what certificate the server presented and whether it verifies.
func addCertDetails(details map[string]any, cs tls.ConnectionState, host string, verified bool) {
	if len(cs.PeerCertificates) == 0 {
		return
	}
	leaf := cs.PeerCertificates[0]
	sum := sha256.Sum256(leaf.Raw)
	details["tls_version"] = tls.VersionName(cs.Version)
	details["cert_subject"] = clip(leaf.Subject.String(), 300)
	details["cert_issuer"] = clip(leaf.Issuer.String(), 300)
	details["cert_not_before"] = leaf.NotBefore.UTC().Format(time.RFC3339)
	details["cert_not_after"] = leaf.NotAfter.UTC().Format(time.RFC3339)
	details["cert_sha256"] = hex.EncodeToString(sum[:])
	names := leaf.DNSNames
	if len(names) > 20 {
		names = names[:20]
	}
	if len(names) > 0 {
		clipped := make([]string, len(names))
		for i, n := range names {
			clipped[i] = clip(n, 253)
		}
		details["cert_dns_names"] = clipped
	}
	if verified {
		details["verified"] = true // the handshake succeeded with verification on
		return
	}
	// Verification is off for this check: still report whether the chain would have verified.
	if err := verifyChain(cs, host); err != nil {
		details["verified"] = false
		details["verify_error"] = clip(cleanHTTPError(err, 0), 300)
	} else {
		details["verified"] = true
	}
}
