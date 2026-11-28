package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/sysinfo"
)

func TestNormaliseServerAddr(t *testing.T) {
	home := "https://192.168.1.147:47143"
	cases := map[string]string{
		"https://192.168.1.138:47143":   "https://192.168.1.138:47143",
		"https://192.168.1.138:47143/":  "https://192.168.1.138:47143",
		" HTTPS://DESKTOP-X:47143 ":     "https://DESKTOP-X:47143",
		"http://192.168.1.138:47143":    "", // plain http only when home is http
		"https://192.168.1.138/api":     "", // a path is not an address
		"https://u:p@192.168.1.138":     "",
		"https://192.168.1.138/?x=1":    "",
		"ftp://192.168.1.138":           "",
		"192.168.1.138:47143":           "",
		"":                              "",
		"https://100.95.99.101:47143#x": "",
	}
	for raw, want := range cases {
		if got := normaliseServerAddr(raw, home); got != want {
			t.Errorf("normaliseServerAddr(%q) = %q, want %q", raw, got, want)
		}
	}
	if got := normaliseServerAddr("http://127.0.0.1:4200", "http://127.0.0.1:4100"); got != "http://127.0.0.1:4200" {
		t.Errorf("http home should allow http addresses, got %q", got)
	}
	// Home itself and repeats are dropped, the list is capped.
	list := []string{home, "https://a:1", "https://a:1/"}
	for i := 0; i < 20; i++ {
		list = append(list, "https://h"+string(rune('a'+i))+":1")
	}
	got := normaliseServerAddrs(list, home)
	if len(got) != maxServerAddrs || got[0] != "https://a:1" || slices.Contains(got, home) {
		t.Errorf("normaliseServerAddrs = %v", got)
	}
}

func TestServerAddrsCandidatesAndPersistence(t *testing.T) {
	dir := t.TempDir()
	home := "https://192.168.1.147:47143"
	s := loadServerAddrs(home, dir)
	if s.current() != home {
		t.Fatalf("starts at home, got %q", s.current())
	}
	if !s.learn([]string{"https://100.95.99.101:47143", "https://192.168.1.138:47143"}) {
		t.Fatal("learn should report a change")
	}
	if s.learn([]string{"https://100.95.99.101:47143", "https://192.168.1.138:47143"}) {
		t.Fatal("the same list again is no change")
	}
	// In use = home, so home is left out; this computer comes last on home's port.
	want := []string{"https://100.95.99.101:47143", "https://192.168.1.138:47143", "https://127.0.0.1:47143"}
	if got := s.candidates(); !slices.Equal(got, want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	s.use("https://192.168.1.138:47143")
	want = []string{home, "https://100.95.99.101:47143", "https://127.0.0.1:47143"}
	if got := s.candidates(); !slices.Equal(got, want) {
		t.Fatalf("candidates away from home = %v, want %v", got, want)
	}

	// A restart keeps where it was and what it learnt.
	again := loadServerAddrs(home, dir)
	if again.current() != "https://192.168.1.138:47143" || len(again.known) != 2 {
		t.Fatalf("reloaded: active %q known %v", again.current(), again.known)
	}
	// Reinstalled for another server: start again from that home.
	other := loadServerAddrs("https://10.0.0.5:47143", dir)
	if other.current() != "https://10.0.0.5:47143" || len(other.known) != 0 {
		t.Fatalf("new home kept old state: active %q known %v", other.current(), other.known)
	}
	// A saved list with a bad entry (edited by hand) keeps only the good ones.
	raw, _ := json.Marshal(serverAddrsFile{Home: home, Active: "http://evil:1", Known: []string{"https://ok:1", "javascript:x"}})
	if err := os.WriteFile(filepath.Join(dir, serverAddrsName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	edited := loadServerAddrs(home, dir)
	if edited.current() != home || !slices.Equal(edited.known, []string{"https://ok:1"}) {
		t.Fatalf("edited file: active %q known %v", edited.current(), edited.known)
	}
}

func TestServerAddrsHomeDue(t *testing.T) {
	s := fixedServer("https://h:1")
	now := time.Now()
	if s.homeDue(now) {
		t.Fatal("at home: nothing to retry")
	}
	s.use("https://b:1")
	if !s.homeDue(now) {
		t.Fatal("away from home: first retry is due")
	}
	if s.homeDue(now.Add(time.Minute)) {
		t.Fatal("retry again only after serverHomeRetry")
	}
	if !s.homeDue(now.Add(serverHomeRetry + time.Second)) {
		t.Fatal("retry due again after serverHomeRetry")
	}
}

func TestLoopbackOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://192.168.1.147:47143": "https://127.0.0.1:47143",
		"https://server.lan":          "https://127.0.0.1:443",
		"http://x":                    "http://127.0.0.1:80",
		"nonsense":                    "",
	} {
		if got := loopbackOf(in); got != want {
			t.Errorf("loopbackOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// forwarder stands in for the server's old address: it passes TCP to the real server until closed.
type forwarder struct {
	ln    net.Listener
	mu    sync.Mutex
	conns []net.Conn
}

func newForwarder(t *testing.T, target string) *forwarder {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &forwarder{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				continue
			}
			f.mu.Lock()
			f.conns = append(f.conns, c, up)
			f.mu.Unlock()
			go func() { _, _ = io.Copy(up, c); up.Close() }()
			go func() { _, _ = io.Copy(c, up); c.Close() }()
		}
	}()
	return f
}

func (f *forwarder) url() string { return "https://" + f.ln.Addr().String() }

func (f *forwarder) close() {
	f.ln.Close()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
}

func TestAgentFollowsServerToListedAddress(t *testing.T) {
	var mu sync.Mutex
	var listed *[]string
	heartbeats := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/healthz":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/v1/agent/enroll":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"endpoint_id": "ep-move", "credential": "lda_ep-move.secret"})
		case "/api/v1/agent/heartbeat":
			heartbeats++
			resp := map[string]any{"heartbeat_interval_seconds": 10, "commands": []any{}}
			if listed != nil {
				resp["server_addresses"] = *listed
			}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer srv.Close()
	newAddr := srv.URL
	old := newForwarder(t, srv.Listener.Addr().String())

	sum := sha256.Sum256(srv.Certificate().Raw)
	cfg := &config.Config{
		ServerURL:       old.url(),
		EnrollmentToken: "ldea_test-token-01234567890123456789",
		StateDir:        t.TempDir(),
		TLSPinSHA256:    formatColonPin(sum[:]),
		LogLevel:        "error",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		CollectHealth:    func(context.Context, time.Time) sysinfo.Health { return sysinfo.Health{Hostname: "pc", OS: "windows", Arch: "amd64", LoggedInUsers: []string{}} },
		CollectInventory: func(context.Context) sysinfo.Inventory { return sysinfo.Inventory{} },
		ExecuteCommand:   func(_ context.Context, c control.Command) control.Result { return control.Result{ID: c.ID, OK: true} },
	}
	a, err := New(cfg, deps, slog.New(slog.NewTextHandler(io.Discard, nil)), "1.0.10-test", DefaultTuning())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := a.ensureEnrolled(ctx); err != nil {
		t.Fatal(err)
	}

	// 1. At home, the server lists its other address: the agent keeps it, and stays home.
	mu.Lock()
	listed = &[]string{newAddr}
	mu.Unlock()
	attempt := 0
	_ = a.heartbeatOnce(ctx, &attempt)
	if attempt != 0 || a.server() != old.url() || !slices.Equal(a.addrs.known, []string{newAddr}) {
		t.Fatalf("after heartbeat: attempt %d server %q known %v", attempt, a.server(), a.addrs.known)
	}
	// An answer without the field keeps what is known.
	mu.Lock()
	listed = nil
	mu.Unlock()
	_ = a.heartbeatOnce(ctx, &attempt)
	if !slices.Equal(a.addrs.known, []string{newAddr}) {
		t.Fatalf("absent server_addresses dropped the list: %v", a.addrs.known)
	}

	// 2. The old address stops answering: the agent finds the listed one and retries at once.
	old.close()
	a.httpClient.CloseIdleConnections()
	if wait := a.heartbeatOnce(ctx, &attempt); wait != time.Second {
		t.Fatalf("after moving the agent should retry at once, waited %v", wait)
	}
	if a.server() != newAddr {
		t.Fatalf("agent did not move: %q", a.server())
	}
	mu.Lock()
	before := heartbeats
	mu.Unlock()
	attempt = 0
	_ = a.heartbeatOnce(ctx, &attempt)
	mu.Lock()
	after := heartbeats
	mu.Unlock()
	if attempt != 0 || after != before+1 {
		t.Fatalf("heartbeat at the new address: attempt %d, server saw %d→%d", attempt, before, after)
	}

	// 3. A restart starts at the address that answered.
	if again := loadServerAddrs(old.url(), cfg.StateDir); again.current() != newAddr {
		t.Fatalf("restart starts at %q", again.current())
	}

	// 4. Home is tried again only after a while, and it stays away while home is dead.
	a.tryHome(ctx)
	if a.server() != newAddr {
		t.Fatalf("dead home taken back: %q", a.server())
	}
}

func TestFindServerSkipsAddressesThatDoNotAnswer(t *testing.T) {
	bad := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer bad.Close()
	good := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer good.Close()
	a := &Agent{log: slog.New(slog.NewTextHandler(io.Discard, nil)), httpClient: good.Client(), addrs: fixedServer("https://127.0.0.1:1")}
	a.addrs.learn([]string{bad.URL, good.URL})
	if !a.findServer(context.Background()) || a.server() != good.URL {
		t.Fatalf("findServer went to %q", a.server())
	}
	// Nothing answers: stay where it is.
	b := &Agent{log: a.log, httpClient: good.Client(), addrs: fixedServer("https://127.0.0.1:1")}
	b.addrs.learn([]string{bad.URL})
	if b.findServer(context.Background()) || b.server() != "https://127.0.0.1:1" {
		t.Fatalf("findServer with nothing answering moved to %q", b.server())
	}
}
