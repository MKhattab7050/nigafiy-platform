package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/sysinfo"
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
	// The health marker hook: once at start (no heartbeat yet), then after accepted heartbeats.
	var healthStarts, healthBeats int
	deps.Health = func(started, last time.Time) {
		mu.Lock()
		defer mu.Unlock()
		if started.IsZero() {
			t.Error("health marker without a start time")
		}
		if last.IsZero() {
			healthStarts++
		} else {
			healthBeats++
		}
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
	if healthStarts != 1 || healthBeats < 1 || healthBeats > heartbeats {
		t.Fatalf("health marker: %d starts, %d heartbeats (server saw %d)", healthStarts, healthBeats, heartbeats)
	}
}

func formatColonPin(sum []byte) string {
	h := strings.ToUpper(hex.EncodeToString(sum))
	var parts []string
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}

func TestEndpointAgentTLSPinning(t *testing.T) {
	var enrollPayload, hbPayload map[string]any
	var mu sync.Mutex
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/agent/enroll":
			_ = json.NewDecoder(r.Body).Decode(&enrollPayload)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"endpoint_id": "ep-tls",
				"credential":  "lda_ep-tls.secret",
			})
		case "/api/v1/agent/heartbeat":
			_ = json.NewDecoder(r.Body).Decode(&hbPayload)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"heartbeat_interval_seconds": 10,
				"commands":                   []any{},
			})
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer srv.Close()

	leafSum := sha256.Sum256(srv.Certificate().Raw)
	colonPin := formatColonPin(leafSum[:])
	wrongPin := strings.Repeat("00", 32)

	deps := Deps{
		CollectHealth: func(_ context.Context, _ time.Time) sysinfo.Health {
			// RAMTotalMB intentionally 0 to verify it is omitted when unmeasured
			return sysinfo.Health{
				Hostname:      "unmeasured-ram-host",
				OS:            "linux",
				Arch:          "amd64",
				CPUCores:      4,
				RAMTotalMB:    0,
				LoggedInUsers: []string{},
			}
		},
		CollectInventory: func(_ context.Context) sysinfo.Inventory {
			return sysinfo.Inventory{}
		},
		ExecuteCommand: func(_ context.Context, cmd control.Command) control.Result {
			return control.Result{ID: cmd.ID, OK: true}
		},
	}

	// 1. Wrong pin must fail TLS handshake.
	badCfg := &config.Config{
		ServerURL:       srv.URL,
		EnrollmentToken: "ldea_test-token-01234567890123456789",
		StateDir:        t.TempDir(),
		TLSPinSHA256:    wrongPin,
		LogLevel:        "error",
	}
	if err := badCfg.Validate(); err != nil {
		t.Fatalf("expected valid config with 64-hex pin: %v", err)
	}
	badAgent, err := New(badCfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "0.1.0-test", DefaultTuning())
	if err != nil {
		t.Fatal(err)
	}
	if err := badAgent.ensureEnrolled(context.Background()); err == nil || !strings.Contains(err.Error(), "tls pin mismatch") {
		t.Fatalf("expected tls pin mismatch error, got %v", err)
	}

	// 2. Matching colon-separated pin must succeed against self-signed TLS server.
	goodCfg := &config.Config{
		ServerURL:       srv.URL,
		EnrollmentToken: "ldea_test-token-01234567890123456789",
		StateDir:        t.TempDir(),
		TLSPinSHA256:    colonPin,
		LogLevel:        "error",
	}
	if err := goodCfg.Validate(); err != nil {
		t.Fatalf("expected valid config with colon-separated pin: %v", err)
	}
	goodAgent, err := New(goodCfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "0.1.0-test", DefaultTuning())
	if err != nil {
		t.Fatal(err)
	}
	if err := goodAgent.ensureEnrolled(context.Background()); err != nil {
		t.Fatalf("expected enrollment over pinned TLS to succeed, got %v", err)
	}
	attempt := 0
	_ = goodAgent.heartbeatOnce(context.Background(), &attempt)
	if attempt != 0 {
		t.Fatalf("expected heartbeat over pinned TLS to succeed, attempt=%d", attempt)
	}

	// 3. Verify ram_total_mb was omitted when RAMTotalMB == 0.
	mu.Lock()
	defer mu.Unlock()
	if _, present := enrollPayload["ram_total_mb"]; present {
		t.Fatalf("expected ram_total_mb to be omitted from enroll payload when 0, got %+v", enrollPayload)
	}
	if _, present := hbPayload["ram_total_mb"]; present {
		t.Fatalf("expected ram_total_mb to be omitted from heartbeat payload when 0, got %+v", hbPayload)
	}
}
