package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/sysinfo"
)

// relayAgent builds an agent against a fake server; exec is the file manager behind it.
func relayAgent(t *testing.T, h http.HandlerFunc, exec func(control.Command) control.Result) *Agent {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	raw, _ := json.Marshal(credentialFile{EndpointID: "ep-1", Credential: "lda_ep-1.secret"})
	if err := os.WriteFile(filepath.Join(dir, "credential.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{ServerURL: srv.URL, StateDir: dir, LogLevel: "error", AllowInsecureHTTP: true}
	deps := Deps{
		CollectHealth:    func(context.Context, time.Time) sysinfo.Health { return sysinfo.Health{} },
		CollectInventory: func(context.Context) sysinfo.Inventory { return sysinfo.Inventory{} },
		ExecuteCommand:   func(_ context.Context, c control.Command) control.Result { return exec(c) },
	}
	ag, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "test", Tuning{HeartbeatInterval: time.Hour, InventoryInterval: time.Hour, CommandPollInterval: time.Second, MaxBackoff: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := ag.ensureEnrolled(context.Background()); err != nil {
		t.Fatal(err)
	}
	return ag
}

func TestFileRelayUploadFetchesTheBytes(t *testing.T) {
	piece := bytes.Repeat([]byte{0, 1, 2, 250}, 1000)
	var auth string
	var got map[string]any
	ag := relayAgent(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/agent/file-data/11111111-1111-1111-1111-111111111111" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		auth = r.Header.Get("Authorization")
		_, _ = w.Write(piece)
	}, func(c control.Command) control.Result {
		_ = json.Unmarshal(c.Payload, &got)
		return control.Result{ID: c.ID, OK: true}
	})
	payload := `{"op":"upload","path":"C:\\x.bin","offset":0,"data_ref":"11111111-1111-1111-1111-111111111111","data_len":4000}`
	res, handled := ag.fsRelayCommand(context.Background(), control.Command{ID: "c1", Kind: "fs_op", Payload: []byte(payload)})
	if !handled || !res.OK {
		t.Fatalf("handled=%v res=%+v", handled, res)
	}
	if auth != "Bearer lda_ep-1.secret" {
		t.Fatalf("authorization %q", auth)
	}
	if _, ok := got["data_ref"]; ok {
		t.Fatal("data_ref reached the file manager")
	}
	b, _ := base64.StdEncoding.DecodeString(got["data_base64"].(string))
	if !bytes.Equal(b, piece) || got["path"] != `C:\x.bin` {
		t.Fatalf("file manager got %v", got)
	}

	// A short piece, or a missing one, is refused before anything is written.
	res, _ = ag.fsRelayCommand(context.Background(), control.Command{ID: "c2", Kind: "fs_op", Payload: []byte(strings.Replace(payload, "4000", "4001", 1))})
	if res.OK || !strings.HasPrefix(res.Error, "relay piece missing") {
		t.Fatalf("short piece: %+v", res)
	}
	res, _ = ag.fsRelayCommand(context.Background(), control.Command{ID: "c3", Kind: "fs_op", Payload: []byte(strings.Replace(payload, "11111111-1111", "22222222-2222", 1))})
	if res.OK || !strings.HasPrefix(res.Error, "relay piece missing") {
		t.Fatalf("missing piece: %+v", res)
	}
}

func TestFileRelayDownloadSendsTheBytesApart(t *testing.T) {
	piece := bytes.Repeat([]byte("abc"), 5000)
	var mu sync.Mutex
	var posted []byte
	var cid string
	fail := false
	ag := relayAgent(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/agent/file-data" || r.Header.Get("Content-Type") != "application/octet-stream" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		cid = r.URL.Query().Get("command_id")
		posted, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}, func(c control.Command) control.Result {
		out, _ := json.Marshal(map[string]any{"offset": 0, "length": len(piece), "chunk_sha256": "ff", "data_base64": base64.StdEncoding.EncodeToString(piece)})
		return control.Result{ID: c.ID, OK: true, Data: out}
	})
	cmd := control.Command{ID: "c9", Kind: "fs_op", Payload: []byte(`{"op":"download","path":"/a","offset":0,"length":15000,"relay":true}`)}
	res, handled := ag.fsRelayCommand(context.Background(), cmd)
	if !handled || !res.OK {
		t.Fatalf("handled=%v res=%+v", handled, res)
	}
	var out map[string]any
	_ = json.Unmarshal(res.Data, &out)
	if out["relayed"] != true || out["data_base64"] != nil || out["chunk_sha256"] != "ff" {
		t.Fatalf("result %v", out)
	}
	if cid != "c9" || !bytes.Equal(posted, piece) {
		t.Fatalf("posted %d bytes for %q", len(posted), cid)
	}

	// The server refuses the bytes: they go in the result as before.
	mu.Lock()
	fail = true
	mu.Unlock()
	res, _ = ag.fsRelayCommand(context.Background(), cmd)
	out = nil
	_ = json.Unmarshal(res.Data, &out)
	if !res.OK || out["relayed"] != nil || out["data_base64"] == nil {
		t.Fatalf("fallback result %v", out)
	}
}

func TestFileRelayLeavesOtherCommandsAlone(t *testing.T) {
	ag := relayAgent(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }, func(c control.Command) control.Result {
		return control.Result{ID: c.ID, OK: true}
	})
	for _, c := range []control.Command{
		{ID: "1", Kind: "fs_op", Payload: []byte(`{"op":"upload","path":"/a","data_base64":"AA=="}`)},
		{ID: "2", Kind: "fs_op", Payload: []byte(`{"op":"download","path":"/a"}`)},
		{ID: "3", Kind: "shell_open", Payload: []byte(`{"data_ref":"x"}`)},
	} {
		if _, handled := ag.fsRelayCommand(context.Background(), c); handled {
			t.Fatalf("command %s was taken by the relay", c.ID)
		}
	}
}
