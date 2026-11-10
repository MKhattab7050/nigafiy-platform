// Package config loads and validates the endpoint agent's local configuration.
package config

import (
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
	LogLevel          string
	AllowInsecureHTTP bool
}

func FromEnv() Config {
	cfg := Config{
		ServerURL:         os.Getenv("LAN_ENDPOINT_SERVER_URL"),
		EnrollmentToken:   os.Getenv("LAN_ENDPOINT_ENROLLMENT_TOKEN"),
		StateDir:          os.Getenv("LAN_ENDPOINT_STATE_DIR"),
		CAFile:            os.Getenv("LAN_ENDPOINT_CA_FILE"),
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

