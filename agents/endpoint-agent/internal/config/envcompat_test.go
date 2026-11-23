package config

import (
	"sync"
	"testing"
)

func TestGetenvFallsBackToLegacy(t *testing.T) {
	warned = sync.Map{}
	var warnings []string
	prev := warnLegacy
	warnLegacy = func(old, name string) { warnings = append(warnings, old+"->"+name) }
	t.Cleanup(func() { warnLegacy = prev; warned = sync.Map{} })

	t.Setenv("LAN_ENDPOINT_SERVER_URL", "https://old.example.test")
	if v := Getenv("NIGAFIY_AGENT_SERVER_URL"); v != "https://old.example.test" {
		t.Fatalf("legacy only: %q", v)
	}
	Getenv("NIGAFIY_AGENT_SERVER_URL")
	if len(warnings) != 1 {
		t.Fatalf("warnings %v", warnings)
	}
	if cfg := FromEnv(); cfg.ServerURL != "https://old.example.test" {
		t.Fatalf("FromEnv legacy: %q", cfg.ServerURL)
	}
	t.Setenv("NIGAFIY_AGENT_SERVER_URL", "https://new.example.test")
	if cfg := FromEnv(); cfg.ServerURL != "https://new.example.test" {
		t.Fatalf("FromEnv new wins: %q", cfg.ServerURL)
	}
	if v := Getenv("NIGAFIY_AGENT_CA_FILE"); v != "" {
		t.Fatalf("neither: %q", v)
	}
	t.Setenv("LAN_ENDPOINT_ALLOW_INSECURE_HTTP", "1")
	if cfg := FromEnv(); !cfg.AllowInsecureHTTP {
		t.Fatal("legacy insecure flag ignored")
	}
}
