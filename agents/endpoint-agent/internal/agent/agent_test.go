package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/endpoint-agent/internal/config"
	"github.com/lan-detective/endpoint-agent/internal/control"
	"github.com/lan-detective/endpoint-agent/internal/sysinfo"
)

func TestEndpointAgentLifecycleAndCommands(t *testing.T) {
	var mu sync.Mutex
	enrolled := 0
	heartbeats := 0
	inventories := 0
	var lastResults []control.Result
	pendingCmd := true

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/agent/enroll":
			enrolled++
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"endpoint_id": "ep-1",
				"credential":  "lda_ep-1.secret",
			})
		case "/api/v1/agent/heartbeat":
			var body struct {
				CommandResults []control.Result `json:"command_results"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			heartbeats++
			if len(body.CommandResults) > 0 {
				lastResults = append(lastResults, body.CommandResults...)
			}
			var cmds []map[string]any
			if pendingCmd {
				pendingCmd = false
				cmds = append(cmds, map[string]any{
					"id":      "cmd-1",
					"kind":    "kill_process",
					"payload": map[string]any{"pid": 4444, "name": "notepad.exe"},
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"heartbeat_interval_seconds": 1,
				"commands":                   cmds,
			})
		case "/api/v1/agent/inventory":
			inventories++
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer srv.Close()

	cfg := &config.Config{
		ServerURL:         srv.URL,
		EnrollmentToken:   "ldea_test-token-01234567890123456789",
		StateDir:          t.TempDir(),
		LogLevel:          "error",
		AllowInsecureHTTP: true,
	}
	deps := Deps{
		CollectHealth: func(_ context.Context, _ time.Time) sysinfo.Health {
			return sysinfo.Health{
				Hostname:      "pc-1",
				OS:            "windows",
				Arch:          "amd64",
				CPUCores:      8,
				RAMTotalMB:    16384,
				RAMUsedMB:     8192,
				RAMPct:        50,
				CPUPct:        12.5,
				LoggedInUsers: []string{"alice"},
				PrimaryIP:     "192.168.1.50",
				PrimaryMAC:    "00:11:22:33:44:55",
			}
		},
		CollectInventory: func(_ context.Context) sysinfo.Inventory {
			return sysinfo.Inventory{
				Processes: []sysinfo.Process{{PID: 4444, Name: "notepad.exe", MemMB: 25}},
			}
		},
		ExecuteCommand: func(_ context.Context, cmd control.Command) control.Result {
			return control.Result{ID: cmd.ID, OK: true, Output: "killed 4444"}
		},
	}

	ag, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "0.1.0-test", Tuning{
		HeartbeatInterval: 50 * time.Millisecond,
		InventoryInterval: 100 * time.Millisecond,
		MaxBackoff:        100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ag.Run(ctx) }()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ok := enrolled == 1 && inventories >= 1 && len(lastResults) == 1
		mu.Unlock()
		if ok {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()
	<-done

	mu.Lock()
	defer mu.Unlock()
	if enrolled != 1 || inventories < 1 || len(lastResults) != 1 || lastResults[0].ID != "cmd-1" || !lastResults[0].OK {
		t.Fatalf("unexpected state: enrolled=%d inventories=%d results=%+v", enrolled, inventories, lastResults)
	}
}

