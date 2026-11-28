package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/scripts"
)

// A refused kind never reaches any handler (jobs, shell, patch, restart or ExecuteCommand) and the
// server still gets an error result for it.
func TestAllowCommandGatesEveryHandler(t *testing.T) {
	var mu sync.Mutex
	got := map[string]control.Result{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Results []control.Result `json:"command_results"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		for _, res := range body.Results {
			got[res.ID] = res
		}
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	executed := []string{}
	a := &Agent{
		baseURL:       srv.URL,
		httpClient:    srv.Client(),
		log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		scripts:       &scripts.Runner{},
		wakeHeartbeat: make(chan struct{}, 1),
		wakeInventory: make(chan struct{}, 1),
		wakeHardware:  make(chan struct{}, 1),
		deps: Deps{
			AllowCommand: func(kind string) bool { return kind == "notify_user" },
			ExecuteCommand: func(_ context.Context, c control.Command) control.Result {
				executed = append(executed, c.Kind)
				return control.Result{ID: c.ID, OK: true}
			},
		},
	}
	script := `{"result_id":"r","language":"sh","body":"echo pwned"}`
	for _, c := range []control.Command{
		{ID: "1", Kind: "script_run", Payload: []byte(script)},
		{ID: "2", Kind: "shell_open", Payload: []byte(`{}`)},
		{ID: "3", Kind: "patch_install", Payload: []byte(`{}`)},
		{ID: "4", Kind: "fleet_restart", Payload: []byte(`{}`)},
		{ID: "5", Kind: "run_script", Payload: []byte(`{}`)},
		{ID: "6", Kind: "notify_user", Payload: []byte(`{}`)},
	} {
		a.runCommand(context.Background(), c)
	}
	if strings.Join(executed, ",") != "notify_user" {
		t.Fatalf("executed %v", executed)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, id := range []string{"1", "2", "3", "4", "5"} {
		r, ok := got[id]
		if !ok || r.OK || !strings.Contains(r.Error, "does not run") || len(r.Data) != 0 {
			t.Errorf("command %s: %+v (delivered %v)", id, r, ok)
		}
	}
	if !got["6"].OK {
		t.Errorf("notify_user: %+v", got["6"])
	}
}
