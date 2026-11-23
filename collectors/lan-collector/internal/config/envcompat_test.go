package config

import (
	"strings"
	"sync"
	"testing"
)

func TestGetenvFallsBackToLegacy(t *testing.T) {
	warned = sync.Map{}
	var warnings []string
	prev := warnLegacy
	warnLegacy = func(old, name string) { warnings = append(warnings, old+"->"+name) }
	t.Cleanup(func() { warnLegacy = prev; warned = sync.Map{} })

	t.Setenv("LAN_COLLECTOR_STATE_DIR", "/old")
	if v := Getenv("NIGAFIY_SENSOR_STATE_DIR"); v != "/old" {
		t.Fatalf("legacy only: %q", v)
	}
	Getenv("NIGAFIY_SENSOR_STATE_DIR")
	if len(warnings) != 1 || warnings[0] != "LAN_COLLECTOR_STATE_DIR->NIGAFIY_SENSOR_STATE_DIR" {
		t.Fatalf("warnings %v", warnings)
	}
	t.Setenv("NIGAFIY_SENSOR_STATE_DIR", "/new")
	if v := Getenv("NIGAFIY_SENSOR_STATE_DIR"); v != "/new" {
		t.Fatalf("both: %q", v)
	}
	if v := Getenv("NIGAFIY_SENSOR_DNS_LISTEN"); v != "" {
		t.Fatalf("neither: %q", v)
	}
	for name, old := range LegacyEnv {
		if !strings.HasPrefix(name, "NIGAFIY_SENSOR_") || old != "LAN_COLLECTOR_"+strings.TrimPrefix(name, "NIGAFIY_SENSOR_") {
			t.Errorf("table entry %s -> %s", name, old)
		}
	}
}

func TestLoadReadsLegacyCollectorEnv(t *testing.T) {
	t.Setenv("LAN_COLLECTOR_SERVER_URL", "https://old.example.test")
	t.Setenv("LAN_COLLECTOR_STATE_DIR", t.TempDir())
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://old.example.test" {
		t.Fatalf("server url %q", cfg.ServerURL)
	}
	t.Setenv("NIGAFIY_SENSOR_SERVER_URL", "https://new.example.test")
	cfg, err = Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://new.example.test" {
		t.Fatalf("new name should win: %q", cfg.ServerURL)
	}
}
