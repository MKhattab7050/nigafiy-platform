// Package engine is the Nigafiy Engine: it supervises the local stack (database, API, web server,
// started through scripts/local.mjs) and the local Sensor, and serves the control API.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
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

	stackStopTimeout  = 45 * time.Second
	stackReadyTimeout = 10 * time.Minute
	sensorStopTimeout = 5 * time.Second
)

// Paths inside the data folder.
func engineDir(dataDir string) string { return filepath.Join(dataDir, "engine") }
func TokenPath(dataDir string) string { return filepath.Join(engineDir(dataDir), "control-token") }
func StackStatusPath(dataDir string) string {
	return filepath.Join(engineDir(dataDir), "stack-status.json")
}
func logPath(dataDir, name string) string { return filepath.Join(dataDir, "logs", name+".log") }

type engine struct {
	cfg       Config
	startedAt time.Time
	log       *log.Logger

	stack  *supervisor.Child
	sensor *supervisor.Child // nil with --no-sensor

	urls atomic.Pointer[control.StackDoc]

	stopping     atomic.Bool
	shutdownOnce sync.Once
	shutdownCh   chan struct{}
}

// Run runs the engine until ctx is cancelled or POST /v1/shutdown, then stops the Sensor, then the
// stack, and returns nil. cfg must have been through Resolve.
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
	e := &engine{cfg: cfg, startedAt: time.Now().UTC(), log: log.New(lw, "", 0), shutdownCh: make(chan struct{})}

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

	stackOut, err := logs.OpenRotating(logPath(cfg.DataDir, "stack"), logs.DefaultMaxSize, logs.DefaultKeep)
	if err != nil {
		listener.Close()
		return err
	}
	defer stackOut.Close()
	e.stack = supervisor.New(e.stackSpec(logs.NewLineWriter(stackOut, nil)), supervisor.Options{Logf: e.log.Printf})
	if !cfg.NoSensor {
		sensorOut, err := logs.OpenRotating(logPath(cfg.DataDir, "sensor"), logs.DefaultMaxSize, logs.DefaultKeep)
		if err != nil {
			listener.Close()
			return err
		}
		defer sensorOut.Close()
		e.sensor = supervisor.New(e.sensorSpec(logs.NewLineWriter(sensorOut, nil)), supervisor.Options{Logf: e.log.Printf})
	} else {
		e.log.Printf("sensor: not supervised (--no-sensor)")
	}

	server := control.New(e, token, addr)
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	if cfg.OnListen != nil {
		cfg.OnListen(addr)
	}

	e.stack.Start()
	if e.sensor != nil {
		e.sensor.Start()
	}

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
	if e.sensor != nil {
		e.sensor.Close()
	}
	e.stack.Close()
	server.Close()
	os.Remove(StackStatusPath(cfg.DataDir))
	e.log.Printf("Nigafiy Engine stopped")
	return runErr
}

func (e *engine) stackSpec(out io.Writer) supervisor.Spec {
	statusFile := StackStatusPath(e.cfg.DataDir)
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
	return supervisor.Spec{
		Name:         "stack",
		Path:         e.cfg.Node,
		Args:         []string{e.cfg.StackScript, "--no-open", "--no-collector", "--engine-status-file=" + statusFile},
		Env:          env,
		Dir:          filepath.Dir(e.cfg.StackScript),
		Output:       out,
		Graceful:     true,
		StopTimeout:  stackStopTimeout,
		ReadyTimeout: stackReadyTimeout,
		Precheck: func() error {
			e.urls.Store(nil)
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
				e.urls.Store(&control.StackDoc{WebURL: st.WebURL, APIURL: st.APIURL})
				return true, nil
			case "error":
				return false, errors.New(st.Message)
			}
			return false, nil
		},
	}
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

type stackStatus struct {
	State   string `json:"state"`
	WebURL  string `json:"webUrl"`
	APIURL  string `json:"apiUrl"`
	Pid     int    `json:"pid"`
	Message string `json:"message"`
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
	return d
}

func (e *engine) sensorDoc() control.ChildDoc {
	if e.sensor == nil {
		msg := SensorDisabledError
		return control.ChildDoc{Name: "sensor", State: string(supervisor.Stopped), LastError: &msg}
	}
	return childDoc(e.sensor.Status())
}

func (e *engine) Status() control.StatusDoc {
	stack := e.stack.Status()
	doc := control.StatusDoc{
		Version:   e.cfg.Version,
		Mode:      e.cfg.Mode,
		DataDir:   e.cfg.DataDir,
		StartedAt: e.startedAt,
		Children:  []control.ChildDoc{childDoc(stack), e.sensorDoc()},
	}
	if stack.State == supervisor.Running {
		doc.Stack = e.urls.Load()
	}
	return doc
}

func (e *engine) Child(name, action string) (control.ChildDoc, bool, error) {
	var c *supervisor.Child
	switch name {
	case "stack":
		c = e.stack
	case "sensor":
		if e.sensor == nil {
			return e.sensorDoc(), true, fmt.Errorf("%w: the Sensor is not supervised by this engine (started with --no-sensor; the desktop app runs it)", control.ErrRefused)
		}
		c = e.sensor
	default:
		return control.ChildDoc{}, false, nil
	}
	if e.stopping.Load() {
		return childDoc(c.Status()), true, errors.New("the engine is shutting down")
	}
	e.log.Printf("%s: %s requested through the control API", name, action)
	var err error
	switch action {
	case "start":
		err = c.Start()
	case "stop":
		err = c.Stop()
	case "restart":
		err = c.Restart()
	}
	return childDoc(c.Status()), true, err
}

func (e *engine) Shutdown() {
	e.shutdownOnce.Do(func() { close(e.shutdownCh) })
}
