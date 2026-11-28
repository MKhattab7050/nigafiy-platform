package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Where the agent reaches its server when the address it was installed with stops answering
// (1.0.10 at home: the router gave the server PC a new address, .147 → .138, and the agent on that
// same PC stayed offline for hours).
//
// Each heartbeat answer lists other addresses of the same server (`server_addresses`: its Tailscale
// address, its home network addresses, its computer name). The agent keeps them in its state folder.
// When the address in use does not connect, it tries, in order: the home address (the -server it was
// installed with), the listed ones, and this computer itself (127.0.0.1 on the same port: the agent
// on the server's own PC). It stays on the first that answers and, while away from home, tries home
// again every few minutes.
//
// Every address is the same server: the certificate pin (which replaces the host name check) still
// decides what is trusted, so a listed address cannot point the agent at anything else. Without a pin
// only https addresses with a certificate valid for that name are accepted by the normal TLS check.

const (
	maxServerAddrs   = 8
	serverHomeRetry  = 5 * time.Minute
	serverProbeLimit = 4 * time.Second
	serverAddrsName  = "server-addresses.json"
)

// errServerUnreachable wraps a request that did not reach the server (no connection, timeout): only
// those make the agent look for another address; an HTTP answer, even an error, means it is there.
var errServerUnreachable = errors.New("server unreachable")

type serverAddrsFile struct {
	Home   string   `json:"home"`
	Active string   `json:"active,omitempty"`
	Known  []string `json:"known,omitempty"`
}

type serverAddrs struct {
	mu          sync.Mutex
	path        string
	home        string
	active      string
	known       []string
	lastHomeTry time.Time
}

// loadServerAddrs reads what the agent learnt before; a different home (reinstalled for another
// server) starts again from that home.
func loadServerAddrs(home, stateDir string) *serverAddrs {
	s := fixedServer(home)
	if stateDir == "" {
		return s
	}
	s.path = filepath.Join(stateDir, serverAddrsName)
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return s
	}
	var f serverAddrsFile
	if json.Unmarshal(raw, &f) != nil || f.Home != home {
		return s
	}
	s.known = normaliseServerAddrs(f.Known, home)
	if a := normaliseServerAddr(f.Active, home); a != "" {
		s.active = a
	}
	return s
}

// normaliseServerAddr returns the address without a trailing slash and path, or "" when it is not
// one the agent may use: https only (plain http only when home itself is http, a test setup).
func normaliseServerAddr(raw, home string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	if u.Path != "" && u.Path != "/" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	homeScheme := ""
	if h, err := url.Parse(home); err == nil {
		homeScheme = strings.ToLower(h.Scheme)
	}
	if scheme != "https" && !(scheme == "http" && homeScheme == "http") {
		return ""
	}
	return scheme + "://" + u.Host
}

func normaliseServerAddrs(list []string, home string) []string {
	out := []string{}
	for _, raw := range list {
		a := normaliseServerAddr(raw, home)
		if a == "" || a == home || slices.Contains(out, a) {
			continue
		}
		out = append(out, a)
		if len(out) == maxServerAddrs {
			break
		}
	}
	return out
}

// loopbackOf is home's port on this computer (the server's own PC).
func loopbackOf(home string) string {
	u, err := url.Parse(home)
	if err != nil || u.Host == "" {
		return ""
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[strings.ToLower(u.Scheme)]
	}
	return strings.ToLower(u.Scheme) + "://" + net.JoinHostPort("127.0.0.1", port)
}

func (s *serverAddrs) current() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// candidates: home, the listed addresses, then this computer; the one in use is left out (it just
// failed).
func (s *serverAddrs) candidates() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{}
	for _, a := range append(append([]string{s.home}, s.known...), loopbackOf(s.home)) {
		if a != "" && a != s.active && !slices.Contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

// learn keeps the server's list (a heartbeat that sent one); false when nothing changed.
func (s *serverAddrs) learn(list []string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := normaliseServerAddrs(list, s.home)
	if slices.Equal(next, s.known) {
		return false
	}
	s.known = next
	s.saveLocked()
	return true
}

func (s *serverAddrs) use(a string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == a {
		return
	}
	s.active = a
	s.saveLocked()
}

// homeDue: away from home and the last try at home is old enough.
func (s *serverAddrs) homeDue(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == s.home || now.Sub(s.lastHomeTry) < serverHomeRetry {
		return false
	}
	s.lastHomeTry = now
	return true
}

func (s *serverAddrs) saveLocked() {
	if s.path == "" {
		return
	}
	raw, err := json.Marshal(serverAddrsFile{Home: s.home, Active: s.active, Known: s.known})
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

// server is the address requests go to now.
func (a *Agent) server() string { return a.addrs.current() }

// probeServer: the server answers /healthz at addr (same TLS settings, so the pin applies).
func (a *Agent) probeServer(ctx context.Context, addr string) bool {
	ctx, cancel := context.WithTimeout(ctx, serverProbeLimit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr+"/healthz", nil)
	if err != nil {
		return false
	}
	req.Header.Set("User-Agent", "nigafiy-agent/"+a.version)
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// findServer looks for another address after the one in use did not connect; true when it moved.
func (a *Agent) findServer(ctx context.Context) bool {
	for _, c := range a.addrs.candidates() {
		if ctx.Err() != nil {
			return false
		}
		if a.probeServer(ctx, c) {
			from := a.addrs.current()
			a.addrs.use(c)
			a.log.Info("server answers at another address", "from", from, "to", c)
			return true
		}
	}
	return false
}

// tryHome goes back to the home address when it answers again.
func (a *Agent) tryHome(ctx context.Context) {
	if !a.addrs.homeDue(time.Now()) {
		return
	}
	home := a.addrs.home
	if a.probeServer(ctx, home) {
		a.addrs.use(home)
		a.log.Info("back at the home server address", "server", home)
	}
}

// fixedServer is one address with nothing saved (tests, and agents built without a state folder).
func fixedServer(addr string) *serverAddrs {
	return &serverAddrs{home: addr, active: addr}
}
