package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/engine/internal/control"
)

// The test binary stands in for node + local.mjs and for the Sensor (ENGINE_TEST_HELPER set).
// The real stack is never started by these tests.
const helperEnv = "ENGINE_TEST_HELPER"

func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnv); mode != "" {
		os.Exit(helperMain(mode))
	}
	os.Exit(m.Run())
}

func helperMain(mode string) int {
	statusFile := ""
	for _, a := range os.Args[1:] {
		if v, ok := strings.CutPrefix(a, "--engine-status-file="); ok {
			statusFile = v
		}
	}
	write := func(v map[string]any) {
		v["pid"] = os.Getpid()
		b, _ := json.Marshal(v)
		tmp := statusFile + ".tmp"
		os.WriteFile(tmp, b, 0o600)
		os.Rename(tmp, statusFile)
	}
	switch mode {
	case "stack":
		fmt.Println("helper started with", strings.Join(os.Args[1:], " "))
		if statusFile != "" {
			write(map[string]any{"state": "ready", "webUrl": "http://localhost:13100", "apiUrl": "http://localhost:14100"})
		}
		io.Copy(io.Discard, os.Stdin)
		fmt.Println("helper: stdin closed, stopping cleanly")
		return 0
	case "stack-error":
		write(map[string]any{"state": "error", "message": "Port 4100 is in use by another program."})
		return 1
	}
	return 2
}

type running struct {
	addr  string
	token string
	cfg   Config
	done  chan struct{} // closed when Run has returned; err is its result
	err   error
}

func startEngine(t *testing.T, mode string, edit func(*Config)) *running {
	t.Helper()
	t.Setenv(helperEnv, mode)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "local.mjs")
	os.WriteFile(script, []byte("// stand-in\n"), 0o600)
	cfg := Config{
		Version:     "test",
		Mode:        "foreground",
		DataDir:     filepath.Join(dir, "data"),
		Node:        exe,
		StackScript: script,
		SensorExe:   exe,
		ControlAddr: "127.0.0.1:0",
	}
	if edit != nil {
		edit(&cfg)
	}
	cfg, err = Resolve(cfg, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	addrCh := make(chan string, 1)
	cfg.OnListen = func(a string) { addrCh <- a }
	r := &running{cfg: cfg, done: make(chan struct{})}
	go func() {
		r.err = Run(context.Background(), cfg)
		close(r.done)
	}()
	select {
	case r.addr = <-addrCh:
	case <-r.done:
		t.Fatalf("engine exited early: %v", r.err)
	case <-time.After(10 * time.Second):
		t.Fatal("engine did not start listening")
	}
	r.token, err = control.ReadToken(TokenPath(cfg.DataDir))
	if err != nil {
		t.Fatalf("control token: %v", err)
	}
	t.Cleanup(func() {
		select {
		case <-r.done:
		default:
			r.post(t, "/v1/shutdown")
			<-r.done
		}
	})
	return r
}

func (r *running) status(t *testing.T) control.StatusDoc {
	t.Helper()
	doc, ok := control.Probe(r.addr, 2*time.Second)
	if !ok {
		t.Fatal("status not available")
	}
	return *doc
}

func (r *running) post(t *testing.T, path string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", "http://"+r.addr+path, nil)
	req.Header.Set("Authorization", "Bearer "+r.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func child(doc control.StatusDoc, name string) control.ChildDoc {
	for _, c := range doc.Children {
		if c.Name == name {
			return c
		}
	}
	return control.ChildDoc{}
}

func (r *running) waitStatus(t *testing.T, what string, ok func(control.StatusDoc) bool) control.StatusDoc {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		doc := r.status(t)
		if ok(doc) {
			return doc
		}
		if time.Now().After(deadline) {
			b, _ := json.Marshal(doc)
			t.Fatalf("timed out waiting for %s: %s", what, b)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func TestStackReadySensorNotEnrolledAndShutdown(t *testing.T) {
	r := startEngine(t, "stack", nil)
	doc := r.waitStatus(t, "stack ready", func(d control.StatusDoc) bool { return d.Stack != nil })
	if doc.Stack.WebURL != "http://localhost:13100" || doc.Stack.APIURL != "http://localhost:14100" {
		t.Fatalf("stack %+v", doc.Stack)
	}
	if doc.Mode != "foreground" || doc.Version != "test" || doc.DataDir != r.cfg.DataDir {
		t.Fatalf("doc %+v", doc)
	}
	st := child(doc, "stack")
	if st.State != "running" || st.Pid == nil || st.StartedAt == nil {
		t.Fatalf("stack child %+v", st)
	}
	sensor := child(doc, "sensor")
	if sensor.State != "stopped" || str(sensor.LastError) != "not enrolled" || sensor.Pid != nil {
		t.Fatalf("sensor child %+v", sensor)
	}

	code, _ := r.post(t, "/v1/shutdown")
	if code != http.StatusAccepted {
		t.Fatalf("shutdown: %d", code)
	}
	select {
	case <-r.done:
		if r.err != nil {
			t.Fatalf("Run returned %v", r.err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("engine did not shut down")
	}
	if _, err := os.Stat(TokenPath(r.cfg.DataDir)); !os.IsNotExist(err) {
		t.Fatalf("control token left behind (%v)", err)
	}
	stackLog, _ := os.ReadFile(logPath(r.cfg.DataDir, "stack"))
	if !strings.Contains(string(stackLog), "--no-open --no-collector --engine-status-file=") {
		t.Fatalf("stack not started with the engine arguments: %q", stackLog)
	}
	if !strings.Contains(string(stackLog), "stdin closed, stopping cleanly") {
		t.Fatalf("stack was not stopped gracefully: %q", stackLog)
	}
	engineLog, _ := os.ReadFile(logPath(r.cfg.DataDir, "engine"))
	if strings.Contains(string(engineLog), r.token) {
		t.Fatal("engine log contains the control token")
	}
	if !strings.Contains(string(engineLog), "Nigafiy Engine stopped") {
		t.Fatalf("engine log: %q", engineLog)
	}
}

func TestSensorStartsOnceEnrolled(t *testing.T) {
	r := startEngine(t, "stack", nil)
	r.waitStatus(t, "sensor not enrolled", func(d control.StatusDoc) bool { return str(child(d, "sensor").LastError) == "not enrolled" })
	code, body := r.post(t, "/v1/children/sensor/start")
	if code != 200 || !strings.Contains(body, `"not enrolled"`) {
		t.Fatalf("start before enrollment: %d %s", code, body)
	}
	os.MkdirAll(filepath.Dir(r.cfg.SensorConfig), 0o700)
	os.WriteFile(r.cfg.SensorConfig, []byte("server_url: http://127.0.0.1:1\n"), 0o600)
	code, body = r.post(t, "/v1/children/sensor/start")
	if code != 200 {
		t.Fatalf("start: %d %s", code, body)
	}
	r.waitStatus(t, "sensor running", func(d control.StatusDoc) bool { return child(d, "sensor").State == "running" })
	code, body = r.post(t, "/v1/children/sensor/stop")
	if code != 200 || !strings.Contains(body, `"state":"stopped"`) {
		t.Fatalf("stop: %d %s", code, body)
	}
}

func TestNoSensor(t *testing.T) {
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true })
	doc := r.status(t)
	sensor := child(doc, "sensor")
	if sensor.State != "stopped" || str(sensor.LastError) != SensorDisabledError {
		t.Fatalf("sensor %+v", sensor)
	}
	code, body := r.post(t, "/v1/children/sensor/start")
	if code != http.StatusConflict || !strings.Contains(body, "--no-sensor") {
		t.Fatalf("start sensor under --no-sensor: %d %s", code, body)
	}
}

func TestSecondInstanceIsRefused(t *testing.T) {
	r := startEngine(t, "stack", nil)
	cfg := r.cfg
	cfg.DataDir = t.TempDir()
	cfg.ControlAddr = r.addr
	cfg.OnListen = nil
	err := Run(context.Background(), cfg)
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Run returned %v, want ErrAlreadyRunning", err)
	}
	if _, serr := os.Stat(TokenPath(cfg.DataDir)); !os.IsNotExist(serr) {
		t.Fatal("the refused instance wrote a control token")
	}
	// The first one is untouched.
	if doc := r.status(t); child(doc, "stack").Name != "stack" {
		t.Fatalf("first engine status %+v", doc)
	}
}

func TestStackErrorIsReported(t *testing.T) {
	r := startEngine(t, "stack-error", nil)
	doc := r.waitStatus(t, "stack backoff", func(d control.StatusDoc) bool { return child(d, "stack").State == "backoff" })
	got := str(child(doc, "stack").LastError)
	if got != "Port 4100 is in use by another program. (exited with code 1)" {
		t.Fatalf("last error %q", got)
	}
	if doc.Stack != nil {
		t.Fatalf("stack URLs reported for a failed stack: %+v", doc.Stack)
	}
}

func TestCancelStopsEngine(t *testing.T) {
	t.Setenv(helperEnv, "stack")
	exe, _ := os.Executable()
	dir := t.TempDir()
	script := filepath.Join(dir, "local.mjs")
	os.WriteFile(script, nil, 0o600)
	cfg, err := Resolve(Config{Version: "t", Mode: "foreground", DataDir: dir, Node: exe, StackScript: script, NoSensor: true, ControlAddr: "127.0.0.1:0"}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	listening := make(chan string, 1)
	cfg.OnListen = func(a string) { listening <- a }
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg) }()
	addr := <-listening
	deadline := time.Now().Add(15 * time.Second)
	for {
		if doc, ok := control.Probe(addr, time.Second); ok && doc.Stack != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stack not ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("cancel did not stop the engine")
	}
	if _, ok := control.Probe(addr, 500*time.Millisecond); ok {
		t.Fatal("control API still answering after stop")
	}
}

func TestParseRunFlags(t *testing.T) {
	cfg, err := ParseRunFlags([]string{"--data-dir=D1", "--node", "N", "--stack-script=S", "--no-sensor", "--control-addr", "127.0.0.1:47999"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != "D1" || cfg.Node != "N" || cfg.StackScript != "S" || !cfg.NoSensor || cfg.ControlAddr != "127.0.0.1:47999" {
		t.Fatalf("cfg %+v", cfg)
	}
	if _, err := ParseRunFlags([]string{"--bogus"}, io.Discard); err == nil {
		t.Fatal("unknown flag accepted")
	}
	if _, err := ParseRunFlags([]string{"extra"}, io.Discard); err == nil {
		t.Fatal("stray argument accepted")
	}
}

func TestResolve(t *testing.T) {
	dir := t.TempDir()
	env := map[string]string{EnvDataDir: dir, EnvControlAddr: "127.0.0.1:47555"}
	cfg, err := Resolve(Config{StackScript: filepath.Join(dir, "x.mjs"), SensorExe: filepath.Join(dir, "s.exe")}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != dir || cfg.ControlAddr != "127.0.0.1:47555" {
		t.Fatalf("cfg %+v", cfg)
	}
	if cfg.SensorConfig != filepath.Join(dir, "collector", "collector.yaml") {
		t.Fatalf("sensor config %s", cfg.SensorConfig)
	}
	// LD_DATA_DIR (what local.mjs uses) is honoured when nothing more specific is set.
	cfg, err = Resolve(Config{StackScript: "x", SensorExe: "y"}, func(k string) string {
		if k == "LD_DATA_DIR" {
			return dir
		}
		return ""
	})
	if err != nil || cfg.DataDir != dir || cfg.ControlAddr != DefaultControlAddr {
		t.Fatalf("cfg %+v, %v", cfg, err)
	}
	for _, bad := range []string{"0.0.0.0:47140", "192.168.1.5:47140", "localhost:47140", "127.0.0.1"} {
		if _, err := Resolve(Config{DataDir: dir, ControlAddr: bad, StackScript: "x", SensorExe: "y"}, func(string) string { return "" }); err == nil {
			t.Errorf("control address %q accepted", bad)
		}
	}
}

func TestResolveFindsCheckout(t *testing.T) {
	// This package lives in <repo>/engine/internal/engine; the repository has scripts/local.mjs.
	wd, _ := os.Getwd()
	repo := filepath.Clean(filepath.Join(wd, "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(repo, "scripts", "local.mjs")); err != nil {
		t.Skip("not inside the source checkout")
	}
	cfg, err := Resolve(Config{}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StackScript != filepath.Join(repo, "scripts", "local.mjs") || cfg.DataDir != filepath.Join(repo, ".data") {
		t.Fatalf("cfg %+v", cfg)
	}
	if !strings.HasSuffix(cfg.SensorExe, filepath.Join("collectors", "lan-collector", "bin", "lan-collector")+exeSuffix()) {
		t.Fatalf("sensor exe %s", cfg.SensorExe)
	}
}

func exeSuffix() string {
	if filepath.Separator == '\\' {
		return ".exe"
	}
	return ""
}
