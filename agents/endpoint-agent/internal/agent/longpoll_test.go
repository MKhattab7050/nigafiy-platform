package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/sysinfo"
)

func TestNextPollDelay(t *testing.T) {
	lp := 20 * time.Second
	iv := 500 * time.Millisecond
	cases := []struct {
		took time.Duration
		n    int
		want time.Duration
	}{
		{time.Millisecond, 2, 0},       // commands: poll again at once
		{19 * time.Second, 0, 0},       // the server held the poll: poll again at once
		{30 * time.Millisecond, 0, iv}, // an old server answered at once: do not spin
		{9 * time.Second, 0, iv},       // shorter than half the wait: treat as not held
		{10 * time.Second, 0, 0},       // exactly half: held
	}
	for _, c := range cases {
		if got := nextPollDelay(lp, iv, c.took, c.n); got != c.want {
			t.Errorf("nextPollDelay(took=%v, n=%d) = %v, want %v", c.took, c.n, got, c.want)
		}
	}
	if got := nextPollDelay(0, iv, 19*time.Second, 0); got != iv {
		t.Errorf("short polling must always wait the interval, got %v", got)
	}
}

func TestPollBackoffGrowsAndIsCapped(t *testing.T) {
	for i := 0; i < 50; i++ {
		if d := pollBackoff(1, 30*time.Second); d < 500*time.Millisecond || d > time.Second {
			t.Fatalf("first backoff %v outside [0.5s, 1s]", d)
		}
		if d := pollBackoff(4, 30*time.Second); d < 4*time.Second || d > 8*time.Second {
			t.Fatalf("fourth backoff %v outside [4s, 8s]", d)
		}
		if d := pollBackoff(40, 30*time.Second); d < 15*time.Second || d > 30*time.Second {
			t.Fatalf("capped backoff %v outside [15s, 30s]", d)
		}
	}
}

// The agent long-polls: it asks for ?wait_ms=, the server holds the request, and a command queued
// during the hold is executed at once. Failed polls are retried with backoff, not in a tight loop.
func TestAgentLongPollsForCommands(t *testing.T) {
	var polls, failing atomic.Int32
	failing.Store(2)
	queued := make(chan struct{})
	var once sync.Once
	var gotWait atomic.Value
	executed := make(chan string, 4)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		switch r.URL.Path {
		case "/api/v1/agent/poll":
			polls.Add(1)
			if failing.Load() > 0 {
				failing.Add(-1)
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			gotWait.Store(r.URL.Query().Get("wait_ms"))
			give := false
			select {
			case <-queued:
				once.Do(func() { give = true })
			case <-time.After(400 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
			if give {
				_ = json.NewEncoder(w).Encode(map[string]any{"commands": []map[string]any{{"id": "c-1", "kind": "refresh_inventory", "payload": map[string]any{}}}})
				return
			}
			select {
			case <-time.After(400 * time.Millisecond):
				_ = json.NewEncoder(w).Encode(map[string]any{"commands": []any{}})
			case <-r.Context().Done():
			}
		case "/api/v1/agent/command-result":
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	raw, _ := json.Marshal(credentialFile{EndpointID: "ep-1", Credential: "lda_ep-1.secret"})
	if err := os.WriteFile(filepath.Join(dir, "credential.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{ServerURL: srv.URL, StateDir: dir, LogLevel: "error", AllowInsecureHTTP: true}
	deps := Deps{
		CollectHealth:    func(context.Context, time.Time) sysinfo.Health { return sysinfo.Health{Hostname: "pc"} },
		CollectInventory: func(context.Context) sysinfo.Inventory { return sysinfo.Inventory{} },
		ExecuteCommand: func(_ context.Context, cmd control.Command) control.Result {
			executed <- cmd.ID
			return control.Result{ID: cmd.ID, OK: true}
		},
	}
	tuning := Tuning{HeartbeatInterval: time.Hour, InventoryInterval: time.Hour, CommandPollInterval: 50 * time.Millisecond, MaxBackoff: time.Second, LongPollWait: 400 * time.Millisecond, MaxPollBackoff: 300 * time.Millisecond}
	ag, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", tuning)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ag.commandPollLoop(ctx)

	// Two failures, then held polls.
	deadline := time.Now().Add(5 * time.Second)
	for polls.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if polls.Load() < 4 {
		t.Fatalf("agent did not keep polling after failures: %d polls", polls.Load())
	}
	if w, _ := gotWait.Load().(string); w != "400" {
		t.Fatalf("agent sent wait_ms=%q, want 400", w)
	}
	start := time.Now()
	close(queued)
	select {
	case id := <-executed:
		if id != "c-1" {
			t.Fatalf("executed %s", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("queued command was not executed")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("command took %v to start; the held poll should answer at once", time.Since(start))
	}
	// Held polls (400 ms each) are not repeated in a tight loop.
	before := polls.Load()
	time.Sleep(900 * time.Millisecond)
	if n := polls.Load() - before; n > 12 {
		t.Fatalf("%d polls in 900 ms: the agent is spinning", n)
	}
}
