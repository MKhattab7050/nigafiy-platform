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
}

