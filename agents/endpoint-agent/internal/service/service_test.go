package service

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/desktop"
)

// The test binary doubles as a session helper process: with NIGAFIY_TEST_HELPER=1 it serves the
// real Local desktop on stdin/stdout, exactly what `nigafiy-agent session-helper` does.
func TestMain(m *testing.M) {
	if os.Getenv("NIGAFIY_TEST_HELPER") == "1" {
		_ = desktop.Serve(context.Background(), os.Stdin, os.Stdout, desktop.NewLocal())
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestValidName(t *testing.T) {
	for _, ok := range []string{"NigafiyEndpointAgent", "nigafiy-endpoint-agent", "com.nigafiy.endpoint-agent", "A_1"} {
		if err := ValidName(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "-x", "has space", `a\b`, "a/b", "a;b", strings.Repeat("a", 65), "x\"y"} {
		if ValidName(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestServiceCommandLineNeverCarriesTheEnrollmentToken(t *testing.T) {
	cfg := config.Config{
		ServerURL: "http://127.0.0.1:4162", EnrollmentToken: "ld_enroll_secret_value", StateDir: "rel-state",
		CAFile: "ca.pem", TLSPinSHA256: "aa:bb", LogLevel: "info", AllowInsecureHTTP: true,
	}
	args, err := RunArgs(cfg, "NigafiyEndpointAgentTest")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "ld_enroll_secret_value") || slices.Contains(args, "-token") {
		t.Fatalf("token on the service command line: %v", args)
	}
	if args[0] != "run" {
		t.Fatalf("service must run the `run` subcommand: %v", args)
	}
	idx := slices.Index(args, "-state-dir")
	if idx < 0 || !filepath.IsAbs(args[idx+1]) {
		t.Fatalf("state dir must be absolute (services start in system32 or /): %v", args)
	}
	ca := slices.Index(args, "-ca-file")
	if ca < 0 || !filepath.IsAbs(args[ca+1]) {
		t.Fatalf("CA file must be absolute: %v", args)
	}
	for _, want := range []string{"-service-name", "NigafiyEndpointAgentTest", "-server", "http://127.0.0.1:4162", "-tls-pin", "aa:bb", "-allow-insecure-http"} {
		if !slices.Contains(args, want) {
			t.Errorf("missing %q in %v", want, args)
		}
	}
	cfg.AllowInsecureHTTP, cfg.CAFile, cfg.TLSPinSHA256 = false, "", ""
	args, _ = RunArgs(cfg, "x")
	for _, absent := range []string{"-allow-insecure-http", "-ca-file", "-tls-pin"} {
		if slices.Contains(args, absent) {
			t.Errorf("%s present although not configured: %v", absent, args)
		}
	}
}

// pipeLauncher serves a desktop over an in-memory pipe and pretends to track a session.
type pipeLauncher struct {
	launches atomic.Int32
	stops    atomic.Int32
	stale    atomic.Bool
	mu       sync.Mutex
}

func (p *pipeLauncher) Describe() string { return "in-memory test helper" }
func (p *pipeLauncher) Stale() bool      { return p.stale.Load() }
func (p *pipeLauncher) Launch(_ context.Context) (io.ReadWriteCloser, func(), error) {
	p.launches.Add(1)
	a, b := net.Pipe()
	go func() { _ = desktop.Serve(context.Background(), b, b, desktop.NewLocalWith(nil, nil)) }()
	var once sync.Once
	return a, func() {
		once.Do(func() {
			p.stops.Add(1)
			p.stale.Store(false) // the next helper starts in the (new) active session
			_ = a.Close()
			_ = b.Close()
		})
	}, nil
}

func TestWatchRestartsTheHelperWhenTheActiveSessionChanges(t *testing.T) {
	l := &pipeLauncher{}
	sup := desktop.NewSupervisor(l, nil)
	defer sup.Close()
	if info := sup.Info(); info.Mode != "session_helper" {
		t.Fatalf("info through the helper: %+v", info)
	}
	if l.launches.Load() != 1 {
		t.Fatalf("launches = %d", l.launches.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Watch(ctx, sup, l, 10*time.Millisecond, nil)

	time.Sleep(50 * time.Millisecond)
	if l.stops.Load() != 0 {
		t.Fatal("restarted although the session did not change")
	}
	l.stale.Store(true) // e.g. fast user switching
	deadline := time.Now().Add(2 * time.Second)
	for l.stops.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if l.stops.Load() != 1 {
		t.Fatal("the helper of the old session was not stopped")
	}
	if info := sup.Info(); info.Mode != "session_helper" || l.launches.Load() != 2 {
		t.Fatalf("no new helper after the change: launches=%d info=%+v", l.launches.Load(), info)
	}
}

func TestWatchIgnoresLaunchersThatDoNotTrackSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		Watch(ctx, desktop.NewSupervisor(desktop.ExecLauncher{Path: "x"}, nil), desktop.ExecLauncher{Path: "x"}, time.Millisecond, nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Watch should return at once for a launcher without session tracking")
	}
}
