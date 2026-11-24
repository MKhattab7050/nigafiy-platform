// Package control is the engine's local control channel: a small HTTP API on a loopback address
// that the Hub and the API read status from and send start/stop requests to.
package control

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/nigafiy/engine/internal/update"
)

// ChildDoc is one supervised child in GET /v1/status.
type ChildDoc struct {
	Name      string     `json:"name"`
	State     string     `json:"state"`
	Pid       *int       `json:"pid"`        // null when no process is running
	Restarts  int        `json:"restarts"`   // automatic restarts since the engine started
	LastError *string    `json:"last_error"` // null when there is none
	StartedAt *time.Time `json:"started_at"` // null when no process is running

	Health          *string    `json:"health"`            // "ok" | "failing"; null before the first check or without one
	HealthError     *string    `json:"health_error"`      // the latest failed check, while failing
	HealthCheckedAt *time.Time `json:"health_checked_at"` // null until checked
	DependsOn       []string   `json:"depends_on"`        // started only once these run
	WaitingFor      *string    `json:"waiting_for"`       // the dependency it waits for before starting
}

// UpdateDoc is the engine's update state in GET /v1/status.
type UpdateDoc struct {
	State   string         `json:"state"`   // "idle" | "applying"
	Version *string        `json:"version"` // the version being installed, while applying
	Last    *update.Result `json:"last"`    // the outcome of the last installation, if any
	// Install says how this installation was installed (null in a source checkout). An MSI-managed
	// installation ("msi") is updated by its administrator through Group Policy or Intune: the
	// engine refuses to run the NSIS update over it.
	Install *update.InstallInfo `json:"install"`
}

// StackDoc carries the local stack's addresses once it is ready.
type StackDoc struct {
	WebURL string `json:"web_url"`
	APIURL string `json:"api_url"`
}

// StatusDoc is the body of GET /v1/status. It never contains secrets.
type StatusDoc struct {
	Version   string     `json:"version"`
	Mode      string     `json:"mode"` // "service" | "foreground"
	DataDir   string     `json:"data_dir"`
	StartedAt time.Time  `json:"started_at"`
	Children  []ChildDoc `json:"children"`
	Stack     *StackDoc  `json:"stack"`  // null until the API and the web server are ready
	Update    *UpdateDoc `json:"update"` // null when the engine has no update support
	// Programs is the programs choice the stack was given (NIGAFIY_PROGRAMS).
	Programs *ProgramsDoc `json:"programs"`
}

// ProgramsDoc says which programs this installation was set up with and where that came from.
type ProgramsDoc struct {
	Value  string `json:"value"`  // "all", a comma list, or "" (nothing recorded: all)
	Source string `json:"source"` // env | HKCU | HKLM | default | invalid
	Error  string `json:"error,omitempty"`
}

// ErrRefused marks a child action the engine will not perform in its current configuration (for
// example starting the Sensor when the engine runs with --no-sensor). It is answered with 409.
var ErrRefused = errors.New("refused")

// ErrUpdateRejected marks an update the engine will not install (wrong place, wrong hash, wrong
// signer, not an installed copy). It is answered with 422.
var ErrUpdateRejected = errors.New("update rejected")

// Backend is what the server controls.
type Backend interface {
	Status() StatusDoc
	// Child runs action ("start", "stop", "restart") on the named child. ok is false when there is
	// no child of that name.
	Child(name, action string) (doc ChildDoc, ok bool, err error)
	// Shutdown asks the engine to stop its children and exit. It must not block.
	Shutdown()
	// ApplyUpdate verifies a staged installer and hands it to the update helper, which installs it
	// once the engine has stopped (the engine then shuts down by itself).
	ApplyUpdate(req update.Request) (UpdateDoc, error)
}

// Server serves the control API.
type Server struct {
	backend Backend
	token   string
	host    string // the only Host header accepted: the address actually listened on
	http    *http.Server
}

// New returns a server for a listener on addr (host:port as bound, e.g. "127.0.0.1:47140").
func New(backend Backend, token, addr string) *Server {
	s := &Server{backend: backend, token: token, host: addr}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("POST /v1/children/{name}/{action}", s.authed(s.child))
	mux.HandleFunc("POST /v1/shutdown", s.authed(s.shutdown))
	mux.HandleFunc("POST /v1/update/apply", s.authed(s.applyUpdate))
	s.http = &http.Server{
		Handler:           s.guard(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// A stop waits for the child to exit (the stack gets up to 45 s to stop cleanly).
		WriteTimeout:   2 * time.Minute,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	return s
}

// Serve serves on l until Close.
func (s *Server) Serve(l net.Listener) error {
	err := s.http.Serve(l)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Close stops the server.
func (s *Server) Close() error { return s.http.Close() }

// guard rejects any request whose Host header is not the address we listen on: a web page that
// rebinds its own DNS name to 127.0.0.1 still sends its own name as Host.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Host, s.host) {
			writeError(w, http.StatusForbidden, "forbidden_host", "requests must be addressed to "+s.host)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="nigafiy-engine"`)
			writeError(w, http.StatusUnauthorized, "unauthorized", "a valid control token is required")
			return
		}
		next(w, r)
	}
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.backend.Status())
}

func (s *Server) child(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	if action != "start" && action != "stop" && action != "restart" {
		writeError(w, http.StatusNotFound, "unknown_action", "action must be start, stop or restart")
		return
	}
	doc, ok, err := s.backend.Child(r.PathValue("name"), action)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_child", "no child named "+r.PathValue("name"))
		return
	}
	if errors.Is(err, ErrRefused) {
		writeError(w, http.StatusConflict, "refused", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "engine_stopping", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) shutdown(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	s.backend.Shutdown()
}

func (s *Server) applyUpdate(w http.ResponseWriter, r *http.Request) {
	var req update.Request
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "body must be {installer, sha256, version}")
		return
	}
	doc, err := s.backend.ApplyUpdate(req)
	switch {
	case errors.Is(err, ErrRefused):
		writeError(w, http.StatusConflict, "refused", err.Error())
	case errors.Is(err, ErrUpdateRejected):
		writeError(w, http.StatusUnprocessableEntity, "update_rejected", err.Error())
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "update_failed", err.Error())
	default:
		writeJSON(w, http.StatusAccepted, doc)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, kind, message string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": kind, "message": message}})
}

// Probe asks addr whether a Nigafiy Engine is answering there. It returns the status when one is.
func Probe(addr string, timeout time.Duration) (*StatusDoc, bool) {
	client := &http.Client{Timeout: timeout}
	res, err := client.Get("http://" + addr + "/v1/status")
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, false
	}
	var doc StatusDoc
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, false
	}
	if doc.Version == "" || doc.Children == nil {
		return nil, false
	}
	return &doc, true
}
