// Package config loads and validates the endpoint agent's local configuration.
package config

import (
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	ServerURL         string
	EnrollmentToken   string
	StateDir          string
	CAFile            string
	TLSPinSHA256      string
	LogLevel          string
	AllowInsecureHTTP bool
}

func FromEnv() Config {
	cfg := Config{
		ServerURL:         os.Getenv("LAN_ENDPOINT_SERVER_URL"),
		EnrollmentToken:   os.Getenv("LAN_ENDPOINT_ENROLLMENT_TOKEN"),
		StateDir:          os.Getenv("LAN_ENDPOINT_STATE_DIR"),
		CAFile:            os.Getenv("LAN_ENDPOINT_CA_FILE"),
		TLSPinSHA256:      os.Getenv("LAN_ENDPOINT_TLS_PIN_SHA256"),
		LogLevel:          os.Getenv("LAN_ENDPOINT_LOG_LEVEL"),
		AllowInsecureHTTP: os.Getenv("LAN_ENDPOINT_ALLOW_INSECURE_HTTP") == "true" || os.Getenv("LAN_ENDPOINT_ALLOW_INSECURE_HTTP") == "1",
	}
	if cfg.StateDir == "" {
		cfg.StateDir = "./state-endpoint"
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	return cfg
}

// ParsePin parses a SHA-256 certificate fingerprint given as 64 hex characters or colon-separated hex bytes.
func ParsePin(s string) ([]byte, error) {
	clean := strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimSpace(s)))
	b, err := hex.DecodeString(clean)
	if err != nil || len(b) != 32 {
		return nil, errors.New("tls_pin_sha256 must be a SHA-256 fingerprint (64 hex digits, optionally colon-separated)")
	}
	return b, nil
}

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
		problems = append(problems, "server_url must use https:// (plain http needs allow_insecure_http for local development)")
	case u.Scheme != "https" && u.Scheme != "http":
		problems = append(problems, "server_url must use https://")
	}
	if strings.TrimSpace(c.StateDir) == "" {
		problems = append(problems, "state_dir is required")
	}
	if strings.TrimSpace(c.TLSPinSHA256) != "" {
		if _, err := ParsePin(c.TLSPinSHA256); err != nil {
			problems = append(problems, err.Error())
		}
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, "log_level must be one of debug, info, warn, error")
	}
	if len(problems) > 0 {
		return errors.New("invalid configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return nil
}

