// Package config loads and validates the endpoint agent's local configuration.
package config

import (
	"bufio"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	// DisableWebRTC: NIGAFIY_AGENT_RD_WEBRTC=off keeps remote desktop on the WebSocket + JPEG
	// stream (the hello then says WebRTC is not available, and every viewer uses JPEG).
	DisableWebRTC bool
}

func FromEnv() Config {
	cfg := Config{
		ServerURL:         Getenv("NIGAFIY_AGENT_SERVER_URL"),
		EnrollmentToken:   Getenv("NIGAFIY_AGENT_ENROLLMENT_TOKEN"),
		StateDir:          Getenv("NIGAFIY_AGENT_STATE_DIR"),
		CAFile:            Getenv("NIGAFIY_AGENT_CA_FILE"),
		TLSPinSHA256:      Getenv("NIGAFIY_AGENT_TLS_PIN_SHA256"),
		LogLevel:          Getenv("NIGAFIY_AGENT_LOG_LEVEL"),
		AllowInsecureHTTP: Getenv("NIGAFIY_AGENT_ALLOW_INSECURE_HTTP") == "true" || Getenv("NIGAFIY_AGENT_ALLOW_INSECURE_HTTP") == "1",
		DisableWebRTC:     strings.EqualFold(Getenv("NIGAFIY_AGENT_RD_WEBRTC"), "off"),
	}
	if cfg.StateDir == "" {
		cfg.StateDir = "./state-endpoint"
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	return cfg
}

// ParsePin parses a SHA-256 certificate fingerprint given as 64 hex characters or colon-separated
// hex bytes, with or without a "sha256:" prefix (any case), the form the console shows.
func ParsePin(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if len(s) >= 7 && strings.EqualFold(s[:7], "sha256:") {
		s = s[7:]
	}
	clean := strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(s))
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

// maxTokenFile bounds what ReadTokenFile reads: an enrollment token is one short line.
const maxTokenFile = 4096

// ReadTokenFile returns the first line of path, trimmed: the enrollment token for -token-file. The
// file's content never appears in an error (only its path), so it cannot reach a log.
func ReadTokenFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("cannot read the token file %s: %w", path, errors.Unwrap(err))
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("cannot read the token file %s", path)
	}
	if st.IsDir() {
		return "", fmt.Errorf("the token file %s is a folder", path)
	}
	if st.Size() > maxTokenFile {
		return "", fmt.Errorf("the token file %s is larger than %d bytes; it must hold the token on its first line", path, maxTokenFile)
	}
	line, err := bufio.NewReader(io.LimitReader(f, maxTokenFile)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("cannot read the token file %s", path)
	}
	token := strings.TrimSpace(strings.TrimPrefix(line, "\xef\xbb\xbf"))
	if token == "" {
		return "", fmt.Errorf("the token file %s has no token on its first line", path)
	}
	return token, nil
}

// Connect is what a connection code carries: everything an agent needs to enroll.
type Connect struct {
	Server string
	Token  string
	Pin    string // "" when the server needs no pin
}

// ParseConnectCode reads the one-line connection code the dashboard shows,
// nigafiy://enroll?server=…&token=…&pin=… (the same link the Android agent takes, EnrollLink.kt).
// It also finds the code inside a longer pasted line, such as a whole install command. The token
// never appears in an error.
func ParseConnectCode(s string) (Connect, error) {
	s = strings.TrimSpace(strings.TrimPrefix(s, "\xef\xbb\xbf"))
	if i := strings.Index(strings.ToLower(s), "nigafiy://"); i >= 0 {
		s = s[i:]
		if j := strings.IndexAny(s, " \t\r\n\"'"); j >= 0 {
			s = s[:j]
		}
	}
	u, err := url.Parse(s)
	if err != nil || !strings.EqualFold(u.Scheme, "nigafiy") || !strings.EqualFold(u.Host, "enroll") {
		return Connect{}, errors.New("not a Nigafiy connection code (it starts with nigafiy://enroll?)")
	}
	q := u.Query()
	c := Connect{Server: strings.TrimRight(strings.TrimSpace(q.Get("server")), "/"), Token: strings.TrimSpace(q.Get("token")), Pin: strings.TrimSpace(q.Get("pin"))}
	if c.Server == "" {
		return Connect{}, errors.New("the connection code has no server address")
	}
	if c.Token == "" {
		return Connect{}, errors.New("the connection code has no enrollment token")
	}
	if c.Pin != "" {
		if _, err := ParsePin(c.Pin); err != nil {
			return Connect{}, errors.New("the connection code's certificate pin is not a SHA-256 fingerprint")
		}
	}
	return c, nil
}

// Apply puts the code's server, token and pin into the configuration.
func (c Connect) Apply(cfg *Config) {
	cfg.ServerURL = c.Server
	cfg.EnrollmentToken = c.Token
	if c.Pin != "" {
		cfg.TLSPinSHA256 = c.Pin
	}
}
