package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/nigafiy/agent/internal/control"
)

func TestQuickSupportProfile(t *testing.T) {
	ran := []string{}
	exec := func(_ context.Context, c control.Command) control.Result {
		ran = append(ran, c.Kind)
		return control.Result{ID: c.ID, OK: true}
	}
	d := Deps(nil, exec)
	if !d.NoTray || d.RebootRun != nil || d.InService || d.UserSessions != nil {
		t.Fatalf("profile %+v", d)
	}
	for _, k := range []string{"run_script", "power_action", "fs_op", "notify_user", "service_control"} {
		r := d.ExecuteCommand(context.Background(), control.Command{ID: k, Kind: k})
		if r.OK != (k == "fs_op" || k == "notify_user") {
			t.Errorf("%s ok=%v", k, r.OK)
		}
	}
	if len(ran) != 2 {
		t.Fatalf("ran %v", ran)
	}
	// The agent asks AllowCommand before its own handlers (scripts, shell, patches, restarts).
	if d.AllowCommand == nil {
		t.Fatal("no AllowCommand gate")
	}
	for _, k := range []string{"rd_session_open", "rd_session_close", "rd_session_update", "rd_capture", "rd_input", "fs_op", "notify_user"} {
		if !d.AllowCommand(k) {
			t.Errorf("%s refused", k)
		}
	}
	for _, k := range []string{"script_run", "script_cancel", "shell_open", "shell_input", "patch_scan", "patch_install", "fleet_restart", "fleet_safe_boot_clear", "power_action", "run_script", ""} {
		if d.AllowCommand(k) {
			t.Errorf("%s allowed", k)
		}
	}
	inv, _ := json.Marshal(d.CollectInventory(context.Background()))
	if string(inv) != `{"disks":[],"interfaces":[],"processes":[],"services":[],"software":[],"connections":[]}` {
		t.Fatalf("inventory %s", inv)
	}
}
