// Package engine is the Nigafiy Engine: it supervises the local database, API and web server as
// separate children (each one started through scripts/local.mjs --component=<name>), and the local
// Sensor, and serves the control API.
//
// Start order: database → API → web, and the Sensor once the API runs. Stop order is the reverse.
// Each child has its own restart backoff, ready check, health check, rotated and redacted log and
// Job Object.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nigafiy/engine/internal/control"
	"github.com/nigafiy/engine/internal/logs"
	"github.com/nigafiy/engine/internal/supervisor"
)

// ErrAlreadyRunning means another engine already answers on the control address.
var ErrAlreadyRunning = errors.New("a Nigafiy Engine is already running")

const (
	// SensorDisabledError is the sensor's last error under --no-sensor.
	SensorDisabledError = "disabled: the desktop app runs the Sensor"
	notEnrolledError    = "not enrolled"

	sensorStopTimeout = 5 * time.Second
	healthTimeout     = 3 * time.Second
)

// Components are the stack's children in start order, with what each needs running first.
var Components = []struct {
	Name         string
	Deps         []string
	StopTimeout  time.Duration
	ReadyTimeout time.Duration
}{
	// The first start creates the database cluster; later starts take seconds.
	{Name: "db", StopTimeout: 30 * time.Second, ReadyTimeout: 5 * time.Minute},
	// The API runs its migrations before it answers /readyz.
	{Name: "api", Deps: []string{"db"}, StopTimeout: 20 * time.Second, ReadyTimeout: 5 * time.Minute},
	// The development server compiles on first request; the installed app's server starts in seconds.
	{Name: "web", Deps: []string{"api"}, StopTimeout: 15 * time.Second, ReadyTimeout: 5 * time.Minute},
}

// Paths inside the data folder.
func engineDir(dataDir string) string { return filepath.Join(dataDir, "engine") }
func TokenPath(dataDir string) string { return filepath.Join(engineDir(dataDir), "control-token") }

// ComponentStatusPath is where local.mjs --component=<name> reports that it is ready.
func ComponentStatusPath(dataDir, name string) string {
	return filepath.Join(engineDir(dataDir), name+"-status.json")
}
func logPath(dataDir, name string) string { return filepath.Join(dataDir, "logs", name+".log") }

type engine struct {
	cfg       Config
	startedAt time.Time
	log       *log.Logger

	children map[string]*supervisor.Child // db, api, web, and sensor unless --no-sensor
	group    *group

	ready map[string]*atomic.Pointer[stackStatus] // what each component reported when it became ready

	updates *updater

	stopping     atomic.Bool
	shutdownOnce sync.Once
	shutdownCh   chan struct{}
}

// Run runs the engine until ctx is cancelled or POST /v1/shutdown, then stops the Sensor, the web
// server, the API and the database (in that order), and returns nil. cfg must have been through
// Resolve.
func Run(ctx context.Context, cfg Config) error {
	if doc, ok := control.Probe(cfg.ControlAddr, 2*time.Second); ok {
		return fmt.Errorf("%w at %s (mode %s, data folder %s)", ErrAlreadyRunning, cfg.ControlAddr, doc.Mode, doc.DataDir)
	}
	if err := os.MkdirAll(engineDir(cfg.DataDir), 0o700); err != nil {
		return err
	}
	logFile, err := logs.OpenRotating(logPath(cfg.DataDir, "engine"), logs.DefaultMaxSize, logs.DefaultKeep)
	if err != nil {
		return err
	}
	defer logFile.Close()
	var sink io.Writer = logFile
	if cfg.Console != nil {
		sink = io.MultiWriter(logFile, cfg.Console)
	}
	lw := logs.NewLineWriter(sink, nil)
	defer lw.Flush()
	e := &engine{
		cfg:        cfg,
		startedAt:  time.Now().UTC(),
		log:        log.New(lw, "", 0),
		shutdownCh: make(chan struct{}),
		children:   map[string]*supervisor.Child{},
		ready:      map[string]*atomic.Pointer[stackStatus]{},
	}

	listener, err := net.Listen("tcp", cfg.ControlAddr)
	if err != nil {
		// Something answered nothing like an engine, or we lost a race with another engine.
		if _, ok := control.Probe(cfg.ControlAddr, 2*time.Second); ok {
			return fmt.Errorf("%w at %s", ErrAlreadyRunning, cfg.ControlAddr)
		}
		return fmt.Errorf("control address %s is in use by another program: %w", cfg.ControlAddr, err)
	}
	addr := listener.Addr().String()

	token, err := control.NewToken()
	if err != nil {
		listener.Close()
		return err
	}
	tokenPath := TokenPath(cfg.DataDir)
	if err := control.WriteToken(tokenPath, token, cfg.OwnerSID); err != nil {
		listener.Close()
		return fmt.Errorf("writing the control token: %w", err)
	}
	defer os.Remove(tokenPath)

	e.log.Printf("Nigafiy Engine %s starting (%s mode, pid %d), data folder %s, control API http://%s", cfg.Version, cfg.Mode, os.Getpid(), cfg.DataDir, addr)

	var members []member
	for _, comp := range Components {
		out, err := logs.OpenRotating(logPath(cfg.DataDir, comp.Name), logs.DefaultMaxSize, logs.DefaultKeep)
		if err != nil {
			listener.Close()
			return err
		}
		defer out.Close()
		e.ready[comp.Name] = &atomic.Pointer[stackStatus]{}
		c := supervisor.New(e.componentSpec(comp.Name, comp.StopTimeout, comp.ReadyTimeout, logs.NewLineWriter(out, nil)), supervisor.Options{Logf: e.log.Printf})
		e.children[comp.Name] = c
		members = append(members, member{name: comp.Name, u: c, deps: comp.Deps})
	}
	if !cfg.NoSensor {
		sensorOut, err := logs.OpenRotating(logPath(cfg.DataDir, "sensor"), logs.DefaultMaxSize, logs.DefaultKeep)
		if err != nil {
			listener.Close()
			return err
		}
		defer sensorOut.Close()
		c := supervisor.New(e.sensorSpec(logs.NewLineWriter(sensorOut, nil)), supervisor.Options{Logf: e.log.Printf})
		e.children["sensor"] = c
		members = append(members, member{name: "sensor", u: c, deps: []string{"api"}})
	} else {
		e.log.Printf("sensor: not supervised (--no-sensor)")
	}
	e.group = newGroup(members, e.log.Printf)
	e.updates = newUpdater(e)

	server := control.New(e, token, addr)
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	if cfg.OnListen != nil {
		cfg.OnListen(addr)
	}

	e.group.StartAll()

	var runErr error
	select {
	case <-ctx.Done():
		e.log.Printf("stop requested")
	case <-e.shutdownCh:
		e.log.Printf("shutdown requested through the control API")
	case err := <-serveErr:
		runErr = fmt.Errorf("control API stopped: %w", err)
		e.log.Printf("%v", runErr)
	}
	e.stopping.Store(true)
	e.group.Close() // sensor, web, api, db
	server.Close()
	for _, comp := range Components {
		os.Remove(ComponentStatusPath(cfg.DataDir, comp.Name))
	}
	e.updates.afterStop()
	e.log.Printf("Nigafiy Engine stopped")
	return runErr
}

func (e *engine) componentSpec(name string, stopTimeout, readyTimeout time.Duration, out io.Writer) supervisor.Spec {
	statusFile := ComponentStatusPath(e.cfg.DataDir, name)
	env := withoutEnv(os.Environ(), "LD_DATA_DIR", "ELECTRON_RUN_AS_NODE", "LD_BUNDLE_DIR")
	env = append(env, "LD_DATA_DIR="+e.cfg.DataDir)
	if e.cfg.BundleDir != "" {
		env = append(env, "LD_BUNDLE_DIR="+e.cfg.BundleDir)
	} else if v := os.Getenv("LD_BUNDLE_DIR"); v != "" {
		env = append(env, "LD_BUNDLE_DIR="+v)
	}
	if !isPlainNode(e.cfg.Node) {
		// The installed desktop app's own executable runs local.mjs as Node.
		env = append(env, "ELECTRON_RUN_AS_NODE=1")
	}
	ready := e.ready[name]
	return supervisor.Spec{
		Name:         name,
		Path:         e.cfg.Node,
		Args:         []string{e.cfg.StackScript, "--component=" + name, "--engine-status-file=" + statusFile},
		Env:          env,
		Dir:          filepath.Dir(e.cfg.StackScript),
		Output:       out,
		Graceful:     true,
		StopTimeout:  stopTimeout,
		ReadyTimeout: readyTimeout,
		Precheck: func() error {
			ready.Store(nil)
			if err := os.Remove(statusFile); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("could not clear %s: %w", statusFile, err)
			}
			if e.cfg.Node == "" {
				return errors.New("Node.js 24 was not found: pass --node")
			}
			if e.cfg.StackScript == "" {
				return errors.New("the stack launcher (local.mjs) was not found: pass --stack-script")
			}
			if _, err := os.Stat(e.cfg.StackScript); err != nil {
				return fmt.Errorf("stack launcher not found: %s", e.cfg.StackScript)
			}
			return nil
		},
		ReadyCheck: func(pid int) (bool, error) {
			st, err := readStackStatus(statusFile)
			if err != nil || st.Pid != pid {
				return false, nil
			}
			switch st.State {
			case "ready":
				if err := st.validate(name); err != nil {
					return false, err
				}
				ready.Store(&st)
				return true, nil
			case "error":
				return false, errors.New(st.Message)
			}
			return false, nil
		},
		HealthCheck: func(int) error {
			st := ready.Load()
			if st == nil {
				return errors.New("no ready report")
			}
			return checkHealth(name, st, healthTimeout)
		},
		HealthInterval: 15 * time.Second,
		HealthFailures: 3,
	}
}

// checkHealth: the database accepts connections on its port; the API answers /readyz with 200; the
// web server answers its start page with anything below 500.
func checkHealth(name string, st *stackStatus, timeout time.Duration) error {
	switch name {
	case "db":
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(st.Port)), timeout)
		if err != nil {
			return fmt.Errorf("database port %d: %w", st.Port, err)
		}
		conn.Close()
		return nil
	case "api":
		return httpHealth(strings.TrimRight(st.APIURL, "/")+"/readyz", timeout, func(code int) bool { return code == http.StatusOK })
	case "web":
		return httpHealth(st.WebURL, timeout, func(code int) bool { return code < 500 })
	}
	return nil
}

func httpHealth(u string, timeout time.Duration, good func(int) bool) error {
	client := &http.Client{
		Timeout: timeout,
		// A health check never follows a redirect off the loopback address it was given.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	res, err := client.Get(u)
	if err != nil {
		return fmt.Errorf("GET %s: %w", u, err)
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if !good(res.StatusCode) {
		return fmt.Errorf("GET %s: HTTP %d", u, res.StatusCode)
	}
	return nil
}

func (e *engine) sensorSpec(out io.Writer) supervisor.Spec {
	return supervisor.Spec{
		Name:   "sensor",
		Path:   e.cfg.SensorExe,
		Args:   []string{"-config", e.cfg.SensorConfig},
		Env:    withoutEnv(os.Environ(), "LAN_COLLECTOR_ENROLLMENT_TOKEN"),
		Dir:    filepath.Dir(e.cfg.SensorConfig),
		Output: out,
		// On Windows the Sensor has no stop request to honour; killing it is safe because every
		// batch is in its on-disk spool before upload (as in the desktop app). Elsewhere: SIGTERM.
		Graceful:    runtime.GOOS != "windows",
		StopTimeout: sensorStopTimeout,
		Precheck: func() error {
			if _, err := os.Stat(e.cfg.SensorConfig); err != nil {
				return errors.New(notEnrolledError)
			}
			if e.cfg.SensorExe == "" {
				return errors.New("the Sensor program was not found: pass --sensor-exe")
			}
			if _, err := os.Stat(e.cfg.SensorExe); err != nil {
				return fmt.Errorf("Sensor program not found: %s", e.cfg.SensorExe)
			}
			return nil
		},
	}
}

// stackStatus is what local.mjs --component=<name> --engine-status-file=<path> writes.
type stackStatus struct {
	State     string `json:"state"`
	Component string `json:"component"`
	WebURL    string `json:"webUrl"`
	APIURL    string `json:"apiUrl"`
	Port      int    `json:"port"`
	Pid       int    `json:"pid"`
	Message   string `json:"message"`
}

// validate checks a ready report: the right component, and addresses on this computer only (the
// engine sends health checks there).
func (st stackStatus) validate(name string) error {
	if st.Component != "" && st.Component != name {
		return fmt.Errorf("status file reports component %q, expected %q", st.Component, name)
	}
	loopbackURL := func(raw string) error {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Port() == "" {
			return fmt.Errorf("bad address %q in the ready report", raw)
		}
		host := u.Hostname()
		if ip := net.ParseIP(host); (ip == nil || !ip.IsLoopback()) && !strings.EqualFold(host, "localhost") {
			return fmt.Errorf("address %q in the ready report is not on this computer", raw)
		}
		return nil
	}
	switch name {
	case "db":
		if st.Port <= 0 || st.Port > 65535 {
			return fmt.Errorf("bad database port %d in the ready report", st.Port)
		}
	case "api":
		return loopbackURL(st.APIURL)
	case "web":
		if err := loopbackURL(st.WebURL); err != nil {
			return err
		}
		return loopbackURL(st.APIURL)
	}
	return nil
}

func readStackStatus(path string) (stackStatus, error) {
	var st stackStatus
	b, err := os.ReadFile(path)
	if err != nil {
		return st, err
	}
	err = json.Unmarshal(b, &st)
	return st, err
}

// isPlainNode is true for node / node.exe; anything else (the desktop app's exe) needs
// ELECTRON_RUN_AS_NODE=1.
func isPlainNode(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	return base == "node" || base == "node.exe"
}

func withoutEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
outer:
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		for _, n := range names {
			if strings.EqualFold(key, n) {
				continue outer
			}
		}
		out = append(out, kv)
	}
	return out
}

// ── control.Backend ──────────────────────────────────────────────────────────

func childDoc(st supervisor.Status) control.ChildDoc {
	d := control.ChildDoc{Name: st.Name, State: string(st.State), Restarts: st.Restarts}
	if st.Pid != 0 {
		pid := st.Pid
		d.Pid = &pid
	}
	if st.LastError != "" {
		msg := st.LastError
		d.LastError = &msg
	}
	if !st.StartedAt.IsZero() {
		t := st.StartedAt.UTC()
		d.StartedAt = &t
	}
	if st.Health != supervisor.HealthUnknown {
		h := string(st.Health)
		d.Health = &h
	}
	if st.HealthError != "" {
		msg := st.HealthError
		d.HealthError = &msg
	}
	if !st.HealthCheckedAt.IsZero() {
		t := st.HealthCheckedAt.UTC()
		d.HealthCheckedAt = &t
	}
	return d
}

func (e *engine) doc(name string) control.ChildDoc {
	c := e.children[name]
	d := childDoc(c.Status())
	if m, ok := e.group.find(name); ok {
		d.DependsOn = append([]string{}, m.deps...)
	}
	if w := e.group.WaitingFor(name); w != "" {
		d.WaitingFor = &w
	}
	return d
}

func (e *engine) sensorDoc() control.ChildDoc {
	if _, ok := e.children["sensor"]; !ok {
		msg := SensorDisabledError
		return control.ChildDoc{Name: "sensor", State: string(supervisor.Stopped), LastError: &msg, DependsOn: []string{"api"}}
	}
	return e.doc("sensor")
}

func (e *engine) Status() control.StatusDoc {
	doc := control.StatusDoc{
		Version:   e.cfg.Version,
		Mode:      e.cfg.Mode,
		DataDir:   e.cfg.DataDir,
		StartedAt: e.startedAt,
	}
	for _, comp := range Components {
		doc.Children = append(doc.Children, e.doc(comp.Name))
	}
	doc.Children = append(doc.Children, e.sensorDoc())
	// The addresses are published once the API and the web server both run.
	if e.children["api"].Status().State == supervisor.Running && e.children["web"].Status().State == supervisor.Running {
		if api, web := e.ready["api"].Load(), e.ready["web"].Load(); api != nil && web != nil {
			doc.Stack = &control.StackDoc{WebURL: web.WebURL, APIURL: api.APIURL}
		}
	}
	if e.updates != nil {
		doc.Update = e.updates.doc()
	}
	return doc
}

func (e *engine) Child(name, action string) (control.ChildDoc, bool, error) {
	if name == "sensor" {
		if _, ok := e.children["sensor"]; !ok {
			return e.sensorDoc(), true, fmt.Errorf("%w: the Sensor is not supervised by this engine (started with --no-sensor; the desktop app runs it)", control.ErrRefused)
		}
	}
	if _, ok := e.children[name]; !ok {
		return control.ChildDoc{}, false, nil
	}
	if e.stopping.Load() {
		return e.doc(name), true, errors.New("the engine is shutting down")
	}
	e.log.Printf("%s: %s requested through the control API", name, action)
	var err error
	switch action {
	case "start":
		err = e.group.Start(name)
	case "stop":
		err = e.group.Stop(name)
	case "restart":
		err = e.group.Restart(name)
	}
	if errors.Is(err, errDependency) {
		err = fmt.Errorf("%w: %v", control.ErrRefused, err)
	}
	return e.doc(name), true, err
}

func (e *engine) Shutdown() {
	e.shutdownOnce.Do(func() { close(e.shutdownCh) })
}
