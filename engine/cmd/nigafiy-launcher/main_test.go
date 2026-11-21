package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLauncherInfo(t *testing.T) {
	t.Setenv("NIGAFIY_LAUNCHER_QUIET", "1")
	old := programID
	defer func() { programID = old }()
	programID = "guard"
	var out, errb bytes.Buffer
	if code := run([]string{"--launcher-info"}, &out, &errb); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	var info map[string]string
	if err := json.Unmarshal(out.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info["program"] != "guard" || info["app_user_model_id"] != "Nigafiy.Guard" {
		t.Fatalf("info = %v", info)
	}
}

func TestUnknownProgramAndMissingRuntime(t *testing.T) {
	t.Setenv("NIGAFIY_LAUNCHER_QUIET", "1")
	old := programID
	defer func() { programID = old }()
	programID = "evil"
	var out, errb bytes.Buffer
	if code := run(nil, &out, &errb); code != 2 || !strings.Contains(errb.String(), "unknown program") {
		t.Fatalf("unknown program: exit %d, %q", code, errb.String())
	}
	// No runtime anywhere (env points nowhere, no registry, nothing next to the test binary): nothing is started.
	programID = "radar"
	oldStart, oldReg := startRuntime, readRegistry
	defer func() { startRuntime, readRegistry = oldStart, oldReg }()
	startRuntime = func(string, []string) error { t.Fatal("must not start a runtime"); return nil }
	readRegistry = func() (string, error) { return "", nil }
	t.Setenv("NIGAFIY_RUNTIME", t.TempDir()+"/missing/Nigafiy.exe")
	errb.Reset()
	if code := run(nil, &out, &errb); code != 1 || !strings.Contains(errb.String(), "was not found") {
		t.Fatalf("missing runtime: exit %d, %q", code, errb.String())
	}
}

func TestStartsTheRuntimeWithTheProgram(t *testing.T) {
	t.Setenv("NIGAFIY_LAUNCHER_QUIET", "1")
	old := programID
	oldStart, oldReg := startRuntime, readRegistry
	defer func() { programID, startRuntime, readRegistry = old, oldStart, oldReg }()
	programID = "mind"
	rt := filepath.Join(t.TempDir(), "Nigafiy.exe")
	if err := os.WriteFile(rt, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NIGAFIY_RUNTIME", rt)
	readRegistry = func() (string, error) { return "", nil }
	var gotRuntime string
	var gotArgs []string
	startRuntime = func(r string, a []string) error { gotRuntime, gotArgs = r, a; return nil }
	var out, errb bytes.Buffer
	if code := run([]string{"nigafiy://mind/knowledge/3", "--inspect"}, &out, &errb); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	if gotRuntime != rt || strings.Join(gotArgs, " ") != "--program=mind nigafiy://mind/knowledge/3" {
		t.Fatalf("started %q %q", gotRuntime, gotArgs)
	}
}
