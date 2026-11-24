package scripts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

const hostile = `C:\Temp'; Remove-Item C:\ -Recurse; $(whoami) ` + "`" + `n "quoted" & echo pwned | x`

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestValidateRefusesBadNamesTypesAndTamperedBodies(t *testing.T) {
	ok := Request{Language: "powershell", Body: "Write-Output 1", Params: []Param{{Name: "Path", Type: "string", Value: hostile}, {Name: "Days", Type: "int", Value: "3"}, {Name: "Force", Type: "bool", Value: "true"}}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]Request{
		"language":   {Language: "cmd", Body: "x"},
		"empty":      {Language: "sh", Body: "  "},
		"name":       {Language: "sh", Body: "x", Params: []Param{{Name: "a;b", Type: "string"}}},
		"name-quote": {Language: "powershell", Body: "x", Params: []Param{{Name: "a']=1;#", Type: "string"}}},
		"twice":      {Language: "sh", Body: "x", Params: []Param{{Name: "A", Type: "string"}, {Name: "a", Type: "string"}}},
		"int":        {Language: "sh", Body: "x", Params: []Param{{Name: "N", Type: "int", Value: "1; rm"}}},
		"bool":       {Language: "sh", Body: "x", Params: []Param{{Name: "B", Type: "bool", Value: "yes"}}},
		"type":       {Language: "sh", Body: "x", Params: []Param{{Name: "B", Type: "script", Value: "x"}}},
		"nul":        {Language: "sh", Body: "x", Params: []Param{{Name: "S", Type: "string", Value: "a\x00b"}}},
		"sha":        {Language: "sh", Body: "echo 1", BodySHA256: sum("echo 2")},
	}
	for name, r := range cases {
		if r.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The launcher holds names and the path only: no value ever reaches PowerShell's parser.
func TestLauncherNeverContainsValues(t *testing.T) {
	r := Request{Language: "powershell", Body: "x", Params: []Param{{Name: "Path", Type: "string", Value: hostile}, {Name: "Days", Type: "int", Value: "30"}, {Name: "WhatIf", Type: "bool", Value: "false"}}}
	l := r.Launcher(`C:\Users\o'brien\AppData\Local\Temp\nigafiy-job-1\script.ps1`)
	for _, bad := range []string{"Remove-Item", "whoami", "pwned", "30", "false"} {
		if strings.Contains(l, bad) {
			t.Fatalf("launcher contains %q:\n%s", bad, l)
		}
	}
	for _, want := range []string{"$p['Path'] = [string]$env:NIGAFIY_PARAM_PATH", "$p['Days'] = [int]$env:NIGAFIY_PARAM_DAYS", "$p['WhatIf'] = ($env:NIGAFIY_PARAM_WHATIF -eq 'true')", `& 'C:\Users\o''brien\AppData`} {
		if !strings.Contains(l, want) {
			t.Fatalf("launcher lacks %q:\n%s", want, l)
		}
	}
	env := r.Env()
	if env[0] != "NIGAFIY_PARAM_PATH="+hostile {
		t.Fatalf("env %q", env[0])
	}
}

func TestCapBufferKeepsTheStartAndCountsTheRest(t *testing.T) {
	c := &capBuffer{max: 5}
	_, _ = c.Write([]byte("abc"))
	_, _ = c.Write([]byte("defgh"))
	s, n, capped := c.result()
	if s != "abcde" || n != 8 || !capped {
		t.Fatalf("%q %d %v", s, n, capped)
	}
}

// Real interpreters: PowerShell on Windows, /bin/sh elsewhere. The hostile value comes back
// unchanged, typed values bind to the param() block, and exit codes pass through.
func TestRunPassesHostileValuesAsData(t *testing.T) {
	ctx := context.Background()
	var r Runner
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath("powershell.exe"); err != nil {
			t.Skip("powershell.exe not available")
		}
		body := "param([string]$Path, [int]$Days, [switch]$WhatIf)\r\n" +
			"Write-Output (\"PATH=\" + $Path)\r\n" +
			"Write-Output (\"DAYS=\" + ($Days + 1))\r\n" +
			"Write-Output (\"WHATIF=\" + $WhatIf.IsPresent)\r\n" +
			"Write-Output (\"ARABIC=\" + 'مرحبا')\r\n" +
			"[Console]::Error.WriteLine('to stderr')\r\n" +
			"exit 7\r\n"
		res, err := r.Run(ctx, Request{ResultID: "r1", Language: "powershell", Body: body, BodySHA256: sum(body), TimeoutS: 60, Params: []Param{
			{Name: "Path", Type: "string", Value: hostile},
			{Name: "Days", Type: "int", Value: "41"},
			{Name: "WhatIf", Type: "bool", Value: "true"},
		}})
		if err != nil {
			t.Fatal(err, res)
		}
		for _, want := range []string{"PATH=" + hostile, "DAYS=42", "WHATIF=True", "ARABIC=مرحبا"} {
			if !strings.Contains(res.Stdout, want) {
				t.Fatalf("stdout lacks %q:\n%s\nstderr: %s", want, res.Stdout, res.Stderr)
			}
		}
		if !strings.Contains(res.Stderr, "to stderr") || res.ExitCode != 7 {
			t.Fatalf("exit %d stderr %q", res.ExitCode, res.Stderr)
		}
		// A false switch binds as not present; a script that throws exits 1.
		res, _ = r.Run(ctx, Request{Language: "powershell", Body: "param([switch]$WhatIf)\r\nWrite-Output $WhatIf.IsPresent\r\nthrow 'broken'\r\n", Params: []Param{{Name: "WhatIf", Type: "bool", Value: "false"}}})
		if !strings.Contains(res.Stdout, "False") || res.ExitCode != 1 {
			t.Fatalf("false switch / throw: exit %d %q %q", res.ExitCode, res.Stdout, res.Stderr)
		}
		return
	}
	body := "printf 'PATH=%s\\n' \"$NIGAFIY_PARAM_PATH\"\necho to-stderr >&2\nexit 7\n"
	res, err := r.Run(ctx, Request{Language: "sh", Body: body, Params: []Param{{Name: "Path", Type: "string", Value: hostile}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Stdout, "PATH="+hostile) || res.ExitCode != 7 || !strings.Contains(res.Stderr, "to-stderr") {
		t.Fatalf("%+v", res)
	}
}

func TestRunStopsAtTheTimeoutAndOnCancel(t *testing.T) {
	var r Runner
	lang, body := "sh", "sleep 30\n"
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath("powershell.exe"); err != nil {
			t.Skip("powershell.exe not available")
		}
		lang, body = "powershell", "Start-Sleep -Seconds 30\r\n"
	}
	started := time.Now()
	res, err := r.Run(context.Background(), Request{Language: lang, Body: body, TimeoutS: 2})
	if err == nil || !res.TimedOut || time.Since(started) > 20*time.Second {
		t.Fatalf("timeout: %v %+v after %s", err, res, time.Since(started))
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		r.Cancel("job-x")
	}()
	res, err = r.Run(context.Background(), Request{ResultID: "job-x", Language: lang, Body: body, TimeoutS: 60})
	if err == nil || !res.Cancelled || res.TimedOut {
		t.Fatalf("cancel: %v %+v", err, res)
	}
	if r.Cancel("job-x") {
		t.Fatal("a finished script is not cancellable")
	}
}
