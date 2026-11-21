package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "collector.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadValid(t *testing.T) {
	cfg, err := Load(write(t, "server_url: https://ld.example.com\nallowed_cidrs: [\"192.168.1.9/24\"]\nlimits: {max_concurrency: 16, max_pps: 20, ping_timeout_ms: 800}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Limits.MaxPPS != 20 || cfg.Allowed()[0].String() != "192.168.1.0/24" || cfg.StateDir != "./state" {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestLoadRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"missing server":        "state_dir: ./s\n",
		"plain http":            "server_url: http://ld.example.com\n",
		"credentials in url":    "server_url: https://user:pw@ld.example.com\n",
		"unknown key (typo)":    "server_url: https://ld.example.com\nallowed_cidr: [\"10.0.0.0/8\"]\n",
		"pps above hard cap":    "server_url: https://ld.example.com\nlimits: {max_concurrency: 8, max_pps: 100000, ping_timeout_ms: 1000}\n",
		"concurrency above cap": "server_url: https://ld.example.com\nlimits: {max_concurrency: 5000, max_pps: 10, ping_timeout_ms: 1000}\n",
		"zero pps":              "server_url: https://ld.example.com\nlimits: {max_concurrency: 8, max_pps: 0, ping_timeout_ms: 1000}\n",
		"bad allow-list":        "server_url: https://ld.example.com\nallowed_cidrs: [\"everything\"]\n",
		"bad log level":         "server_url: https://ld.example.com\nlog_level: verbose\n",
		"bad tls pin":           "server_url: https://ld.example.com\ntls_pin_sha256: not-a-sha256\n",
		"not yaml":              "{{{{",
	}
	for name, body := range cases {
		if _, err := Load(write(t, body)); err == nil {
			t.Errorf("%s: expected the configuration to be rejected", name)
		}
	}
}

func TestInsecureHTTPNeedsExplicitOptIn(t *testing.T) {
	if _, err := Load(write(t, "server_url: http://localhost:4100\nallow_insecure_http: true\n")); err != nil {
		t.Fatalf("explicit opt-in should be accepted: %v", err)
	}
	_, err := Load(write(t, "server_url: http://localhost:4100\n"))
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("expected https error, got %v", err)
	}
}
