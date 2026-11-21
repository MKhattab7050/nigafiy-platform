package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/configbackup"
)

// Configuration backup: the `config_backup` and `config_backup_probe` commands (closed list, see
// agent.go).
//
//   - config_backup: read one device's running configuration over SSH with the configbackup package
//     (read-only command lists, host key pinned on first use, scope re-checked locally). The SSH
//     credentials arrive inside the command, are used for this one run and are never cached, logged or
//     reported. The configuration is reported gzip-compressed in its own telemetry batch, so a large
//     configuration never makes a batch too big for the server.
//   - config_backup_probe: for each address, does TCP port 22 answer with an SSH identification line?
//     No login is attempted. Feeds the server's "devices worth backing up" suggestions.

const (
	cmdConfigBackup      = "config_backup"
	cmdConfigBackupProbe = "config_backup_probe"
	// Backups at once: each holds one SSH session; devices are read one after another per slot.
	maxConcurrentBackups = 2
	probeWorkers         = 16
	maxProbeAddresses    = 1024
	// Base64 of the gzip stream the server accepts (protocol limit, config-backup-protocol.ts).
	maxConfigGzipB64 = 1_400_000
)

var (
	configBackupSlots = make(chan struct{}, maxConcurrentBackups)
	configProbeMu     sync.Mutex
)

type configBackupPayload struct {
	RunID         string `json:"run_id"`
	TargetID      string `json:"target_id"`
	Address       string `json:"address"`
	Port          int    `json:"port"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	PrivateKey    string `json:"private_key"`
	Passphrase    string `json:"passphrase"`
	EnableSecret  string `json:"enable_secret"`
	HostKeySHA256 string `json:"host_key_sha256"`
	HostKeyType   string `json:"host_key_type"`
	Driver        string `json:"driver"`
	Hints         struct {
		Driver    string `json:"driver"`
		OUIVendor string `json:"oui_vendor"`
		SysDescr  string `json:"sys_descr"`
	} `json:"hints"`
	ExpiresAt time.Time `json:"expires_at"`
}

// configBackupOptions: the same authorized scopes as discovery, SNMP and router control (routers.go).
func (a *Agent) configBackupOptions() configbackup.Options {
	return configbackup.Options{Authorized: a.authorizedPrefixes(), AllowLoopback: a.cfg.AllowLoopbackScopes}
}

// spoolSingle writes one telemetry item as its own batch straight to the on-disk buffer.
func (a *Agent) spoolSingle(item map[string]any) {
	itemRaw, err := json.Marshal(item)
	if err != nil {
		return
	}
	id := newUUID()
	raw, err := json.Marshal(map[string]any{"batch_id": id, "sent_at": time.Now().UTC(), "items": []json.RawMessage{itemRaw}})
	if err != nil {
		return
	}
	dropped, err := a.spool.Put(id, raw)
	if err != nil {
		a.log.Error("cannot write to the local buffer", "error", err.Error())
	}
	if dropped > 0 {
		a.log.Warn("local buffer is full; oldest unsent batches were dropped", "dropped", dropped)
	}
	a.wakeUploader()
}

func printable(s string, max int) string {
	var b strings.Builder
	for _, r := range s {
		if r == '\t' || (r >= 0x20 && r != 0x7f) {
			b.WriteRune(r)
		}
		if b.Len() >= max {
			break
		}
	}
	return b.String()
}

func gzipBase64(text string) (string, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(text)); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func (a *Agent) configBackup(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	if a.deps.ConfigBackup == nil {
		return
	}
	var p configBackupPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !requestIDRe.MatchString(p.RunID) || !requestIDRe.MatchString(p.TargetID) {
		a.log.Warn("configuration backup ignored: malformed payload")
		return
	}
	if !p.ExpiresAt.IsZero() && time.Now().After(p.ExpiresAt) {
		a.log.Info("configuration backup not started: the request expired", "address", p.Address)
		return
	}
	select {
	case configBackupSlots <- struct{}{}:
		defer func() { <-configBackupSlots }()
	case <-ctx.Done():
		return
	}
	if !p.ExpiresAt.IsZero() && time.Now().After(p.ExpiresAt) {
		return // waited behind other backups for too long; the server already gave up on it
	}
	target := configbackup.Target{
		Address: p.Address, Port: p.Port, Username: p.Username, Password: p.Password, PrivateKey: p.PrivateKey,
		Passphrase: p.Passphrase, EnableSecret: p.EnableSecret, HostKeySHA256: p.HostKeySHA256, HostKeyType: p.HostKeyType,
		Driver: p.Driver, Hints: configbackup.Hints{Driver: p.Hints.Driver, OUIVendor: p.Hints.OUIVendor, SysDescr: p.Hints.SysDescr},
	}
	started := time.Now()
	res, err := a.deps.ConfigBackup(ctx, target, a.configBackupOptions())
	if ctx.Err() != nil {
		return // shutting down: the run expires on the server instead of reporting a false failure
	}
	if res == nil {
		res = &configbackup.Result{}
	}
	item := map[string]any{
		"type": "config_backup_result", "ts": time.Now().UTC(), "run_id": p.RunID, "target_id": p.TargetID,
		"duration_ms": time.Since(started).Milliseconds(),
	}
	if res.HostKey != nil {
		item["host_key"] = res.HostKey
		if res.HostKeyStatus != "" {
			item["host_key_status"] = res.HostKeyStatus
		}
	}
	if res.ServerVersion != "" {
		item["server_version"] = printable(res.ServerVersion, 200)
	}
	if res.Detection != nil && res.Detection.Driver != "" {
		item["detection"] = res.Detection
	}
	if err == nil {
		encoded, gzErr := gzipBase64(res.Config)
		switch {
		case gzErr != nil:
			err = &configbackup.Error{Kind: "internal", Message: "could not compress the configuration"}
		case len(encoded) > maxConfigGzipB64:
			err = &configbackup.Error{Kind: configbackup.ErrOutputTooLarge, Message: "the configuration is too large to upload"}
		default:
			item["ok"] = true
			item["config_gzip_b64"] = encoded
			item["commands"] = res.Commands
		}
	}
	if err != nil {
		msg := err.Error()
		var e *configbackup.Error
		if errors.As(err, &e) {
			msg = e.Message
		}
		item["ok"] = false
		item["error"] = map[string]any{"kind": configbackup.KindOf(err), "message": printable(msg, 500)}
	}
	// Address only: credentials and configuration text are never logged.
	a.log.Info("configuration backup finished", "address", p.Address, "ok", err == nil, "error_kind", map[bool]string{true: "", false: configbackup.KindOf(err)}[err == nil])
	a.spoolSingle(item)
}

func (a *Agent) configBackupProbe(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	if a.deps.SSHProbe == nil {
		return
	}
	var p struct {
		RunID     string   `json:"run_id"`
		Port      int      `json:"port"`
		Addresses []string `json:"addresses"`
	}
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !requestIDRe.MatchString(p.RunID) {
		a.log.Warn("SSH reachability check ignored: malformed payload")
		return
	}
	if len(p.Addresses) > maxProbeAddresses {
		p.Addresses = p.Addresses[:maxProbeAddresses]
	}
	configProbeMu.Lock() // one check at a time: it is a background courtesy, not a scan race
	defer configProbeMu.Unlock()
	opts := a.configBackupOptions()
	results := make([]configbackup.ProbeResult, len(p.Addresses))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < probeWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				r := a.deps.SSHProbe(ctx, p.Addresses[i], p.Port, opts)
				r.ServerVersion = printable(r.ServerVersion, 200)
				r.Error = printable(r.Error, 200)
				results[i] = r
			}
		}()
	}
	for i := range p.Addresses {
		if ctx.Err() != nil {
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		return
	}
	// Addresses the local policy refused are left out: the server only records answers it can trust.
	out := make([]configbackup.ProbeResult, 0, len(results))
	open := 0
	for _, r := range results {
		if r.Address == "" || strings.Contains(r.Error, configbackup.ErrOutOfScope) || r.Error == "not an IPv4 address" {
			continue
		}
		if r.Open {
			open++
		}
		out = append(out, r)
	}
	a.log.Info("SSH reachability check finished", "addresses", len(out), "answering_ssh", open)
	a.enqueue(map[string]any{"type": "config_backup_probe_result", "ts": time.Now().UTC(), "run_id": p.RunID, "results": out})
	a.wakeUploader()
}
