// Package config loads and validates the collector's local configuration.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Hard ceilings. Neither the config file nor the cloud can raise these.
const (
	HardMaxConcurrency = 128
	HardMaxPPS         = 500
	MinScopePrefixBits = 20 // largest scope a collector will ever sweep: /20 (4096 addresses)
)

type Limits struct {
	MaxConcurrency int `yaml:"max_concurrency"`
	MaxPPS         int `yaml:"max_pps"`
	PingTimeoutMs  int `yaml:"ping_timeout_ms"`
}

type Config struct {
	// ServerURL is the LAN Detective cloud API. The collector only ever makes outbound requests to it.
	ServerURL string `yaml:"server_url"`
	// EnrollmentToken is needed once, on first start. Prefer the LAN_COLLECTOR_ENROLLMENT_TOKEN env var.
	EnrollmentToken string `yaml:"enrollment_token"`
	StateDir        string `yaml:"state_dir"`
	// AllowedCIDRs is an optional local allow-list. When set, scopes delivered by the cloud are
	// probed only if they fall entirely inside one of these ranges.
	AllowedCIDRs []string `yaml:"allowed_cidrs"`
	Limits       Limits   `yaml:"limits"`
	// SpoolMaxBatches bounds the on-disk buffer used while the cloud is unreachable.
	SpoolMaxBatches int    `yaml:"spool_max_batches"`
	CAFile          string `yaml:"ca_file"`
	LogLevel        string `yaml:"log_level"`
	// DNSListen is where the access-control DNS filter answers once the owner turns it on in
	// LAN Detective. Default ":53"; "off" disables the feature on this collector.
	DNSListen string `yaml:"dns_listen"`
	// Development/test switches. Both default to false.
	AllowInsecureHTTP   bool `yaml:"allow_insecure_http"`
	AllowLoopbackScopes bool `yaml:"allow_loopback_scopes"`

	allowed []netip.Prefix
}

func defaults() Config {
	return Config{
		StateDir:        "./state",
		Limits:          Limits{MaxConcurrency: 32, MaxPPS: 50, PingTimeoutMs: 1000},
		SpoolMaxBatches: 5000,
		LogLevel:        "info",
		DNSListen:       ":53",
	}
}

// Load reads the YAML file at path (optional when everything comes from the environment),
// applies environment overrides and validates the result.
func Load(path string) (*Config, error) {
	cfg := defaults()
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config: %w", err)
		}
		dec := yaml.NewDecoder(strings.NewReader(string(raw)))
		dec.KnownFields(true) // a typo in a safety-relevant key must not be silently ignored
		if err := dec.Decode(&cfg); err != nil {
			return nil, fmt.Errorf("parse config %s: %w", path, err)
		}
	}
	if v := os.Getenv("LAN_COLLECTOR_SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("LAN_COLLECTOR_ENROLLMENT_TOKEN"); v != "" {
		cfg.EnrollmentToken = v
	}
	if v := os.Getenv("LAN_COLLECTOR_DNS_LISTEN"); v != "" {
		cfg.DNSListen = v
	}
	if v := os.Getenv("LAN_COLLECTOR_STATE_DIR"); v != "" {
		cfg.StateDir = v
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Validate rejects any configuration the collector should not run with.
func (c *Config) Validate() error {
	var problems []string
	u, err := url.Parse(c.ServerURL)
	switch {
	case c.ServerURL == "":
		problems = append(problems, "server_url is required")
	case err != nil || u.Host == "":
		problems = append(problems, "server_url is not a valid URL")
	case u.User != nil:
		problems = append(problems, "server_url must not contain credentials")
	case u.Scheme == "http" && !c.AllowInsecureHTTP:
		problems = append(problems, "server_url must use https:// (plain http needs allow_insecure_http: true and is for local development only)")
	case u.Scheme != "https" && u.Scheme != "http":
		problems = append(problems, "server_url must use https://")
	}
	if c.StateDir == "" {
		problems = append(problems, "state_dir is required")
	}
	if c.Limits.MaxConcurrency < 1 || c.Limits.MaxConcurrency > HardMaxConcurrency {
		problems = append(problems, fmt.Sprintf("limits.max_concurrency must be between 1 and %d", HardMaxConcurrency))
	}
	if c.Limits.MaxPPS < 1 || c.Limits.MaxPPS > HardMaxPPS {
		problems = append(problems, fmt.Sprintf("limits.max_pps must be between 1 and %d", HardMaxPPS))
	}
	if c.Limits.PingTimeoutMs < 100 || c.Limits.PingTimeoutMs > 10000 {
		problems = append(problems, "limits.ping_timeout_ms must be between 100 and 10000")
	}
	if c.SpoolMaxBatches < 10 || c.SpoolMaxBatches > 1_000_000 {
		problems = append(problems, "spool_max_batches must be between 10 and 1000000")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, "log_level must be one of debug, info, warn, error")
	}
	c.allowed = c.allowed[:0]
	for _, raw := range c.AllowedCIDRs {
		p, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || !p.Addr().Is4() {
			problems = append(problems, fmt.Sprintf("allowed_cidrs: %q is not an IPv4 CIDR", raw))
			continue
		}
		c.allowed = append(c.allowed, p.Masked())
	}
	if len(problems) > 0 {
		return errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return nil
}

// Allowed returns the parsed local allow-list (empty = no additional local restriction).
func (c *Config) Allowed() []netip.Prefix { return c.allowed }
