package main

import (
	"bytes"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/nigafiy/engine/internal/engine"
)

func TestVersionAndUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := realMain([]string{"version"}, &out, &errOut); code != exitOK || strings.TrimSpace(out.String()) != version {
		t.Fatalf("version: code %d, out %q", code, out.String())
	}
	out.Reset()
	if code := realMain(nil, &out, &errOut); code != exitUsage || !strings.Contains(errOut.String(), "--no-sensor") {
		t.Fatalf("no args: code %d, stderr %q", code, errOut.String())
	}
	errOut.Reset()
	if code := realMain([]string{"frobnicate"}, &out, &errOut); code != exitUsage {
		t.Fatalf("unknown command: code %d", code)
	}
	if code := realMain([]string{"run", "--bogus"}, &out, &errOut); code != exitUsage {
		t.Fatalf("bad run flag: code %d", code)
	}
	if code := realMain([]string{"run", "--control-addr=0.0.0.0:47140"}, &out, &errOut); code != exitError {
		t.Fatalf("non-loopback control address: code %d", code)
	}
	if code := realMain([]string{"uninstall", "extra"}, &out, &errOut); code != exitUsage {
		t.Fatalf("uninstall with an argument: code %d", code)
	}
}

func TestStatusCommandWhenNotRunning(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	var out, errOut bytes.Buffer
	if code := realMain([]string{"status", "--control-addr", addr}, &out, &errOut); code != exitError || !strings.Contains(errOut.String(), "not running") {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
}

func TestStatusCommandPrintsStatus(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"version":"1","mode":"foreground","children":[],"stack":null}`))
	})}
	go srv.Serve(l)
	defer srv.Close()
	var out, errOut bytes.Buffer
	if code := realMain([]string{"status", "--control-addr=" + l.Addr().String()}, &out, &errOut); code != exitOK || !strings.Contains(out.String(), `"mode": "foreground"`) {
		t.Fatalf("code %d, out %q, err %q", code, out.String(), errOut.String())
	}
}

func TestServiceArgs(t *testing.T) {
	cfg := engine.Config{
		DataDir:      `C:\Data Folder`,
		Node:         `C:\Program Files\nodejs\node.exe`,
		StackScript:  `D:\repo\scripts\local.mjs`,
		SensorExe:    `D:\repo\collectors\lan-collector\bin\lan-collector.exe`,
		SensorConfig: `C:\Data Folder\collector\collector.yaml`,
		ControlAddr:  engine.DefaultControlAddr,
	}
	got := serviceArgs(cfg, "S-1-5-21-1-2-3-1001")
	want := []string{
		"run",
		`--data-dir=C:\Data Folder`,
		`--node=C:\Program Files\nodejs\node.exe`,
		`--stack-script=D:\repo\scripts\local.mjs`,
		`--sensor-exe=D:\repo\collectors\lan-collector\bin\lan-collector.exe`,
		`--sensor-config=C:\Data Folder\collector\collector.yaml`,
		"--control-addr=127.0.0.1:47140",
		"--owner-sid=S-1-5-21-1-2-3-1001",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	// The recorded command line parses back to the same configuration.
	back, err := engine.ParseRunFlags(got[1:], &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if back.DataDir != cfg.DataDir || back.Node != cfg.Node || back.SensorConfig != cfg.SensorConfig || back.OwnerSID != "S-1-5-21-1-2-3-1001" {
		t.Fatalf("round trip %+v", back)
	}
	cfg.NoSensor = true
	if args := serviceArgs(cfg, ""); !strings.Contains(strings.Join(args, " "), "--no-sensor") {
		t.Fatalf("--no-sensor dropped: %q", args)
	}
}
