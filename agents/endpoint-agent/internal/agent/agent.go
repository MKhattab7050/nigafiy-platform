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

	"github.com/lan-detective/endpoint-agent/internal/config"
	"github.com/lan-detective/endpoint-agent/internal/control"
	"github.com/lan-detective/endpoint-agent/internal/sysinfo"
)

var (
	ErrUnauthorized = errors.New("rejected by server: credential or token is invalid")
	ErrRejected     = errors.New("rejected by server: payload not accepted")
)

type Deps struct {
	CollectHealth    func(ctx context.Context, started time.Time) sysinfo.Health
	CollectInventory func(ctx context.Context) sysinfo.Inventory
	ExecuteCommand   func(ctx context.Context, cmd control.Command) control.Result
}

func SystemDeps() Deps {
	runner := control.DefaultRunner()
	return Deps{
		CollectHealth:    sysinfo.CollectHealth,
		CollectInventory: sysinfo.CollectInventory,
		ExecuteCommand:   runner.Execute,
	}
}

type Tuning struct {
	HeartbeatInterval   time.Duration
	InventoryInterval   time.Duration
	CommandPollInterval time.Duration
	MaxBackoff          time.Duration
}

func DefaultTuning() Tuning {
	return Tuning{
		HeartbeatInterval:   20 * time.Second,
		InventoryInterval:   2 * time.Minute,
		CommandPollInterval: 500 * time.Millisecond,
		MaxBackoff:          2 * time.Minute,
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

	mu         sync.Mutex
	credential string
	results    []control.Result
	seenCmds   map[string]bool

	wakeHeartbeat chan struct{}
	wakeInventory chan struct{}
	cmdSem        chan struct{}
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
		tlsCfg.InsecureSkipVerify = true // replaced by explicit leaf SHA-256 pin verification below
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("tls pin verification failed: server presented no certificate")
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
			if subtle.ConstantTimeCompare(sum[:], want) != 1 {
				return fmt.Errorf("tls pin mismatch: server leaf certificate sha256 %x does not match configured pin", sum[:])
			}
			return nil
		}
	}
	return &Agent{
		cfg:     cfg,
		deps:    deps,
		log:     log,
		version: version,
		started: time.Now(),
		tuning:  tuning,
		baseURL: strings.TrimRight(cfg.ServerURL, "/"),
		httpClient: &http.Client{
			Timeout:   20 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConns: 4, IdleConnTimeout: 90 * time.Second, Proxy: http.ProxyFromEnvironment},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		seenCmds:      map[string]bool{},
		wakeHeartbeat: make(chan struct{}, 1),
		wakeInventory: make(chan struct{}, 1),
		cmdSem:        make(chan struct{}, 16),
	}, nil
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
	return nil
}

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
		return errors.New("this endpoint is not enrolled: provide an enrollment token (LAN_ENDPOINT_ENROLLMENT_TOKEN or -token)")
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

func (a *Agent) commandPollLoop(ctx context.Context) {
	interval := a.tuning.CommandPollInterval
	if interval <= 0 {
		interval = 600 * time.Millisecond
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		var resp struct {
			Commands []control.Command `json:"commands"`
		}
		if err := a.post(ctx, "/poll", map[string]any{}, true, &resp); err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
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
	res := a.deps.ExecuteCommand(ctx, cmd)

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
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/api/v1/agent"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "lan-endpoint-agent/"+a.version)
	if authed {
		a.mu.Lock()
		cred := a.credential
		a.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+cred)
	}
	resp, err := a.httpClient.Do(req)
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

