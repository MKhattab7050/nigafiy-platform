// Package agent coordinates enrollment, periodic health heartbeats, full inventory collection,
// and remote administration command execution for a managed endpoint.
package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/rdstream"
	"github.com/nigafiy/agent/internal/sysinfo"
)

var (
	ErrUnauthorized = errors.New("rejected by server: credential or token is invalid")
	ErrRejected     = errors.New("rejected by server: payload not accepted")
)

type Deps struct {
	CollectHealth    func(ctx context.Context, started time.Time) sysinfo.Health
	CollectInventory func(ctx context.Context) sysinfo.Inventory
	ExecuteCommand   func(ctx context.Context, cmd control.Command) control.Result
	// Desktop does the remote-desktop work (capture, input, consent, banner, clipboard): in this
	// process, or through the session helper when the agent runs as a service. Nil: commands of a
	// remote desktop session go to ExecuteCommand (as before Fleet Pro).
	Desktop desktop.Desktop
}

func SystemDeps() Deps {
	runner := control.DefaultRunner()
	return Deps{
		CollectHealth:    sysinfo.CollectHealth,
		CollectInventory: sysinfo.CollectInventory,
		ExecuteCommand:   runner.Execute,
		Desktop:          desktop.NewLocal(),
	}
}

type Tuning struct {
	HeartbeatInterval   time.Duration
	InventoryInterval   time.Duration
	CommandPollInterval time.Duration
	MaxBackoff          time.Duration
	// LongPollWait is how long the server may hold a command poll open (?wait_ms=). 0 disables the
	// long poll (short polls every CommandPollInterval, the pre-Fleet-Pro behaviour).
	LongPollWait time.Duration
	// MaxPollBackoff caps the wait between failed polls.
	MaxPollBackoff time.Duration
}

func DefaultTuning() Tuning {
	return Tuning{
		HeartbeatInterval:   20 * time.Second,
		InventoryInterval:   2 * time.Minute,
		CommandPollInterval: 500 * time.Millisecond,
		MaxBackoff:          2 * time.Minute,
		LongPollWait:        20 * time.Second,
		MaxPollBackoff:      30 * time.Second,
	}
}

type Agent struct {
	cfg        *config.Config
	deps       Deps
	log        *slog.Logger
	version    string
	started    time.Time
	tuning     Tuning
	baseURL    string
	httpClient *http.Client
	// pollClient is httpClient's transport with a timeout long enough for a held long poll.
	pollClient *http.Client
	tlsConfig  *tls.Config

	mu         sync.Mutex
	credential string
	results    []control.Result
	seenCmds   map[string]bool

	wakeHeartbeat chan struct{}
	wakeInventory chan struct{}
	cmdSem        chan struct{}

	sessions *rdstream.Manager
}

func New(cfg *config.Config, deps Deps, log *slog.Logger, version string, tuning Tuning) (*Agent, error) {
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read ca_file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("ca_file contains no certificates")
		}
		tlsCfg.RootCAs = pool
	}
	if strings.TrimSpace(cfg.TLSPinSHA256) != "" {
		pin, err := config.ParsePin(cfg.TLSPinSHA256)
		if err != nil {
			return nil, err
		}
		want := append([]byte(nil), pin...)
		tlsCfg.InsecureSkipVerify = true // replaced by explicit SHA-256 pin verification below
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error { return VerifyPinnedChain(cs.PeerCertificates, want, time.Now()) }
	}
	transport := &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConns: 4, IdleConnTimeout: 90 * time.Second, Proxy: http.ProxyFromEnvironment}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	a := &Agent{
		cfg:           cfg,
		deps:          deps,
		log:           log,
		version:       version,
		started:       time.Now(),
		tuning:        tuning,
		baseURL:       strings.TrimRight(cfg.ServerURL, "/"),
		tlsConfig:     tlsCfg,
		httpClient:    &http.Client{Timeout: 20 * time.Second, Transport: transport, CheckRedirect: noRedirect},
		pollClient:    &http.Client{Timeout: tuning.LongPollWait + 20*time.Second, Transport: transport, CheckRedirect: noRedirect},
		seenCmds:      map[string]bool{},
		wakeHeartbeat: make(chan struct{}, 1),
		wakeInventory: make(chan struct{}, 1),
		cmdSem:        make(chan struct{}, 16),
	}
	if deps.Desktop != nil {
		a.sessions = rdstream.NewManager(rdstream.Config{
			ServerURL:  a.baseURL,
			TLS:        tlsCfg,
			Credential: a.currentCredential,
			UserAgent:  "nigafiy-agent/" + version,
			Desktop:    deps.Desktop,
			Log:        log,
			NotifyEnded: func(ctx context.Context, sessionID string) error {
				return a.post(ctx, "/rd-session/end", map[string]any{"session_id": sessionID}, true, nil)
			},
		})
	}
	return a, nil
}

func (a *Agent) currentCredential() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.credential
}

type credentialFile struct {
	EndpointID string `json:"endpoint_id"`
	Credential string `json:"credential"`
}

func (a *Agent) credentialPath() string {
	return filepath.Join(a.cfg.StateDir, "credential.json")
}

func (a *Agent) Run(ctx context.Context) error {
	if err := a.ensureEnrolled(ctx); err != nil {
		return err
	}
	// Notice for transparency on managed company machines.
	a.log.Info("MANAGED ENDPOINT NOTICE: This computer is enrolled in LAN Detective IT Operations (inventory, health, and authorized remote administration are active)")

	var wg sync.WaitGroup
	for _, fn := range []func(context.Context){a.heartbeatLoop, a.inventoryLoop, a.commandPollLoop} {
		wg.Add(1)
		go func(loop func(context.Context)) {
			defer wg.Done()
			loop(ctx)
		}(fn)
	}
	wg.Wait()
	// Stopping the agent ends any open session here: its banner goes, its stream closes.
	if a.sessions != nil {
		a.sessions.Close("", "agent_stopped")
	}
	if a.deps.Desktop != nil {
		_ = a.deps.Desktop.Close()
	}
	return nil
}

// Enroll spends the enrollment token now (installing the service does this, so the single-use
// token never lands on the service command line). Nothing happens when already enrolled.
func (a *Agent) Enroll(ctx context.Context) error { return a.ensureEnrolled(ctx) }

func (a *Agent) ensureEnrolled(ctx context.Context) error {
	if raw, err := os.ReadFile(a.credentialPath()); err == nil {
		var c credentialFile
		if json.Unmarshal(raw, &c) == nil && c.Credential != "" {
			a.mu.Lock()
			a.credential = c.Credential
			a.mu.Unlock()
			a.log.Info("using stored endpoint identity", "endpoint_id", c.EndpointID)
			return nil
		}
		return fmt.Errorf("state file %s is corrupt; delete it and enroll again with a new token", a.credentialPath())
	}
	if a.cfg.EnrollmentToken == "" {
		return errors.New("this endpoint is not enrolled: provide an enrollment token (NIGAFIY_AGENT_ENROLLMENT_TOKEN or -token)")
	}
	h := a.deps.CollectHealth(ctx, a.started)
	payload := map[string]any{
		"enrollment_token": a.cfg.EnrollmentToken,
		"hostname":         h.Hostname,
		"agent_version":    a.version,
		"os":               h.OS,
		"arch":             h.Arch,
		"cpu_cores":        h.CPUCores,
	}
	if h.RAMTotalMB > 0 {
		payload["ram_total_mb"] = h.RAMTotalMB
	}
	if h.OSVersion != "" {
		payload["os_version"] = h.OSVersion
	}
	if h.CPUModel != "" {
		payload["cpu_model"] = h.CPUModel
	}
	if h.PrimaryIP != "" {
		payload["primary_ip"] = h.PrimaryIP
	}
	if h.PrimaryMAC != "" {
		payload["primary_mac"] = h.PrimaryMAC
	}
	if h.Manufacturer != "" {
		payload["manufacturer"] = h.Manufacturer
	}
	if h.Model != "" {
		payload["model"] = h.Model
	}
	if h.SerialNumber != "" {
		payload["serial_number"] = h.SerialNumber
	}

	var resp struct {
		EndpointID string `json:"endpoint_id"`
		Credential string `json:"credential"`
	}
	err := a.post(ctx, "/enroll", payload, false, &resp)
	if err != nil {
		if errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrRejected) {
			return errors.New("enrollment refused: the token is invalid, already used, or expired")
		}
		return err
	}
	raw, _ := json.Marshal(credentialFile{EndpointID: resp.EndpointID, Credential: resp.Credential})
	if err := os.WriteFile(a.credentialPath(), raw, 0o600); err != nil {
		return fmt.Errorf("store credential: %w", err)
	}
	a.mu.Lock()
	a.credential = resp.Credential
	a.mu.Unlock()
	a.log.Info("enrolled endpoint", "endpoint_id", resp.EndpointID)
	return nil
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	attempt := 0
	for {
		wait := a.heartbeatOnce(ctx, &attempt)
		select {
		case <-ctx.Done():
			return
		case <-a.wakeHeartbeat:
		case <-time.After(wait):
		}
	}
}

func (a *Agent) heartbeatOnce(ctx context.Context, attempt *int) time.Duration {
	h := a.deps.CollectHealth(ctx, a.started)
	a.mu.Lock()
	results := append([]control.Result{}, a.results...)
	a.mu.Unlock()

	body := map[string]any{
		"agent_version":   a.version,
		"hostname":        h.Hostname,
		"os":              h.OS,
		"arch":            h.Arch,
		"cpu_cores":       h.CPUCores,
		"uptime_seconds":  h.UptimeSeconds,
		"logged_in_users": h.LoggedInUsers,
		"cpu_pct":         h.CPUPct,
		"ram_used_mb":     h.RAMUsedMB,
		"ram_pct":         h.RAMPct,
		"command_results": results,
	}
	if h.RAMTotalMB > 0 {
		body["ram_total_mb"] = h.RAMTotalMB
	}
	if h.OSVersion != "" {
		body["os_version"] = h.OSVersion
	}
	if h.CPUModel != "" {
		body["cpu_model"] = h.CPUModel
	}
	if h.PrimaryIP != "" {
		body["primary_ip"] = h.PrimaryIP
	}
	if h.PrimaryMAC != "" {
		body["primary_mac"] = h.PrimaryMAC
	}
	if h.DiskUsedPct > 0 {
		body["disk_used_pct"] = h.DiskUsedPct
	}
	if len(h.Disks) > 0 {
		body["disks"] = h.Disks
	}
	if len(h.Interfaces) > 0 {
		body["interfaces"] = h.Interfaces
	}
	if h.Manufacturer != "" {
		body["manufacturer"] = h.Manufacturer
	}
	if h.Model != "" {
		body["model"] = h.Model
	}
	if h.SerialNumber != "" {
		body["serial_number"] = h.SerialNumber
	}
	body["security"] = h.Security

	var resp struct {
		HeartbeatIntervalSeconds int               `json:"heartbeat_interval_seconds"`
		Commands                 []control.Command `json:"commands"`
	}
	if err := a.post(ctx, "/heartbeat", body, true, &resp); err != nil {
		if ctx.Err() != nil {
			return 0
		}
		*attempt++
		d := min(a.tuning.MaxBackoff, (2*time.Second)<<min(*attempt, 10))
		return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
	}
	*attempt = 0

	// Drop acknowledged results
	if len(results) > 0 {
		a.mu.Lock()
		sentIDs := map[string]bool{}
		for _, r := range results {
			sentIDs[r.ID] = true
		}
		remaining := a.results[:0]
		for _, r := range a.results {
			if !sentIDs[r.ID] {
				remaining = append(remaining, r)
			}
		}
		a.results = remaining
		a.mu.Unlock()
	}

	for _, cmd := range resp.Commands {
		a.mu.Lock()
		seen := a.seenCmds[cmd.ID]
		if !seen {
			if len(a.seenCmds) >= 2048 {
				clear(a.seenCmds)
			}
			a.seenCmds[cmd.ID] = true
		}
		a.mu.Unlock()
		if seen {
			continue
		}
		go a.runCommand(ctx, cmd)
	}

	return a.tuning.HeartbeatInterval
}

// commandPollLoop asks the server for commands. With LongPollWait set it long-polls: the server
// holds the request until a command is queued (or the wait ends), so a command starts within
// milliseconds without a request every 500 ms. Failures back off exponentially (with jitter) up to
// MaxPollBackoff. A server that answers an empty poll at once (one without long-poll support) is
// short-polled every CommandPollInterval instead of in a tight loop.
func (a *Agent) commandPollLoop(ctx context.Context) {
	interval := a.tuning.CommandPollInterval
	if interval <= 0 {
		interval = 600 * time.Millisecond
	}
	failures := 0
	var wait time.Duration
	for {
		if wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		if ctx.Err() != nil {
			return
		}
		commands, took, err := a.pollOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			failures++
			wait = pollBackoff(failures, a.tuning.MaxPollBackoff)
			a.log.Debug("command poll failed", "error", err.Error(), "retry_in", wait.String())
			continue
		}
		failures = 0
		wait = nextPollDelay(a.tuning.LongPollWait, interval, took, len(commands))
		a.dispatch(ctx, commands)
	}
}

// pollOnce makes one (long) poll and reports how long the server took to answer.
func (a *Agent) pollOnce(ctx context.Context) ([]control.Command, time.Duration, error) {
	var resp struct {
		Commands []control.Command `json:"commands"`
	}
	path := "/poll"
	client := a.httpClient
	if a.tuning.LongPollWait > 0 {
		path = fmt.Sprintf("/poll?wait_ms=%d", a.tuning.LongPollWait.Milliseconds())
		client = a.pollClient
	}
	started := time.Now()
	err := a.postWith(ctx, client, path, map[string]any{}, true, &resp)
	return resp.Commands, time.Since(started), err
}

// nextPollDelay: after commands, or after a long poll the server really held, poll again at once.
// An empty answer that came back quickly means the server does not hold polls: wait the interval.
func nextPollDelay(longPoll, interval, took time.Duration, n int) time.Duration {
	if n > 0 {
		return 0
	}
	if longPoll > 0 && took >= longPoll/2 {
		return 0
	}
	return interval
}

// pollBackoff: 1 s, 2 s, 4 s ... capped, with ±50 % jitter so many agents do not retry together.
func pollBackoff(failures int, maxBackoff time.Duration) time.Duration {
	if maxBackoff <= 0 {
		maxBackoff = 30 * time.Second
	}
	d := min(maxBackoff, time.Second<<min(failures-1, 10))
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

func (a *Agent) dispatch(ctx context.Context, commands []control.Command) {
	for _, cmd := range commands {
		a.mu.Lock()
		seen := a.seenCmds[cmd.ID]
		if !seen {
			if len(a.seenCmds) >= 2048 {
				clear(a.seenCmds)
			}
			a.seenCmds[cmd.ID] = true
		}
		a.mu.Unlock()
		if seen {
			continue
		}
		go a.runCommand(ctx, cmd)
	}
}

func (a *Agent) runCommand(ctx context.Context, cmd control.Command) {
	if a.cmdSem != nil {
		select {
		case a.cmdSem <- struct{}{}:
			defer func() { <-a.cmdSem }()
		case <-ctx.Done():
			return
		}
	}
	a.log.Info("executing remote IT command", "id", cmd.ID, "kind", cmd.Kind)
	res, handled := a.sessionCommand(ctx, cmd)
	if !handled {
		res = a.deps.ExecuteCommand(ctx, cmd)
	}

	// Deliver result immediately over /command-result if supported; fall back to heartbeat queue.
	var ack struct {
		OK bool `json:"ok"`
	}
	if err := a.post(ctx, "/command-result", map[string]any{"command_results": []control.Result{res}}, true, &ack); err != nil || !ack.OK {
		a.mu.Lock()
		a.results = append(a.results, res)
		a.mu.Unlock()
		select {
		case a.wakeHeartbeat <- struct{}{}:
		default:
		}
	}

	if cmd.Kind == "refresh_inventory" || cmd.Kind == "kill_process" || cmd.Kind == "service_action" || cmd.Kind == "software_action" {
		select {
		case a.wakeInventory <- struct{}{}:
		default:
		}
	}
}

func (a *Agent) inventoryLoop(ctx context.Context) {
	for {
		inv := a.deps.CollectInventory(ctx)
		if ctx.Err() != nil {
			return
		}
		if err := a.post(ctx, "/inventory", inv, true, nil); err != nil {
			a.log.Debug("inventory upload failed", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-a.wakeInventory:
		case <-time.After(a.tuning.InventoryInterval):
		}
	}
}

func (a *Agent) post(ctx context.Context, path string, payload any, authed bool, out any) error {
	return a.postWith(ctx, a.httpClient, path, payload, authed, out)
}

func (a *Agent) postWith(ctx context.Context, client *http.Client, path string, payload any, authed bool, out any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/api/v1/agent"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "nigafiy-agent/"+a.version)
	if authed {
		a.mu.Lock()
		cred := a.credential
		a.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+cred)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		if out != nil && len(data) > 0 {
			return json.Unmarshal(data, out)
		}
		return nil
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: HTTP %d", ErrRejected, resp.StatusCode)
	default:
		return fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
}

// VerifyPinnedChain accepts the server when the pin is either
//   - the SHA-256 of the leaf (server) certificate, or
//   - the SHA-256 of a CA certificate in the presented chain, and the leaf verifies up to that CA
//     (signature, validity, serverAuth usage) with the pinned certificate as the only root.
//
// The second form is what built-in LAN TLS uses: the server pins its local CA, so the server
// certificate can be re-issued without re-enrolling. The host name is not checked against the
// certificate in either form; the pin alone identifies the server.
func VerifyPinnedChain(chain []*x509.Certificate, want []byte, now time.Time) error {
	if len(chain) == 0 {
		return errors.New("tls pin verification failed: server presented no certificate")
	}
	leafSum := sha256.Sum256(chain[0].Raw)
	if subtle.ConstantTimeCompare(leafSum[:], want) == 1 {
		return nil
	}
	for i, c := range chain {
		if i == 0 || !c.IsCA {
			continue
		}
		sum := sha256.Sum256(c.Raw)
		if subtle.ConstantTimeCompare(sum[:], want) != 1 {
			continue
		}
		roots := x509.NewCertPool()
		roots.AddCert(c)
		inter := x509.NewCertPool()
		for j, o := range chain {
			if j != 0 && j != i {
				inter.AddCert(o)
			}
		}
		_, err := chain[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		if err != nil {
			return fmt.Errorf("tls pin verification failed: server certificate does not verify against the pinned CA: %w", err)
		}
		return nil
	}
	return fmt.Errorf("tls pin mismatch: server leaf certificate sha256 %x does not match configured pin", leafSum[:])
}
