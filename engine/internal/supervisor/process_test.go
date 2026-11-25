package supervisor

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/nigafiy/engine/internal/logs"
)

// The test binary doubles as the child process: with SUPERVISOR_TEST_HELPER set it behaves as
// told instead of running the tests.
const helperEnv = "SUPERVISOR_TEST_HELPER"

func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnv); mode != "" {
		os.Exit(helperMain(mode))
	}
	os.Exit(m.Run())
}

func helperMain(mode string) int {
	switch {
	case strings.HasPrefix(mode, "exit:"):
		code, _ := strconv.Atoi(strings.TrimPrefix(mode, "exit:"))
		fmt.Println("helper exiting with", code)
		return code
	case mode == "hang":
		// A child that ignores the stop request (SIGTERM too, on POSIX): only the kill ends it.
		signal.Ignore(syscall.SIGTERM)
		fmt.Println(helperReady)
		time.Sleep(time.Hour)
		return 0
	case mode == "token":
		// Split over two writes, as a real child's buffered output can be.
		fmt.Fprint(os.Stderr, "enrolling with lde_SECRETSECRET")
		os.Stderr.Sync()
		fmt.Fprintln(os.Stderr, "SECRET1234 and credential ldc_0123456789abcdef.zzzzzzzzzz")
		fmt.Println("done")
		return 0
	case mode == "stdin":
		// Stops cleanly when stdin is closed, like scripts/local.mjs in engine mode.
		waitForStop()
		fmt.Println("stop requested, stopping")
		return 0
	case mode == "tree":
		exe, _ := os.Executable()
		cmd := exec.Command(exe)
		cmd.Env = append(os.Environ(), helperEnv+"=hang")
		if err := cmd.Start(); err != nil {
			fmt.Println("could not start grandchild:", err)
			return 1
		}
		fmt.Printf("grandchild=%d\n", cmd.Process.Pid)
		time.Sleep(time.Hour)
		return 0
	}
	fmt.Println("unknown helper mode", mode)
	return 2
}

// waitForStop returns when the engine asks the child to stop: stdin closed (Windows and POSIX) or,
// on POSIX, SIGTERM, which the supervisor sends as well (process_other.go requestStop).
func waitForStop() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM)
	fmt.Println(helperReady)
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

// helperReady is printed once a helper's stop handling is in place. A test that stops a child
// right after starting it waits for it: on POSIX the stop request is a SIGTERM, which would
// otherwise kill the helper before its handler exists (seen on the Linux CI, 0.2 ms after start).
const helperReady = "helper ready"

// readyWriter passes output through and closes ready when the helper says it is ready.
type readyWriter struct {
	next  io.Writer
	ready chan struct{}
	once  sync.Once
	seen  strings.Builder
	mu    sync.Mutex
}

func newReadyWriter(next io.Writer) *readyWriter {
	if next == nil {
		next = io.Discard
	}
	return &readyWriter{next: next, ready: make(chan struct{})}
}

func (w *readyWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	if w.seen.Len() < 4096 {
		w.seen.Write(b)
		if strings.Contains(w.seen.String(), helperReady) {
			w.once.Do(func() { close(w.ready) })
		}
	}
	w.mu.Unlock()
	return w.next.Write(b)
}

func (w *readyWriter) Flush() {
	if f, ok := w.next.(interface{ Flush() }); ok {
		f.Flush()
	}
}

func (w *readyWriter) wait(t *testing.T) {
	t.Helper()
	select {
	case <-w.ready:
	case <-time.After(10 * time.Second):
		t.Fatal("helper never said it was ready")
	}
}

func helperSpec(t *testing.T, mode string) Spec {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Spec{
		Name:        "helper",
		Path:        exe,
		Env:         append(os.Environ(), helperEnv+"="+mode),
		StopTimeout: 500 * time.Millisecond,
	}
}

func fastPolicy() *Policy {
	return &Policy{InitialBackoff: time.Hour, MaxBackoff: time.Hour, ResetAfter: time.Hour, MaxDeaths: 5, DeathWindow: time.Hour}
}

func TestRealProcessExitCodeIsRecorded(t *testing.T) {
	c := New(helperSpec(t, "exit:3"), Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	st := waitFor(t, c, "backoff", inState(Backoff))
	if st.LastError != "exited with code 3" {
		t.Fatalf("last error %q", st.LastError)
	}
}

func TestRealProcessHangIsKilledOnStop(t *testing.T) {
	spec := helperSpec(t, "hang")
	spec.Graceful = true
	rw := newReadyWriter(nil)
	spec.Output = rw
	c := New(spec, Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	st := waitFor(t, c, "running", inState(Running))
	rw.wait(t)
	pid := st.Pid
	start := time.Now()
	c.Stop()
	if took := time.Since(start); took < 400*time.Millisecond {
		t.Fatalf("stopped after %s; a child ignoring the stop request should be killed only after the timeout", took)
	}
	if st := c.Status(); st.State != Stopped || st.Pid != 0 {
		t.Fatalf("status %+v", st)
	}
	if processAlive(pid) {
		t.Fatalf("pid %d still alive", pid)
	}
}

func TestRealProcessStopsGracefullyOnStdinClose(t *testing.T) {
	dir := t.TempDir()
	out, err := logs.OpenRotating(filepath.Join(dir, "child.log"), logs.DefaultMaxSize, logs.DefaultKeep)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	spec := helperSpec(t, "stdin")
	spec.Graceful = true
	spec.StopTimeout = 20 * time.Second
	rw := newReadyWriter(logs.NewLineWriter(out, nil))
	spec.Output = rw
	c := New(spec, Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	waitFor(t, c, "running", inState(Running))
	rw.wait(t)
	start := time.Now()
	c.Stop()
	if took := time.Since(start); took > 10*time.Second {
		t.Fatalf("graceful stop took %s", took)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "child.log"))
	if !strings.Contains(string(data), "stop requested, stopping") {
		t.Fatalf("child did not stop on its own; log: %q", data)
	}
}

func TestRealProcessOutputIsRedacted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "child.log")
	out, err := logs.OpenRotating(path, logs.DefaultMaxSize, logs.DefaultKeep)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	spec := helperSpec(t, "token")
	spec.Output = logs.NewLineWriter(out, nil)
	c := New(spec, Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	st := waitFor(t, c, "exit", inState(Backoff))
	if st.LastError != "exited unexpectedly with code 0" {
		t.Fatalf("last error %q", st.LastError)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "SECRET") || strings.Contains(text, "zzzzzzzzzz") {
		t.Fatalf("secret reached the log: %q", text)
	}
	if !strings.Contains(text, "enrolling with [redacted] and credential [redacted]") || !strings.Contains(text, "done") {
		t.Fatalf("unexpected log: %q", text)
	}
}

func TestRealProcessTreeIsKilled(t *testing.T) {
	r, w := io.Pipe()
	spec := helperSpec(t, "tree")
	spec.Output = w
	c := New(spec, Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	grandchild := make(chan int, 1)
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "grandchild="); ok {
				n, _ := strconv.Atoi(v)
				grandchild <- n
			}
		}
	}()
	var gpid int
	select {
	case gpid = <-grandchild:
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not report its grandchild")
	}
	if !processAlive(gpid) {
		t.Fatalf("grandchild %d not running before stop", gpid)
	}
	c.Stop()
	w.Close()
	deadline := time.Now().Add(5 * time.Second)
	for processAlive(gpid) {
		if time.Now().After(deadline) {
			t.Fatalf("grandchild %d survived the stop", gpid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRealProcessMissingExecutable(t *testing.T) {
	spec := Spec{Name: "missing", Path: filepath.Join(t.TempDir(), "nope.exe")}
	c := New(spec, Options{Policy: fastPolicy()})
	defer c.Close()
	c.Start()
	st := c.Status()
	if st.State != Backoff || !strings.HasPrefix(st.LastError, "could not start:") {
		t.Fatalf("status %+v", st)
	}
}
