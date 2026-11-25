package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
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

// sensorHelperEnv selects what the stand-in Sensor does when the test binary is started as
// `<exe> sensor -config <file>`: "panic" panics after a moment (a crashing Sensor), anything else
// runs until killed. sensorArgsEnv, when set, is a file the stand-in appends its arguments to.
const (
	sensorHelperEnv = "ENGINE_TEST_SENSOR"
	sensorArgsEnv   = "ENGINE_TEST_SENSOR_ARGS"
)

func sensorHelper() int {
	if f := os.Getenv(sensorArgsEnv); f != "" {
		if out, err := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintln(out, strings.Join(os.Args[1:], " "))
			out.Close()
		}
	}
	if os.Getenv(sensorHelperEnv) == "panic" {
		time.Sleep(150 * time.Millisecond)
		panic("stand-in Sensor crashed")
	}
	time.Sleep(time.Hour)
	return 0
}

func helperMain(mode string) int {
	if len(os.Args) > 1 && os.Args[1] == "sensor" {
		return sensorHelper()
	}
	statusFile, component := "", ""
	for _, a := range os.Args[1:] {
		if v, ok := strings.CutPrefix(a, "--engine-status-file="); ok {
			statusFile = v
		}
		if v, ok := strings.CutPrefix(a, "--component="); ok {
			component = v
		}
	}
	write := func(v map[string]any) {
		v["pid"] = os.Getpid()
		v["component"] = component
		b, _ := json.Marshal(v)
		tmp := statusFile + ".tmp"
		os.WriteFile(tmp, b, 0o600)
		os.Rename(tmp, statusFile)
	}
	if mode == "stack-error" && component == "api" {
		write(map[string]any{"state": "error", "message": "Port 4100 is in use by another program."})
		return 1
	}
	if mode != "stack" && mode != "stack-error" {
		return 2
	}
	fmt.Println("helper started with", strings.Join(os.Args[1:], " "))
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 3
	}
	base := "http://" + l.Addr().String()
	switch component {
	case "db":
		go func() {
			for {
				c, err := l.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		write(map[string]any{"state": "ready", "port": l.Addr().(*net.TCPAddr).Port})
	case "api":
		go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/readyz" {
				w.Write([]byte("ok"))
				return
			}
			http.NotFound(w, r)
		}))
		write(map[string]any{"state": "ready", "apiUrl": base})
	case "web":
		go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<html>")) }))
		write(map[string]any{"state": "ready", "webUrl": base, "apiUrl": "http://127.0.0.1:14100"})
	default:
		return 4
	}
	waitForStop()
	fmt.Println("helper: stop requested, stopping cleanly")
	return 0
}

// waitForStop returns when the engine asks the child to stop: stdin closed (Windows and POSIX) or,
// on POSIX, SIGTERM, which the supervisor sends as well (process_other.go requestStop).
func waitForStop() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM)
	closed := make(chan struct{})
	go func() {
		io.Copy(io.Discard, os.Stdin)
		close(closed)
	}()
	select {
	case <-closed:
	case <-sig:
	}
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

func TestComponentsReadyInOrderSensorNotEnrolledAndShutdown(t *testing.T) {
	r := startEngine(t, "stack", nil)
	doc := r.waitStatus(t, "stack ready", func(d control.StatusDoc) bool { return d.Stack != nil })
	if !strings.HasPrefix(doc.Stack.WebURL, "http://127.0.0.1:") || !strings.HasPrefix(doc.Stack.APIURL, "http://127.0.0.1:") {
		t.Fatalf("stack %+v", doc.Stack)
	}
	if doc.Mode != "foreground" || doc.Version != "test" || doc.DataDir != r.cfg.DataDir {
		t.Fatalf("doc %+v", doc)
	}
	var names []string
	for _, c := range doc.Children {
		names = append(names, c.Name)
	}
	if strings.Join(names, ",") != "db,api,web,sensor" {
		t.Fatalf("children %v", names)
	}
	for _, name := range []string{"db", "api", "web"} {
		c := child(doc, name)
		if c.State != "running" || c.Pid == nil || c.StartedAt == nil {
			t.Fatalf("%s child %+v", name, c)
		}
	}
	if d := child(doc, "web").DependsOn; len(d) != 1 || d[0] != "api" {
		t.Fatalf("web depends on %v", d)
	}
	// Each component is its own process.
	if *child(doc, "db").Pid == *child(doc, "api").Pid || *child(doc, "api").Pid == *child(doc, "web").Pid {
		t.Fatal("components share a process")
	}
	sensor := child(doc, "sensor")
	if sensor.State != "stopped" || str(sensor.LastError) != "not enrolled" || sensor.Pid != nil {
		t.Fatalf("sensor child %+v", sensor)
	}
	if doc.Update == nil || doc.Update.State != "idle" {
		t.Fatalf("update %+v", doc.Update)
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
	for _, name := range []string{"db", "api", "web"} {
		out, _ := os.ReadFile(logPath(r.cfg.DataDir, name))
		if !strings.Contains(string(out), "--component="+name+" --engine-status-file=") {
			t.Fatalf("%s not started with the engine arguments: %q", name, out)
		}
		if !strings.Contains(string(out), "stop requested, stopping cleanly") {
			t.Fatalf("%s was not stopped gracefully: %q", name, out)
		}
	}
	engineLog, _ := os.ReadFile(logPath(r.cfg.DataDir, "engine"))
	if strings.Contains(string(engineLog), r.token) {
		t.Fatal("engine log contains the control token")
	}
	// Stopped in reverse order: web before api before db.
	el := string(engineLog)
	iw, ia, id := strings.Index(el, "web: stopped"), strings.Index(el, "api: stopped"), strings.Index(el, "db: stopped")
	if iw < 0 || ia < 0 || id < 0 || !(iw < ia && ia < id) {
		t.Fatalf("stop order in engine log: %q", el)
	}
	if !strings.Contains(el, "Nigafiy Engine stopped") {
		t.Fatalf("engine log: %q", el)
	}
}

func TestStopAPIStopsWebAndStartIsRefusedWithoutDatabase(t *testing.T) {
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true })
	r.waitStatus(t, "stack ready", func(d control.StatusDoc) bool { return d.Stack != nil })
	code, body := r.post(t, "/v1/children/api/stop")
	if code != 200 || !strings.Contains(body, `"state":"stopped"`) {
		t.Fatalf("stop api: %d %s", code, body)
	}
	doc := r.status(t)
	if child(doc, "web").State != "stopped" || child(doc, "db").State != "running" || doc.Stack != nil {
		t.Fatalf("after stopping the API: %+v", doc.Children)
	}
	code, body = r.post(t, "/v1/children/web/start")
	if code != http.StatusConflict || !strings.Contains(body, "start api first") {
		t.Fatalf("web start without api: %d %s", code, body)
	}
	if code, body = r.post(t, "/v1/children/api/start"); code != 200 {
		t.Fatalf("start api: %d %s", code, body)
	}
	r.waitStatus(t, "api running", func(d control.StatusDoc) bool { return child(d, "api").State == "running" })
	if code, body = r.post(t, "/v1/children/web/start"); code != 200 {
		t.Fatalf("start web: %d %s", code, body)
	}
	r.waitStatus(t, "stack ready again", func(d control.StatusDoc) bool { return d.Stack != nil })

	// Restarting the database brings the API and the web server back after it.
	if code, body = r.post(t, "/v1/children/db/restart"); code != 200 {
		t.Fatalf("restart db: %d %s", code, body)
	}
	r.waitStatus(t, "all back", func(d control.StatusDoc) bool {
		return d.Stack != nil && child(d, "api").State == "running" && child(d, "web").State == "running" && child(d, "db").Restarts == 0
	})
}

func TestSensorStartsOnceEnrolled(t *testing.T) {
	r := startEngine(t, "stack", nil)
	r.waitStatus(t, "sensor not enrolled", func(d control.StatusDoc) bool { return str(child(d, "sensor").LastError) == "not enrolled" })
	r.waitStatus(t, "api running", func(d control.StatusDoc) bool { return child(d, "api").State == "running" })
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
	if doc := r.status(t); child(doc, "db").Name != "db" {
		t.Fatalf("first engine status %+v", doc)
	}
}

func TestComponentErrorIsReportedAndDependentsWait(t *testing.T) {
	r := startEngine(t, "stack-error", nil)
	doc := r.waitStatus(t, "api backoff", func(d control.StatusDoc) bool { return child(d, "api").State == "backoff" })
	got := str(child(doc, "api").LastError)
	if got != "Port 4100 is in use by another program. (exited with code 1)" {
		t.Fatalf("last error %q", got)
	}
	if doc.Stack != nil {
		t.Fatalf("stack URLs reported for a failed API: %+v", doc.Stack)
	}
	if child(doc, "db").State != "running" {
		t.Fatalf("db %+v", child(doc, "db"))
	}
	web := child(doc, "web")
	if web.State != "stopped" || str(web.WaitingFor) != "api" || web.Pid != nil {
		t.Fatalf("web should wait for the API: %+v", web)
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
	// The legacy LD_DATA_DIR (what older launchers set) is honoured when nothing more specific is set.
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
	// The Sensor is this executable now (nigafiy-engine sensor), in a checkout too.
	self, _ := os.Executable()
	if !sameFile(cfg.SensorExe, self) || !cfg.SensorSelf {
		t.Fatalf("sensor exe %s (self %v), want this executable %s", cfg.SensorExe, cfg.SensorSelf, self)
	}
}

func exeSuffix() string {
	if filepath.Separator == '\\' {
		return ".exe"
	}
	return ""
}

func TestProfileDirKeepsTheLegacyFolder(t *testing.T) {
	base := t.TempDir()
	if got := ProfileDir(base, pathExists); got != filepath.Join(base, "Nigafiy") {
		t.Fatalf("neither: %s", got)
	}
	if err := os.MkdirAll(filepath.Join(base, "LAN Detective"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := ProfileDir(base, pathExists); got != filepath.Join(base, "LAN Detective") {
		t.Fatalf("only legacy: %s", got)
	}
	if err := os.MkdirAll(filepath.Join(base, "Nigafiy"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := ProfileDir(base, pathExists); got != filepath.Join(base, "Nigafiy") {
		t.Fatalf("both: %s", got)
	}
}

func TestEnvCompatPrefersTheNewName(t *testing.T) {
	env := map[string]string{"NIGAFIY_DATA_DIR": "new", "LD_DATA_DIR": "old", "LD_BUNDLE_DIR": "b"}
	get := func(k string) string { return env[k] }
	if v := envCompat(get, "NIGAFIY_DATA_DIR"); v != "new" {
		t.Fatalf("data dir %q", v)
	}
	if v := envCompat(get, "NIGAFIY_BUNDLE_DIR"); v != "b" {
		t.Fatalf("bundle dir %q", v)
	}
	if v := envCompat(get, "NIGAFIY_OTHER"); v != "" {
		t.Fatalf("other %q", v)
	}
}

func TestResolveSensorExe(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "engine", "nigafiy-engine"+exeSuffix())
	os.MkdirAll(filepath.Dir(self), 0o700)
	os.WriteFile(self, []byte("x"), 0o700)
	other := filepath.Join(dir, "dev", "nigafiy-sensor"+exeSuffix())
	os.MkdirAll(filepath.Dir(other), 0o700)
	os.WriteFile(other, []byte("x"), 0o700)
	orig := selfExecutable
	selfExecutable = func() (string, error) { return self, nil }
	t.Cleanup(func() { selfExecutable = orig })

	resolve := func(sensorExe string) Config {
		t.Helper()
		cfg, err := Resolve(Config{DataDir: dir, StackScript: "x", SensorExe: sensorExe}, func(string) string { return "" })
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	cases := []struct {
		name, in, want string
		self, note     bool
	}{
		{"default is this executable", "", self, true, false},
		{"this executable named explicitly", self, self, true, false},
		{"another existing program keeps the old interface", other, other, false, false},
		{"missing nigafiy-sensor from before the merge", filepath.Join(dir, "app", "resources", "collector", "nigafiy-sensor.exe"), self, true, true},
		{"missing lan-collector from before the rename", filepath.Join(dir, "old", "lan-collector"), self, true, true},
		{"any other missing program is reported, not replaced", filepath.Join(dir, "typo", "sensr.exe"), filepath.Join(dir, "typo", "sensr.exe"), false, false},
	}
	for _, c := range cases {
		cfg := resolve(c.in)
		if cfg.SensorExe != c.want || cfg.SensorSelf != c.self || (cfg.SensorNote != "") != c.note {
			t.Errorf("%s: exe %s self %v note %q; want %s self %v note %v", c.name, cfg.SensorExe, cfg.SensorSelf, cfg.SensorNote, c.want, c.self, c.note)
		}
	}
	// The environment variable works like the flag.
	cfg, err := Resolve(Config{DataDir: dir, StackScript: "x"}, func(k string) string {
		if k == EnvSensorExe {
			return other
		}
		return ""
	})
	if err != nil || cfg.SensorExe != other || cfg.SensorSelf {
		t.Fatalf("env: %+v %v", cfg, err)
	}
}

func TestSensorArgs(t *testing.T) {
	cfg := Config{SensorConfig: "C"}
	if got := strings.Join(SensorArgs(cfg), " "); got != "-config C" {
		t.Fatalf("another program: %q", got)
	}
	cfg.SensorSelf = true
	if got := strings.Join(SensorArgs(cfg), " "); got != "sensor -config C" {
		t.Fatalf("this executable: %q", got)
	}
}

// The Sensor runs as a child process of the engine's own executable. A Sensor that panics over
// and over is restarted with backoff, and the database, API and web server keep running with the
// same processes: a Sensor crash never reaches the engine's supervision.
func TestSensorPanicIsIsolatedAndRestarted(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "sensor-args.txt")
	t.Setenv(sensorHelperEnv, "panic")
	t.Setenv(sensorArgsEnv, argsFile)
	r := startEngine(t, "stack", func(c *Config) { c.SensorExe = "" }) // default: this executable
	if !r.cfg.SensorSelf {
		t.Fatalf("the Sensor is not this executable: %+v", r.cfg)
	}
	os.MkdirAll(filepath.Dir(r.cfg.SensorConfig), 0o700)
	os.WriteFile(r.cfg.SensorConfig, []byte("server_url: http://127.0.0.1:1\n"), 0o600)
	before := r.waitStatus(t, "stack running", func(d control.StatusDoc) bool {
		return child(d, "db").State == "running" && child(d, "api").State == "running" && child(d, "web").State == "running"
	})
	if code, body := r.post(t, "/v1/children/sensor/start"); code != 200 {
		t.Fatalf("start sensor: %d %s", code, body)
	}
	// Between starts the Sensor waits in backoff with its exit as the last error.
	after := r.waitStatus(t, "sensor restarted twice after crashing", func(d control.StatusDoc) bool {
		s := child(d, "sensor")
		return s.Restarts >= 2 && s.State == "backoff" && str(s.LastError) != ""
	})
	for _, name := range []string{"db", "api", "web"} {
		b, a := child(before, name), child(after, name)
		if a.State != "running" || a.Restarts != 0 || a.Pid == nil || b.Pid == nil || *a.Pid != *b.Pid {
			t.Errorf("%s was disturbed by the Sensor crash: before %+v after %+v", name, b, a)
		}
	}
	t.Logf("sensor after crashes: restarts %d, last error %q", child(after, "sensor").Restarts, str(child(after, "sensor").LastError))
	// The engine started itself with the sensor subcommand.
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := strings.Cut(string(b), "\n")
	if want := "sensor -config " + r.cfg.SensorConfig; strings.TrimSpace(first) != want {
		t.Fatalf("sensor started with %q, want %q", first, want)
	}
	// The engine still answers and shuts down cleanly.
	if code, _ := r.post(t, "/v1/shutdown"); code != 200 && code != 202 {
		t.Fatalf("shutdown: %d", code)
	}
	<-r.done
	if r.err != nil {
		t.Fatalf("engine stopped with %v", r.err)
	}
}
