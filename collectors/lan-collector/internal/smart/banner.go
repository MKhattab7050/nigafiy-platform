package smart

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Banner probe: one plain GET of "/" on each authorized device's web ports, to read what the
// device says about itself (status, page title, Server header, TLS certificate names). Nothing is
// sent beyond that one request: no redirect is followed, no credential, no form, no second path.
// Certificate verification is skipped only so a device's own (usually self-signed) certificate can
// be read; the result says whether it was self-signed.

// Banner is what one web port answered.
type Banner struct {
	IP            string `json:"ip"`
	Port          int    `json:"port"`
	Scheme        string `json:"scheme"`
	Status        int    `json:"status,omitempty"`
	Title         string `json:"title,omitempty"`
	Server        string `json:"server,omitempty"`
	TLSSubject    string `json:"tls_subject,omitempty"`
	TLSIssuer     string `json:"tls_issuer,omitempty"`
	TLSSelfSigned *bool  `json:"tls_self_signed,omitempty"`
}

// BannerReport lists every address that was probed (so "nothing answered" is recorded too) and
// what answered.
type BannerReport struct {
	Probed  []string `json:"probed"`
	Results []Banner `json:"results"`
}

// BannerOptions tune the probe. The zero value uses the defaults.
type BannerOptions struct {
	// HTTPSPorts are the ports spoken to with TLS; every other port gets plain HTTP. Default 443, 8443.
	HTTPSPorts []int
	// Timeout bounds one request from dial to the last byte read. Default 3 s.
	Timeout time.Duration
}

const (
	maxBannerTargets = 64
	maxBannerPorts   = 8
	maxBannerResults = 256
	maxBannerBody    = 64 << 10
	bannerWorkers    = 8
	bannerTimeout    = 3 * time.Second
	bannerUserAgent  = "lan-collector banner probe"
)

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// ProbeBanners probes targets on ports with the default options. Only IPv4 targets inside allowed
// are contacted; the others are neither dialled nor listed in Probed.
func ProbeBanners(ctx context.Context, targets []netip.Addr, ports []int, allowed []netip.Prefix) BannerReport {
	return ProbeBannersWith(ctx, targets, ports, allowed, BannerOptions{})
}

// ProbeBannersWith is ProbeBanners with explicit options.
func ProbeBannersWith(ctx context.Context, targets []netip.Addr, ports []int, allowed []netip.Prefix, opts BannerOptions) BannerReport {
	if opts.Timeout <= 0 {
		opts.Timeout = bannerTimeout
	}
	https := map[int]bool{443: true, 8443: true}
	if opts.HTTPSPorts != nil {
		https = map[int]bool{}
		for _, p := range opts.HTTPSPorts {
			https[p] = true
		}
	}
	report := BannerReport{Probed: []string{}, Results: []Banner{}}

	seen := map[netip.Addr]bool{}
	var addrs []netip.Addr
	for _, t := range targets {
		t = t.Unmap()
		if !t.Is4() || seen[t] || !inAny(t, allowed) {
			continue
		}
		if len(addrs) >= maxBannerTargets {
			break
		}
		seen[t] = true
		addrs = append(addrs, t)
	}
	var usePorts []int
	seenPort := map[int]bool{}
	for _, p := range ports {
		if p < 1 || p > 65535 || seenPort[p] || len(usePorts) >= maxBannerPorts {
			continue
		}
		seenPort[p] = true
		usePorts = append(usePorts, p)
	}

	type job struct {
		addr netip.Addr
		port int
	}
	jobs := make(chan job)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for w := 0; w < bannerWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if b, ok := probeBanner(ctx, j.addr, j.port, https[j.port], allowed, opts.Timeout); ok {
					mu.Lock()
					report.Results = append(report.Results, b)
					mu.Unlock()
				}
			}
		}()
	}
feed:
	for _, a := range addrs {
		if ctx.Err() != nil {
			break
		}
		report.Probed = append(report.Probed, a.String())
		for _, p := range usePorts {
			select {
			case jobs <- job{a, p}:
			case <-ctx.Done():
				break feed
			}
		}
	}
	close(jobs)
	wg.Wait()

	sort.Slice(report.Results, func(i, j int) bool {
		ai, aj := netip.MustParseAddr(report.Results[i].IP), netip.MustParseAddr(report.Results[j].IP)
		if ai != aj {
			return ai.Less(aj)
		}
		return report.Results[i].Port < report.Results[j].Port
	})
	if len(report.Results) > maxBannerResults {
		report.Results = report.Results[:maxBannerResults]
	}
	return report
}

// probeBanner sends one GET / to addr:port. ok=false when nothing answered (refused, timed out, or
// not HTTP and no certificate).
func probeBanner(ctx context.Context, addr netip.Addr, port int, useTLS bool, allowed []netip.Prefix, timeout time.Duration) (Banner, bool) {
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	b := Banner{IP: addr.String(), Port: port, Scheme: scheme}
	target := netip.AddrPortFrom(addr, uint16(port)).String()

	var mu sync.Mutex
	var peer *x509.Certificate
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		Proxy: nil, // never through a proxy: the request goes to the device itself
		// The scope is re-checked at the socket: only the authorized address and port are ever dialled.
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || ap.Addr().Unmap() != addr || int(ap.Port()) != port || !inAny(ap.Addr().Unmap(), allowed) {
				return nil, fmt.Errorf("refusing to dial %s: outside the authorized scope", address)
			}
			return dialer.DialContext(ctx, "tcp4", address)
		},
		TLSClientConfig: &tls.Config{
			// Skipped only to read the device's own certificate; it is labelled tls_self_signed below.
			InsecureSkipVerify: true, //nolint:gosec // read-only certificate inspection, no secret is sent
			VerifyConnection: func(cs tls.ConnectionState) error {
				if len(cs.PeerCertificates) > 0 {
					mu.Lock()
					peer = cs.PeerCertificates[0]
					mu.Unlock()
				}
				return nil
			},
		},
		TLSNextProto:          map[string]func(string, *tls.Conn) http.RoundTripper{}, // HTTP/1.1 only
		DisableKeepAlives:     true,
		MaxIdleConnsPerHost:   -1,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+target+"/", nil)
	if err != nil {
		return b, false
	}
	req.Header.Set("User-Agent", bannerUserAgent)
	req.Header.Set("Accept", "text/html,*/*;q=0.5")

	answered := false
	if resp, err := client.Do(req); err == nil {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBannerBody))
		resp.Body.Close()
		answered = true
		if resp.StatusCode >= 100 && resp.StatusCode <= 599 {
			b.Status = resp.StatusCode
		}
		b.Server = cleanText(resp.Header.Get("Server"), 120)
		b.Title = PageTitle(body)
	}
	mu.Lock()
	cert := peer
	mu.Unlock()
	if cert != nil {
		answered = true
		b.TLSSubject = cleanText(cert.Subject.String(), 300)
		b.TLSIssuer = cleanText(cert.Issuer.String(), 300)
		self := IsSelfSigned(cert)
		b.TLSSelfSigned = &self
	}
	return b, answered
}

// PageTitle returns the text of the first <title> in an HTML body: entities decoded, whitespace
// collapsed, control characters removed, at most 120 bytes. Empty when there is none.
func PageTitle(body []byte) string {
	m := titleRe.FindSubmatch(body)
	if m == nil {
		return ""
	}
	t := html.UnescapeString(string(bytes.ToValidUTF8(m[1], nil)))
	return cleanText(strings.Join(strings.Fields(t), " "), 120)
}

// IsSelfSigned reports whether a certificate names itself as issuer and carries its own signature.
// CheckSignatureFrom is not used: it also demands the CA flag, which most device certificates lack.
// A SHA-1 signature (common on older routers) cannot be checked by Go; issuer = subject decides then.
func IsSelfSigned(c *x509.Certificate) bool {
	if !bytes.Equal(c.RawIssuer, c.RawSubject) {
		return false
	}
	err := c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature)
	var insecure x509.InsecureAlgorithmError
	return err == nil || errors.As(err, &insecure)
}
