package agent

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/scripts"
)

func TestScriptRunCommandReturnsTheResultAsData(t *testing.T) {
	a := &Agent{scripts: &scripts.Runner{}}
	payload := map[string]any{"result_id": "res-1", "language": "sh", "body": "printf '%s' \"$NIGAFIY_PARAM_NAME\"\nexit 3\n", "params": []map[string]string{{"name": "Name", "type": "string", "value": "a'b;$(id)"}}}
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath("powershell.exe"); err != nil {
			t.Skip("powershell.exe not available")
		}
		payload["language"] = "powershell"
		payload["body"] = "param([string]$Name)\r\n[Console]::Out.Write($Name)\r\nexit 3\r\n"
	}
	raw, _ := json.Marshal(payload)
	res, handled := a.jobsCommand(context.Background(), control.Command{ID: "c1", Kind: "script_run", Payload: raw})
	if !handled || !res.OK {
		t.Fatalf("%v %+v", handled, res)
	}
	var data scripts.Result
	if err := json.Unmarshal(res.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.ExitCode != 3 || strings.TrimSpace(data.Stdout) != "a'b;$(id)" {
		t.Fatalf("%+v", data)
	}

	res, _ = a.jobsCommand(context.Background(), control.Command{ID: "c2", Kind: "script_run", Payload: []byte(`{"result_id":"r","language":"cmd","body":"x"}`)})
	if res.OK || res.Error == "" || len(res.Data) == 0 {
		t.Fatalf("a refused script reports an error with data: %+v", res)
	}
	res, _ = a.jobsCommand(context.Background(), control.Command{ID: "c3", Kind: "script_cancel", Payload: []byte(`{"result_id":"nope"}`)})
	if !res.OK || !strings.Contains(res.Output, "not running") {
		t.Fatalf("%+v", res)
	}
	if _, handled := a.jobsCommand(context.Background(), control.Command{Kind: "ping"}); handled {
		t.Fatal("other kinds are not jobs commands")
	}
	if !unthrottled("script_cancel") || !unthrottled("shell_open") || unthrottled("script_run") {
		t.Fatal("unthrottled kinds")
	}
}

func TestScriptResultFitsTheGatewayLimit(t *testing.T) {
	res := scripts.Result{Stdout: strings.Repeat("\x01", 2<<20), Stderr: strings.Repeat("\x02", 2<<20)}
	raw := scriptResultJSON(&res)
	if len(raw) > maxResultJSON || !res.Capped || len(res.Stdout) == 0 {
		t.Fatalf("%d bytes, capped %v", len(raw), res.Capped)
	}
}
