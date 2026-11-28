package agent

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/sysinfo"
)

// A command handler that panics fails only that command; the agent itself keeps running.
func TestPanickingCommandBecomesAFailedResult(t *testing.T) {
	cfg := &config.Config{
		ServerURL:       "https://127.0.0.1:1",
		EnrollmentToken: "ldea_test-token-01234567890123456789",
		StateDir:        t.TempDir(),
		LogLevel:        "error",
	}
	deps := Deps{
		CollectHealth:    func(context.Context, time.Time) sysinfo.Health { return sysinfo.Health{} },
		CollectInventory: func(context.Context) sysinfo.Inventory { return sysinfo.Inventory{} },
		ExecuteCommand: func(_ context.Context, cmd control.Command) control.Result {
			if cmd.Kind == "boom" {
				var m map[string]int
				m["x"] = 1 // nil map write: a real runtime panic
			}
			return control.Result{ID: cmd.ID, OK: true}
		},
	}
	ag, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "0.1.0-test", DefaultTuning())
	if err != nil {
		t.Fatal(err)
	}
	res := ag.execute(context.Background(), control.Command{ID: "c1", Kind: "boom"})
	if res.ID != "c1" || res.OK || !strings.Contains(res.Error, "internal error") {
		t.Fatalf("panic result: %+v", res)
	}
	if res := ag.execute(context.Background(), control.Command{ID: "c2", Kind: "fine"}); !res.OK {
		t.Fatalf("next command after a panic: %+v", res)
	}
}
