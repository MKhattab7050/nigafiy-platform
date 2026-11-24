package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/reboot"
)

// Restart and reconnect through the agent's command path, with a fake runner: nothing here runs
// bcdedit, reg or shutdown.
func newReachAgent(t *testing.T, goos string, inService bool, fail string) (*Agent, *[]string) {
	calls := &[]string{}
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		line := name + " " + strings.Join(args, " ")
		*calls = append(*calls, line)
		if fail != "" && strings.HasPrefix(line, fail) {
			return []byte("failed"), errors.New("exit status 1")
		}
		return nil, nil
	}
	a := &Agent{log: slog.New(slog.NewTextHandler(io.Discard, nil)), deps: Deps{InService: inService, RebootRun: run, ExecuteCommand: func(context.Context, control.Command) control.Result {
		*calls = append(*calls, "power_action restart")
		return control.Result{OK: true}
	}}}
	a.reboot = &reboot.Manager{StateDir: t.TempDir(), ServiceName: "NigafiyEndpointAgent", GOOS: goos, InService: inService, Run: run, Restart: func(ctx context.Context, msg string) error {
		*calls = append(*calls, "restart: "+msg)
		return nil
	}}
	return a, calls
}

func restartCmd(mode string) control.Command {
	p, _ := json.Marshal(map[string]string{"restart_id": "r1", "mode": mode, "reason": "Remove driver", "operator": "it@corp.test", "session_id": "s1"})
	return control.Command{ID: "c1", Kind: "fleet_restart", Payload: p}
}

func TestFleetRestartSafeModeReportsTheFlagAndClearsOnRequest(t *testing.T) {
	a, calls := newReachAgent(t, "windows", true, "")
	res, handled := a.reachCommand(context.Background(), restartCmd("safe_mode"))
	if !handled || !res.OK || !strings.Contains(string(res.Data), `"safe_boot_set":true`) {
		t.Fatalf("res %+v", res)
	}
	if a.bootState()["safe_boot_flag"] != true || a.bootState()["service"] != true {
		t.Fatalf("boot state %v", a.bootState())
	}
	last := (*calls)[len(*calls)-1]
	if !strings.HasPrefix(last, "restart: Nigafiy: it@corp.test restarts this computer in Safe Mode with Networking") {
		t.Fatalf("calls %q", *calls)
	}
	res, _ = a.reachCommand(context.Background(), control.Command{ID: "c2", Kind: "fleet_safe_boot_clear"})
	if !res.OK || !strings.Contains(string(res.Data), `"safe_boot_flag":false`) || a.bootState()["safe_boot_flag"] != false {
		t.Fatalf("clear %+v", res)
	}
}

func TestFleetRestartRefusesHonestly(t *testing.T) {
	a, _ := newReachAgent(t, "windows", false, "")
	res, _ := a.reachCommand(context.Background(), restartCmd("safe_mode"))
	if res.OK || !strings.HasPrefix(res.Error, "safe_mode_needs_service") {
		t.Fatalf("res %+v", res)
	}
	b, _ := newReachAgent(t, "windows", true, "bcdedit /set")
	res, _ = b.reachCommand(context.Background(), restartCmd("safe_mode"))
	if res.OK || b.bootState()["safe_boot_flag"] != false {
		t.Fatalf("failed bcdedit must leave no flag: %+v %v", res, b.bootState())
	}
	// A normal restart touches no boot setting.
	c, calls := newReachAgent(t, "linux", false, "")
	res, _ = c.reachCommand(context.Background(), restartCmd("normal"))
	if !res.OK || len(*calls) != 1 || !strings.HasPrefix((*calls)[0], "restart: ") {
		t.Fatalf("res %+v calls %q", res, *calls)
	}
}
