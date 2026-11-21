package control

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
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
	if (!res.OK || len(res.Data) == 0) && !strings.Contains(res.Error, "interactive desktop session") {
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


func TestArgumentsCannotBecomeOptions(t *testing.T) {
	var called []string
	r := Runner{Exec: func(_ context.Context, name string, args ...string) (string, error) {
		called = append(called, name+" "+strings.Join(args, " "))
		return "ok", nil
	}}
	ctx := context.Background()
	cases := []Command{
		{ID: "a", Kind: "software_action", Payload: json.RawMessage(`{"action":"install","package_id":"--allow-unauthenticated"}`)},
		{ID: "b", Kind: "service_action", Payload: json.RawMessage(`{"service":"--force","action":"stop"}`)},
		{ID: "c", Kind: "diagnostic_command", Payload: json.RawMessage(`{"tool":"nslookup","target":"-type=any"}`)},
	}
	for _, c := range cases {
		if res := r.Execute(ctx, c); res.OK {
			t.Fatalf("%s: an argument starting with '-' must be refused", c.Kind)
		}
	}
	if len(called) != 0 {
		t.Fatalf("nothing may run for refused commands, ran %v", called)
	}
}

func TestKillProcessVerifiesNameWhenProvided(t *testing.T) {
	ctx := context.Background()

	// 1. Matching process name proceeds to termination.
	var calls []string
	r := Runner{Exec: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		switch name {
		case "tasklist":
			return `"Notepad.EXE","4321","Console","1","12,000 K"`, nil
		case "ps":
			return "/usr/bin/notepad\n", nil
		default:
			return "ok", nil
		}
	}}
	res := r.Execute(ctx, Command{ID: "kp-1", Kind: "kill_process", Payload: json.RawMessage(`{"pid":4321,"name":"notepad.exe"}`)})
	if !res.OK {
		t.Fatalf("expected matching process name to succeed, got %+v", res)
	}
	if len(calls) != 2 {
		t.Fatalf("expected verify + kill calls, got %v", calls)
	}

	// 2. Mismatched process name refuses before terminating.
	calls = nil
	rMismatch := Runner{Exec: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		switch name {
		case "tasklist":
			return `"svchost.exe","4321","Services","0","20,000 K"`, nil
		case "ps":
			return "systemd\n", nil
		default:
			t.Fatalf("unexpected kill call %s when process name mismatched", name)
			return "", nil
		}
	}}
	res = rMismatch.Execute(ctx, Command{ID: "kp-2", Kind: "kill_process", Payload: json.RawMessage(`{"pid":4321,"name":"notepad.exe"}`)})
	if res.OK {
		t.Fatalf("expected mismatched process name to fail, got %+v", res)
	}
	if len(calls) != 1 {
		t.Fatalf("expected only verification call on mismatch, got %v", calls)
	}

	// 3. Dead / missing PID refuses before terminating.
	calls = nil
	rMissing := Runner{Exec: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if name == "tasklist" {
			return "INFO: No tasks are running which match the specified criteria.", nil
		}
		if name == "ps" {
			return "", errors.New("exit status 1")
		}
		t.Fatalf("unexpected kill call %s for missing PID", name)
		return "", nil
	}}
	res = rMissing.Execute(ctx, Command{ID: "kp-3", Kind: "kill_process", Payload: json.RawMessage(`{"pid":4321,"name":"notepad.exe"}`)})
	if res.OK {
		t.Fatalf("expected missing PID to fail, got %+v", res)
	}
	if runtime.GOOS == "windows" && !strings.Contains(res.Error, "not running") {
		t.Fatalf("expected not running error, got %+v", res)
	}

	// Helper unit coverage across platforms.
	if name, ok := extractTasklistProcessName("\"foo,bar.exe\",\"4321\",\"Console\",\"1\",\"10 K\"\r\n", "4321"); !ok || name != "foo,bar.exe" {
		t.Fatalf("extractTasklistProcessName failed: %q %v", name, ok)
	}
	if !processNameMatches("/usr/bin/python3.11", "python3") ||
		!processNameMatches("Notepad.EXE", "notepad") ||
		!processNameMatches("chromium-browse", "chromium-browser") ||
		processNameMatches("sh", "powershell.exe") ||
		processNameMatches("svchost.exe", "notepad.exe") {
		t.Fatal("processNameMatches logic mismatch")
	}
}
