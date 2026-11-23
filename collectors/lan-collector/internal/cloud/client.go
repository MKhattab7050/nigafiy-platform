// Package cloud is the collector's only network path to the Nigafiy platform:
// outbound HTTPS requests to three endpoints. The platform never connects to the collector.
package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var (
	// ErrUnauthorized: the credential or enrollment token was refused. Retrying will not help.
	ErrUnauthorized = errors.New("rejected by the server: credential or token is not valid")
	// ErrRejected: the server understood the request and refused its content. Do not resend.
	ErrRejected = errors.New("rejected by the server: payload not accepted")
)

type Scope struct {
	ID   string `json:"id"`
	CIDR string `json:"cidr"`
}

type Check struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	Target          string `json:"target"`
	Port            *int   `json:"port"`
	IntervalSeconds int    `json:"interval_seconds"`
	// Config holds the settings of the watch kinds (http, https, tls_expiry, snmp_oid).
	Config json.RawMessage `json:"config,omitempty"`
	// SNMPTargetID is the Port Detective device an snmp_oid check reads (its credentials arrive with the SNMP config).
	SNMPTargetID string `json:"snmp_target_id,omitempty"`
}

type RemoteConfig struct {
	HeartbeatIntervalSeconds int `json:"heartbeat_interval_seconds"`
	Discovery                struct {
		IntervalSeconds int     `json:"interval_seconds"`
		Scopes          []Scope `json:"scopes"`
	} `json:"discovery"`
	Checks []Check `json:"checks"`
	// Access is the network-wide access-control (DNS filter) policy; decoded by the agent.
	Access json.RawMessage `json:"access,omitempty"`
	// SNMP lists the switches to read for Port Detective. It carries read credentials, so the
	// agent never writes it to the on-disk configuration cache.
	SNMP json.RawMessage `json:"snmp,omitempty"`
	// Routers lists the site's routers this collector may read and control. It carries the router
	// administrator credentials, so — like SNMP — it is never written to the on-disk cache.
	Routers json.RawMessage `json:"routers,omitempty"`
	// SmartChecks holds the smart-check schedules and "run now" requests (agent/smartchecks.go).
	// Not secret: it is cached on disk (without the "run now" requests).
	SmartChecks json.RawMessage `json:"smart_checks,omitempty"`
	// MNDP says whether the site allows the passive MikroTik neighbour listener. Absent: allowed.
	MNDP *MNDPConfig `json:"mndp,omitempty"`
}

type MNDPConfig struct {
	Enabled bool `json:"enabled"`
}

type Command struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type HeartbeatRequest struct {
	Version           string   `json:"version"`
	Hostname          string   `json:"hostname"`
	OS                string   `json:"os"`
	Arch              string   `json:"arch"`
	UptimeSeconds     int64    `json:"uptime_seconds"`
	GatewayIP         string   `json:"gateway_ip,omitempty"`
	Interfaces        any      `json:"interfaces"`
	SpoolDepth        int      `json:"spool_depth"`
	CompletedCommands []string `json:"completed_commands"`
	AccessStatus      any      `json:"access_status,omitempty"`
	MNDPStatus        any      `json:"mndp_status,omitempty"`
}

type HeartbeatResponse struct {
	ServerTime string       `json:"server_time"`
	Config     RemoteConfig `json:"config"`
	Commands   []Command    `json:"commands"`
}

type EnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Hostname        string `json:"hostname"`
	Version         string `json:"version"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
}

type EnrollResponse struct {
	CollectorID string `json:"collector_id"`
	Credential  string `json:"credential"`
}

type Client struct {
	base       *url.URL
	http       *http.Client
	credential string
	userAgent  string
}

// ParsePin parses a SHA-256 certificate fingerprint given as 64 hex digits or colon-separated hex bytes.
func ParsePin(s string) ([]byte, error) {
	clean := strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimSpace(s)))
	b, err := hex.DecodeString(clean)
	if err != nil || len(b) != 32 {
		return nil, errors.New("tls_pin_sha256 must be a SHA-256 fingerprint (64 hex digits, optionally colon-separated)")
	}
	return b, nil
}

func New(serverURL, caFile, version string, tlsPinSHA256 ...string) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(serverURL, "/"))
	if err != nil {
		return nil, err
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read ca_file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("ca_file contains no certificates")
		}
		tlsCfg.RootCAs = pool
	}
	if len(tlsPinSHA256) > 0 && strings.TrimSpace(tlsPinSHA256[0]) != "" {
		pin, err := ParsePin(tlsPinSHA256[0])
		if err != nil {
			return nil, err
		}
		want := append([]byte(nil), pin...)
		tlsCfg.InsecureSkipVerify = true // replaced by explicit SHA-256 pin verification below
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error { return VerifyPinnedChain(cs.PeerCertificates, want, time.Now()) }
	}
	return &Client{
		base: base,
		http: &http.Client{
			Timeout:   20 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConns: 4, IdleConnTimeout: 90 * time.Second, Proxy: http.ProxyFromEnvironment},
			// The API never redirects. Refusing redirects keeps the credential from following one.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		userAgent: "nigafiy-sensor/" + version,
	}, nil
}

func (c *Client) SetCredential(credential string) { c.credential = credential }

func (c *Client) post(ctx context.Context, path string, body []byte, authenticated bool, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base.String()+"/api/v1/collector"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+c.credential)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// url.Error would include the full URL; keep log lines short and free of anything sensitive.
		var ue *url.Error
		if errors.As(err, &ue) {
			return fmt.Errorf("cloud unreachable: %w", ue.Err)
		}
		return fmt.Errorf("cloud unreachable: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		if out != nil {
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("unreadable server response: %w", err)
			}
		}
		return nil
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusRequestEntityTooLarge || resp.StatusCode == http.StatusUnprocessableEntity:
		return fmt.Errorf("%w (HTTP %d)", ErrRejected, resp.StatusCode)
	default: // 429, 5xx, proxies … → transient
		return fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	body, _ := json.Marshal(req)
	var out EnrollResponse
	if err := c.post(ctx, "/enroll", body, false, &out); err != nil {
		return nil, err
	}
	if out.Credential == "" || out.CollectorID == "" {
		return nil, errors.New("server returned an empty credential")
	}
	return &out, nil
}

func (c *Client) Heartbeat(ctx context.Context, req HeartbeatRequest) (*HeartbeatResponse, error) {
	if req.CompletedCommands == nil {
		req.CompletedCommands = []string{}
	}
	body, _ := json.Marshal(req)
	var out HeartbeatResponse
	if err := c.post(ctx, "/heartbeat", body, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendBatch uploads one already-serialised telemetry batch.
func (c *Client) SendBatch(ctx context.Context, batch []byte) error {
	return c.post(ctx, "/telemetry", batch, true, nil)
}

// Backoff produces exponentially growing, jittered delays.
type Backoff struct {
	Min, Max time.Duration
	attempt  int
}

func (b *Backoff) Next() time.Duration {
	d := b.Min << min(b.attempt, 20)
	if d > b.Max || d <= 0 {
		d = b.Max
	}
	b.attempt++
	// Full jitter in the upper half: many collectors recovering from the same outage do not
	// hit the cloud in lockstep.
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

func (b *Backoff) Reset() { b.attempt = 0 }

// VerifyPinnedChain accepts the server when the pin is either
//   - the SHA-256 of the leaf (server) certificate, or
//   - the SHA-256 of a CA certificate in the presented chain, and the leaf verifies up to that CA
//     (signature, validity, serverAuth usage) with the pinned certificate as the only root.
//
// The second form is what built-in LAN TLS uses: the server pins its local CA, so the server
// certificate can be re-issued without re-enrolling. The host name is not checked against the
// certificate in either form; the pin alone identifies the server.
func VerifyPinnedChain(chain []*x509.Certificate, want []byte, now time.Time) error {
	if len(chain) == 0 {
		return errors.New("tls pin verification failed: server presented no certificate")
	}
	leafSum := sha256.Sum256(chain[0].Raw)
	if subtle.ConstantTimeCompare(leafSum[:], want) == 1 {
		return nil
	}
	for i, c := range chain {
		if i == 0 || !c.IsCA {
			continue
		}
		sum := sha256.Sum256(c.Raw)
		if subtle.ConstantTimeCompare(sum[:], want) != 1 {
			continue
		}
		roots := x509.NewCertPool()
		roots.AddCert(c)
		inter := x509.NewCertPool()
		for j, o := range chain {
			if j != 0 && j != i {
				inter.AddCert(o)
			}
		}
		_, err := chain[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		if err != nil {
			return fmt.Errorf("tls pin verification failed: server certificate does not verify against the pinned CA: %w", err)
		}
		return nil
	}
	return fmt.Errorf("tls pin mismatch: server leaf certificate sha256 %x does not match configured pin", leafSum[:])
}
