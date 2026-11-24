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
	inv, _ := json.Marshal(d.CollectInventory(context.Background()))
	if string(inv) != `{"disks":[],"interfaces":[],"processes":[],"services":[],"software":[],"connections":[]}` {
		t.Fatalf("inventory %s", inv)
	}
}
