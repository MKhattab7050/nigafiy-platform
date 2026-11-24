package control

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/engine/internal/update"
)

type fakeBackend struct {
	mu       sync.Mutex
	actions  []string
	shutdown int
	updates  []update.Request
	applyErr error
}

func (f *fakeBackend) ApplyUpdate(req update.Request) (UpdateDoc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.applyErr != nil {
		return UpdateDoc{}, f.applyErr
	}
	f.updates = append(f.updates, req)
	v := req.Version
	return UpdateDoc{State: "applying", Version: &v}, nil
}

func (f *fakeBackend) Status() StatusDoc {
	pid := 42
	return StatusDoc{
		Version:   "1.2.3",
		Mode:      "foreground",
		DataDir:   `C:\data`,
		StartedAt: time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC),
		Children: []ChildDoc{
			{Name: "stack", State: "running", Pid: &pid, StartedAt: &time.Time{}},
			{Name: "sensor", State: "stopped", LastError: ptr("not enrolled")},
		},
		Stack: &StackDoc{WebURL: "http://localhost:3100", APIURL: "http://localhost:4100"},
	}
}

func ptr(s string) *string { return &s }

func (f *fakeBackend) Child(name, action string) (ChildDoc, bool, error) {
	if name != "stack" && name != "sensor" {
		return ChildDoc{}, false, nil
	}
	f.mu.Lock()
	f.actions = append(f.actions, name+":"+action)
	f.mu.Unlock()
	return ChildDoc{Name: name, State: "starting"}, true, nil
}

func (f *fakeBackend) Shutdown() {
	f.mu.Lock()
	f.shutdown++
	f.mu.Unlock()
}

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func startServer(t *testing.T) (string, *fakeBackend) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &fakeBackend{}
	s := New(b, testToken, l.Addr().String())
	go s.Serve(l)
	t.Cleanup(func() { s.Close() })
	return l.Addr().String(), b
}

func do(t *testing.T, method, url, host, auth string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestStatusShape(t *testing.T) {
	addr, _ := startServer(t)
	res, body := do(t, "GET", "http://"+addr+"/v1/status", "", "")
	if res.StatusCode != 200 {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if got := strings.Join(keys, ","); got != "children,data_dir,mode,programs,stack,started_at,update,version" {
		t.Fatalf("top-level keys %s", got)
	}
	var children []map[string]json.RawMessage
	json.Unmarshal(raw["children"], &children)
	if len(children) != 2 {
		t.Fatalf("children %s", raw["children"])
	}
	keys = keys[:0]
	for k := range children[1] {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if got := strings.Join(keys, ","); got != "depends_on,health,health_checked_at,health_error,last_error,name,pid,restarts,started_at,state,waiting_for" {
		t.Fatalf("child keys %s", got)
	}
	if string(children[1]["pid"]) != "null" || string(children[1]["last_error"]) != `"not enrolled"` {
		t.Fatalf("sensor child %s", raw["children"])
	}
	if string(raw["stack"]) != `{"web_url":"http://localhost:3100","api_url":"http://localhost:4100"}` {
		t.Fatalf("stack %s", raw["stack"])
	}
	if strings.Contains(body, testToken) {
		t.Fatal("status leaks the token")
	}
	if doc, ok := Probe(addr, time.Second); !ok || doc.Version != "1.2.3" {
		t.Fatalf("Probe = %+v, %v", doc, ok)
	}
}

func TestControlRequiresToken(t *testing.T) {
	addr, b := startServer(t)
	url := "http://" + addr + "/v1/children/sensor/start"
	for name, auth := range map[string]string{
		"no token":        "",
		"wrong token":     "Bearer " + strings.Repeat("0", 64),
		"short token":     "Bearer 0123",
		"not bearer":      "Basic " + testToken,
		"token, no space": "Bearer" + testToken,
	} {
		res, _ := do(t, "POST", url, "", auth)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, res.StatusCode)
		}
	}
	res, _ := do(t, "POST", "http://"+addr+"/v1/shutdown", "", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("shutdown without token: %d", res.StatusCode)
	}
	if len(b.actions) != 0 || b.shutdown != 0 {
		t.Fatalf("unauthenticated requests reached the backend: %v %d", b.actions, b.shutdown)
	}

	res, body := do(t, "POST", url, "", "Bearer "+testToken)
	if res.StatusCode != 200 || !strings.Contains(body, `"state":"starting"`) {
		t.Fatalf("with token: %d %s", res.StatusCode, body)
	}
	res, _ = do(t, "POST", "http://"+addr+"/v1/children/nope/start", "", "Bearer "+testToken)
	if res.StatusCode != 404 {
		t.Fatalf("unknown child: %d", res.StatusCode)
	}
	res, _ = do(t, "POST", "http://"+addr+"/v1/children/stack/explode", "", "Bearer "+testToken)
	if res.StatusCode != 404 {
		t.Fatalf("unknown action: %d", res.StatusCode)
	}
	res, _ = do(t, "GET", url, "", "Bearer "+testToken)
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET on a POST route: %d", res.StatusCode)
	}
	res, _ = do(t, "POST", "http://"+addr+"/v1/shutdown", "", "Bearer "+testToken)
	if res.StatusCode != http.StatusAccepted || b.shutdown != 1 {
		t.Fatalf("shutdown: %d, calls %d", res.StatusCode, b.shutdown)
	}
	if strings.Join(b.actions, " ") != "sensor:start" {
		t.Fatalf("actions %v", b.actions)
	}
}

func TestHostHeaderGuard(t *testing.T) {
	addr, b := startServer(t)
	_, port, _ := net.SplitHostPort(addr)
	for _, host := range []string{"evil.example:" + port, "localhost:" + port, "127.0.0.1", "127.0.0.1:1"} {
		res, _ := do(t, "GET", "http://"+addr+"/v1/status", host, "")
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("Host %q: status %d, want 403", host, res.StatusCode)
		}
		res, _ = do(t, "POST", "http://"+addr+"/v1/shutdown", host, "Bearer "+testToken)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("Host %q shutdown: status %d, want 403", host, res.StatusCode)
		}
	}
	if b.shutdown != 0 {
		t.Fatal("a rebinding request reached the backend")
	}
}

func TestProbeIgnoresOtherServers(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, `{"hello":"world"}`) })}
	go srv.Serve(l)
	defer srv.Close()
	if _, ok := Probe(l.Addr().String(), time.Second); ok {
		t.Fatal("a non-engine server was taken for an engine")
	}
	l.Close()
	if _, ok := Probe(l.Addr().String(), 200*time.Millisecond); ok {
		t.Fatal("a closed port was taken for an engine")
	}
}

func TestWriteTokenRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine", "control-token")
	tok, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 64 {
		t.Fatalf("token length %d", len(tok))
	}
	if err := WriteToken(path, tok, ""); err != nil {
		t.Fatal(err)
	}
	// Writing again replaces it.
	tok2, _ := NewToken()
	if err := WriteToken(path, tok2, ""); err != nil {
		t.Fatal(err)
	}
	got, err := ReadToken(path)
	if err != nil || got != tok2 {
		t.Fatalf("ReadToken = %q, %v", got, err)
	}
	checkTokenACL(t, path)
}

func post(t *testing.T, url, auth, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestUpdateApplyNeedsTokenAndValidBody(t *testing.T) {
	addr, b := startServer(t)
	url := "http://" + addr + "/v1/update/apply"
	good := `{"installer":"C:/data/updates/staged/Nigafiy-Setup-1.2.4.exe","sha256":"` + strings.Repeat("a", 64) + `","version":"1.2.4"}`
	if res, _ := post(t, url, "", good); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, _ := post(t, url, "Bearer "+testToken, `{"installer":"x","extra":1}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field: %d", res.StatusCode)
	}
	res, body := post(t, url, "Bearer "+testToken, good)
	if res.StatusCode != http.StatusAccepted || !strings.Contains(body, `"state":"applying"`) {
		t.Fatalf("apply: %d %s", res.StatusCode, body)
	}
	if len(b.updates) != 1 || b.updates[0].Version != "1.2.4" {
		t.Fatalf("backend got %+v", b.updates)
	}
	b.applyErr = errors.Join(ErrUpdateRejected, errors.New("installer SHA-256 does not match"))
	if res, body := post(t, url, "Bearer "+testToken, good); res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(body, "does not match") {
		t.Fatalf("rejected: %d %s", res.StatusCode, body)
	}
	b.applyErr = errors.Join(ErrRefused, errors.New("source checkout"))
	if res, _ := post(t, url, "Bearer "+testToken, good); res.StatusCode != http.StatusConflict {
		t.Fatalf("refused: %d", res.StatusCode)
	}
}
