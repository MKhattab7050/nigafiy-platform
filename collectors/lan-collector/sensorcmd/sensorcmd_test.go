package sensorcmd

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFlagsOutputAndExitCodes(t *testing.T) {
	for _, k := range []string{"NIGAFIY_SENSOR_CONFIG", "LAN_COLLECTOR_CONFIG", "NIGAFIY_SENSOR_SERVER_URL", "LAN_COLLECTOR_SERVER_URL"} {
		t.Setenv(k, "")
	}
	ctx := context.Background()
	var out, errOut bytes.Buffer
	if code := Run(ctx, []string{"-version"}, &out, &errOut, "1.2.3"); code != ExitOK || strings.TrimSpace(out.String()) != "nigafiy-sensor 1.2.3" {
		t.Fatalf("-version: %d %q", code, out.String())
	}
	if code := Run(ctx, []string{"-h"}, &out, &errOut, "1"); code != ExitOK || !strings.Contains(errOut.String(), "-check-config") {
		t.Fatalf("-h: %d %q", code, errOut.String())
	}
	if code := Run(ctx, []string{"-nope"}, &out, &errOut, "1"); code != ExitUsage {
		t.Fatalf("bad flag: %d", code)
	}
	if code := Run(ctx, []string{"stray"}, &out, &errOut, "1"); code != ExitUsage {
		t.Fatalf("stray argument: %d", code)
	}
	// Nothing configured: invalid configuration, exit 2.
	if code := Run(ctx, []string{"-check-config"}, &out, &errOut, "1"); code != ExitUsage {
		t.Fatalf("no configuration: %d", code)
	}
	dir := t.TempDir()
	cfg := filepath.Join(dir, "collector.yaml")
	os.WriteFile(cfg, []byte("server_url: https://nigafiy.example.com\n"), 0o600)
	out.Reset()
	if code := Run(ctx, []string{"-config", cfg, "-check-config"}, &out, &errOut, "1"); code != ExitOK || !strings.Contains(out.String(), "configuration is valid") {
		t.Fatalf("valid file: %d %q %q", code, out.String(), errOut.String())
	}
	// The legacy name of the config variable picks the file.
	t.Setenv("LAN_COLLECTOR_CONFIG", cfg)
	out.Reset()
	if code := Run(ctx, []string{"-check-config"}, &out, &errOut, "1"); code != ExitOK {
		t.Fatalf("LAN_COLLECTOR_CONFIG: %d %q", code, errOut.String())
	}
}
