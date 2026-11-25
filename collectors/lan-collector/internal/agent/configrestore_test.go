package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/configbackup"
)

func restoreItems(t *testing.T, a *Agent) []map[string]any {
	t.Helper()
	var out []map[string]any
	for {
		name, data, ok, err := a.spool.Oldest()
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			return out
		}
		var batch struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(data, &batch); err != nil {
			t.Fatal(err)
		}
		out = append(out, batch.Items...)
		_ = a.spool.Remove(name)
	}
}

func restoreCommand(t *testing.T, id string, expires time.Time) cloud.Command {
	t.Helper()
	cfg, _ := gzipBase64("system {\n    host-name srx-old;\n    root-authentication {\n        encrypted-password \"$6$SECRET\";\n    }\n}\n")
	payload, _ := json.Marshal(map[string]any{
		"restore_id": id, "verify_run_id": "8b0f3c1e-1111-4222-8333-944455556666", "target_id": "8b0f3c1e-aaaa-4bbb-8ccc-9ddddeeeeeee",
		"address": "192.168.50.20", "port": 22, "username": "netops", "password": "ssh-pass-SECRET",
		"host_key_sha256": "SHA256:" + strings.Repeat("A", 43), "host_key_type": "ssh-ed25519", "driver": "juniper_junos",
		"config_gzip_b64": cfg, "confirm_minutes": 3, "expires_at": expires.UTC(),
	})
	return cloud.Command{ID: "cmd-" + id, Kind: cmdConfigRestore, Payload: payload}
}

func TestConfigRestoreAtMostOnceReportsVerificationAndNeverLeaks(t *testing.T) {
	a := newTestAgent(t, "http://127.0.0.1:1", t.TempDir(), "tok", &recordingProber{})
	var calls atomic.Int32
	var got configbackup.RestoreSpec
	var gotTarget configbackup.Target
	a.deps.ConfigRestore = func(_ context.Context, tg configbackup.Target, spec configbackup.RestoreSpec, _ configbackup.Options) (*configbackup.RestoreResult, error) {
		calls.Add(1)
		got, gotTarget = spec, tg
		return &configbackup.RestoreResult{
			Method: configbackup.RestoreMethodJunos, Loaded: true, Committed: true, Confirmed: true,
			Steps:  []string{"configure exclusive: configuration locked", "commit: confirmed"},
			Config: "system {\n    host-name srx-old;\n    root-authentication {\n        encrypted-password \"$6$SECRET\";\n    }\n}\n",
		}, nil
	}
	id := "8b0f3c1e-0000-4111-8222-933344445555"
	cmd := restoreCommand(t, id, time.Now().Add(10*time.Minute))
	a.configRestore(context.Background(), cmd)
	a.configRestore(context.Background(), cmd) // redelivered: never applied twice
	if calls.Load() != 1 {
		t.Fatalf("the restore must run exactly once, ran %d times", calls.Load())
	}
	if !strings.Contains(got.Config, "host-name srx-old;") || got.ConfirmMinutes != 3 || gotTarget.Driver != "juniper_junos" || gotTarget.HostKeySHA256 == "" {
		t.Fatalf("unexpected restore input: %+v %+v", got, gotTarget)
	}
	items := restoreItems(t, a)
	if len(items) != 2 || items[0]["type"] != "config_backup_result" || items[1]["type"] != "config_restore_result" {
		t.Fatalf("want the verification backup then the restore result, got %v", items)
	}
	if items[0]["run_id"] != "8b0f3c1e-1111-4222-8333-944455556666" || items[0]["ok"] != true {
		t.Fatalf("verification backup: %v", items[0])
	}
	r := items[1]
	if r["restore_id"] != id || r["ok"] != true || r["confirmed"] != true || r["committed"] != true || r["rolled_back"] != false || r["read_back"] != true {
		t.Fatalf("restore result: %v", r)
	}
	raw, _ := json.Marshal(r)
	if strings.Contains(string(raw), "ssh-pass-SECRET") || strings.Contains(string(raw), "SECRET") {
		t.Fatalf("the restore result must carry neither credentials nor configuration text: %s", raw)
	}
}

func TestConfigRestoreExpiredOrFailed(t *testing.T) {
	a := newTestAgent(t, "http://127.0.0.1:1", t.TempDir(), "tok", &recordingProber{})
	var calls atomic.Int32
	a.deps.ConfigRestore = func(context.Context, configbackup.Target, configbackup.RestoreSpec, configbackup.Options) (*configbackup.RestoreResult, error) {
		calls.Add(1)
		return &configbackup.RestoreResult{Method: configbackup.RestoreMethodJunos, Loaded: true, Committed: true, RolledBack: true, Steps: []string{"rollback 1 + commit: previous configuration active again"}},
			&configbackup.Error{Kind: configbackup.ErrCommandFailed, Message: "after the commit the device could not be read over a new SSH session; the previous configuration was put back"}
	}
	a.configRestore(context.Background(), restoreCommand(t, "8b0f3c1e-0000-4111-8222-000000000001", time.Now().Add(-time.Second)))
	if calls.Load() != 0 || len(restoreItems(t, a)) != 0 {
		t.Fatal("an expired restore must not start")
	}
	a.configRestore(context.Background(), restoreCommand(t, "8b0f3c1e-0000-4111-8222-000000000002", time.Now().Add(time.Minute)))
	items := restoreItems(t, a)
	if calls.Load() != 1 || len(items) != 1 || items[0]["type"] != "config_restore_result" {
		t.Fatalf("a failed restore without a read-back reports only the restore result: %v", items)
	}
	r := items[0]
	e, _ := r["error"].(map[string]any)
	if r["ok"] != false || r["rolled_back"] != true || e["kind"] != configbackup.ErrCommandFailed || !strings.Contains(e["message"].(string), "put back") {
		t.Fatalf("restore result: %v", r)
	}
	if r["read_back"] != false {
		t.Fatal("read_back must be false")
	}
}

func TestConfigRestorePassesIdentityAndVyOSReadBackCommand(t *testing.T) {
	a := newTestAgent(t, "http://127.0.0.1:1", t.TempDir(), "tok", &recordingProber{})
	var got configbackup.RestoreSpec
	a.deps.ConfigRestore = func(_ context.Context, _ configbackup.Target, spec configbackup.RestoreSpec, _ configbackup.Options) (*configbackup.RestoreResult, error) {
		got = spec
		return &configbackup.RestoreResult{
			Method: configbackup.RestoreMethodVyOS, Loaded: true, Committed: true, Confirmed: true,
			Identity: &configbackup.DeviceIdentity{Model: "EdgeRouter X 5-Port", Serial: "7483C2123456"},
			Config:   "set system host-name 'edge-old'\n",
		}, nil
	}
	cfg, _ := gzipBase64("set system host-name 'edge-old'\n")
	payload, _ := json.Marshal(map[string]any{
		"restore_id": "8b0f3c1e-0000-4111-8222-000000000003", "verify_run_id": "8b0f3c1e-1111-4222-8333-944455556666", "target_id": "8b0f3c1e-aaaa-4bbb-8ccc-9ddddeeeeeee",
		"address": "192.168.50.21", "port": 22, "username": "ubnt", "password": "x", "host_key_sha256": "SHA256:" + strings.Repeat("B", 43), "host_key_type": "ssh-ed25519",
		"driver": "vyos_edgeos", "config_gzip_b64": cfg, "confirm_minutes": 2, "expires_at": time.Now().Add(time.Minute).UTC(),
		"expected_identity": map[string]any{"model": "EdgeRouter X 5-Port", "serial": "7483C2000000"}, "allow_other_device": true,
	})
	a.configRestore(context.Background(), cloud.Command{ID: "cmd-v", Kind: cmdConfigRestore, Payload: payload})
	if got.ExpectedIdentity == nil || got.ExpectedIdentity.Serial != "7483C2000000" || !got.AllowOtherDevice {
		t.Fatalf("expected identity / force not passed: %+v", got)
	}
	items := restoreItems(t, a)
	if len(items) != 2 {
		t.Fatalf("items: %v", items)
	}
	if cmds, _ := items[0]["commands"].([]any); len(cmds) != 1 || cmds[0] != "show configuration commands | cat" {
		t.Fatalf("verification commands: %v", items[0]["commands"])
	}
	for _, it := range items {
		id, _ := it["device_identity"].(map[string]any)
		if id["serial"] != "7483C2123456" {
			t.Fatalf("device identity not reported: %v", it)
		}
	}
}
