package control

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestControlValidationAndExecution(t *testing.T) {
	var called []string
	r := Runner{
		Exec: func(_ context.Context, name string, args ...string) (string, error) {
			called = append(called, name+" "+strings.Join(args, " "))
			return "ok", nil
		},
	}
	ctx := context.Background()

	// Refuses PID <= 4
	res := r.Execute(ctx, Command{ID: "1", Kind: "kill_process", Payload: json.RawMessage(`{"pid":1}`)})
	if res.OK {
		t.Fatalf("expected PID 1 to be refused")
	}

	// Valid PID
	res = r.Execute(ctx, Command{ID: "2", Kind: "kill_process", Payload: json.RawMessage(`{"pid":4321}`)})
	if !res.OK {
		t.Fatalf("expected PID 4321 to succeed, got %+v", res)
	}

	// Refuses shell metacharacters in service name
	res = r.Execute(ctx, Command{ID: "3", Kind: "service_action", Payload: json.RawMessage(`{"service":"Spooler;whoami","action":"restart"}`)})
	if res.OK {
		t.Fatalf("expected invalid service name to be refused")
	}

	// Valid service restart
	res = r.Execute(ctx, Command{ID: "4", Kind: "service_action", Payload: json.RawMessage(`{"service":"Spooler","action":"restart"}`)})
	if !res.OK {
		t.Fatalf("expected valid service restart to succeed, got %+v", res)
	}

	// Refuses unknown command kind
	res = r.Execute(ctx, Command{ID: "5", Kind: "exec_shell", Payload: json.RawMessage(`{"cmd":"whoami"}`)})
	if res.OK {
		t.Fatalf("expected unknown command kind to be refused")
	}

	// File manager roots via fs_op
	res = r.Execute(ctx, Command{ID: "6", Kind: "fs_op", Payload: json.RawMessage(`{"op":"roots"}`)})
	if !res.OK || len(res.Data) == 0 {
		t.Fatalf("expected fs_op roots to succeed with data, got %+v", res)
	}

	// Remote desktop capture via rd_capture
	res = r.Execute(ctx, Command{ID: "7", Kind: "rd_capture", Payload: json.RawMessage(`{"display_index":0,"quality":60,"scale":0.5}`)})
	if !res.OK || len(res.Data) == 0 {
		t.Fatalf("expected rd_capture to succeed with JPEG frame data, got %+v", res)
	}

	// Software action validation (refuses injection, accepts valid package ID)
	res = r.Execute(ctx, Command{ID: "8", Kind: "software_action", Payload: json.RawMessage(`{"action":"install","package_id":"7zip.7zip; calc"}`)})
	if res.OK {
		t.Fatalf("expected invalid package_id to be refused")
	}
	res = r.Execute(ctx, Command{ID: "9", Kind: "software_action", Payload: json.RawMessage(`{"action":"install","package_id":"7zip.7zip"}`)})
	if !res.OK {
		t.Fatalf("expected valid software_action to succeed, got %+v", res)
	}

	// Diagnostic command allow-list (refuses arbitrary command, accepts ipconfig)
	res = r.Execute(ctx, Command{ID: "10", Kind: "diagnostic_command", Payload: json.RawMessage(`{"tool":"powershell -enc"}`)})
	if res.OK {
		t.Fatalf("expected unapproved diagnostic tool to be refused")
	}
	res = r.Execute(ctx, Command{ID: "11", Kind: "diagnostic_command", Payload: json.RawMessage(`{"tool":"ipconfig"}`)})
	if !res.OK {
		t.Fatalf("expected ipconfig diagnostic_command to succeed, got %+v", res)
	}

	// Fetch logs
	res = r.Execute(ctx, Command{ID: "12", Kind: "fetch_logs", Payload: json.RawMessage(`{"source":"system","lines":20}`)})
	if !res.OK {
		t.Fatalf("expected fetch_logs to succeed, got %+v", res)
	}
}

