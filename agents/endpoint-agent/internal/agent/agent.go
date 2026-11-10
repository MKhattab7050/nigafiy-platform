// Package agent coordinates enrollment, periodic health heartbeats, full inventory collection,
// and remote administration command execution for a managed endpoint.
package agent

import (
	"bytes"
	"context"
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
	HeartbeatInterval time.Duration
	InventoryInterval time.Duration
	MaxBackoff        time.Duration
}

func DefaultTuning() Tuning {
	return Tuning{
		HeartbeatInterval: 20 * time.Second,
		InventoryInterval: 2 * time.Minute,
		MaxBackoff:        2 * time.Minute,
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
	for _, fn := range []func(context.Context){a.heartbeatLoop, a.inventoryLoop} {
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
			a.credential = c.Credential
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
		"ram_total_mb":     h.RAMTotalMB,
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
	a.credential = resp.Credential
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
		"agent_version":    a.version,
		"hostname":         h.Hostname,
		"os":               h.OS,
		"arch":             h.Arch,
		"cpu_cores":        h.CPUCores,
		"ram_total_mb":     h.RAMTotalMB,
		"uptime_seconds":   h.UptimeSeconds,
		"logged_in_users":  h.LoggedInUsers,
		"cpu_pct":          h.CPUPct,
		"ram_used_mb":      h.RAMUsedMB,
		"ram_pct":          h.RAMPct,
		"command_results":  results,
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
		a.seenCmds[cmd.ID] = true
		a.mu.Unlock()
		if seen {
			continue
		}
		go a.runCommand(ctx, cmd)
	}

	return a.tuning.HeartbeatInterval
}

func (a *Agent) runCommand(ctx context.Context, cmd control.Command) {
	a.log.Info("executing remote IT command", "id", cmd.ID, "kind", cmd.Kind)
	res := a.deps.ExecuteCommand(ctx, cmd)
	a.mu.Lock()
	a.results = append(a.results, res)
	a.mu.Unlock()

	if cmd.Kind == "refresh_inventory" || cmd.Kind == "kill_process" || cmd.Kind == "service_action" {
		select {
		case a.wakeInventory <- struct{}{}:
		default:
		}
	}
	select {
	case a.wakeHeartbeat <- struct{}{}:
	default:
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
		req.Header.Set("Authorization", "Bearer "+a.credential)
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

