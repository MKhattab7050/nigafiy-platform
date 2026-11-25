package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/configbackup"
)

// config_restore: an administrator-confirmed restore of one configuration version
// (configbackup.Restore: Junos commit confirmed or VyOS / EdgeOS commit-confirm, verified over a
// second SSH session).
//
//   - the command arrives with the SSH credentials and the configuration text, both used only in
//     memory for this one restore, never cached, logged or reported;
//   - at most once: the restore id is written to the on-disk ledger (the same one port changes use)
//     BEFORE the device is touched, so a redelivered command or a restart never applies it twice;
//   - an expired command is never started late;
//   - the configuration read back after the commit is reported as the verification backup
//     (config_backup_result for verify_run_id), followed by config_restore_result with the steps.

const cmdConfigRestore = "config_restore"

type configRestorePayload struct {
	configBackupPayload
	RestoreID      string `json:"restore_id"`
	VerifyRunID    string `json:"verify_run_id"`
	ConfigGzipB64  string `json:"config_gzip_b64"`
	ConfirmMinutes int    `json:"confirm_minutes"`
	// The device identity recorded with the version, and whether the administrator confirmed
	// restoring onto a device whose identity differs.
	ExpectedIdentity *configbackup.DeviceIdentity `json:"expected_identity"`
	AllowOtherDevice bool                         `json:"allow_other_device"`
}

// identityItem is the protocol form of a device identity (printable, bounded).
func identityItem(d *configbackup.DeviceIdentity) map[string]any {
	out := map[string]any{}
	if d.Model != "" {
		out["model"] = printable(d.Model, 100)
	}
	if d.Serial != "" {
		out["serial"] = printable(d.Serial, 100)
	}
	return out
}

// readBackCommand is the command the restore read the configuration back with (per method).
func readBackCommand(method string) string {
	switch method {
	case configbackup.RestoreMethodVyOS:
		return "show configuration commands | cat"
	case configbackup.RestoreMethodOpenWrt:
		return "uci export"
	}
	return "show configuration | no-more"
}

func gunzipBase64(s string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	defer zr.Close()
	out, err := io.ReadAll(io.LimitReader(zr, 4<<20))
	return string(out), err
}

func (a *Agent) configRestore(ctx context.Context, cmd cloud.Command) {
	defer a.markCompleted(cmd.ID)
	if a.deps.ConfigRestore == nil {
		return
	}
	var p configRestorePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !requestIDRe.MatchString(p.RestoreID) || !requestIDRe.MatchString(p.VerifyRunID) || !requestIDRe.MatchString(p.TargetID) {
		a.log.Warn("configuration restore ignored: malformed payload")
		return
	}
	now := time.Now()
	if p.ExpiresAt.IsZero() || now.After(p.ExpiresAt) {
		a.log.Info("configuration restore not started: the request expired", "address", p.Address)
		return
	}
	first, err := a.claimSwitchRequest("config-restore:"+p.RestoreID, now)
	if err != nil {
		a.log.Error("configuration restore not started: the request ledger cannot be written", "error", err.Error())
		return
	}
	if !first {
		a.log.Warn("configuration restore ignored: this request was already executed", "restore_id", p.RestoreID)
		return
	}
	text, err := gunzipBase64(p.ConfigGzipB64)
	result := map[string]any{"type": "config_restore_result", "ts": time.Now().UTC(), "restore_id": p.RestoreID, "target_id": p.TargetID}
	if err != nil || text == "" {
		result["ok"] = false
		result["error"] = map[string]any{"kind": configbackup.ErrInvalidArgument, "message": "the configuration to restore could not be decoded"}
		a.spoolSingle(result)
		return
	}
	select {
	case configBackupSlots <- struct{}{}:
		defer func() { <-configBackupSlots }()
	case <-ctx.Done():
		return
	}
	target := configbackup.Target{
		Address: p.Address, Port: p.Port, Username: p.Username, Password: p.Password, PrivateKey: p.PrivateKey,
		Passphrase: p.Passphrase, EnableSecret: p.EnableSecret, HostKeySHA256: p.HostKeySHA256, HostKeyType: p.HostKeyType,
		Driver: p.Driver,
	}
	started := time.Now()
	res, rerr := a.deps.ConfigRestore(ctx, target, configbackup.RestoreSpec{
		Config: text, ConfirmMinutes: p.ConfirmMinutes, ExpectedIdentity: p.ExpectedIdentity, AllowOtherDevice: p.AllowOtherDevice,
	}, a.configBackupOptions())
	text = ""
	if res == nil {
		res = &configbackup.RestoreResult{}
	}
	duration := time.Since(started).Milliseconds()

	// The configuration as read back after the commit: the verification backup.
	if res.Config != "" {
		item := map[string]any{"type": "config_backup_result", "ts": time.Now().UTC(), "run_id": p.VerifyRunID, "target_id": p.TargetID, "duration_ms": duration}
		if res.HostKey != nil {
			item["host_key"] = res.HostKey
			if res.HostKeyStatus != "" {
				item["host_key_status"] = res.HostKeyStatus
			}
		}
		if encoded, gzErr := gzipBase64(res.Config); gzErr == nil && len(encoded) <= maxConfigGzipB64 {
			item["ok"] = true
			item["config_gzip_b64"] = encoded
			item["commands"] = []string{readBackCommand(res.Method)}
			if res.Identity.Known() {
				item["device_identity"] = identityItem(res.Identity)
			}
		} else {
			item["ok"] = false
			item["error"] = map[string]any{"kind": configbackup.ErrOutputTooLarge, "message": "the configuration read back is too large to upload"}
		}
		a.spoolSingle(item)
	}

	result["duration_ms"] = duration
	result["method"] = res.Method
	result["loaded"] = res.Loaded
	result["committed"] = res.Committed
	result["confirmed"] = res.Confirmed
	result["rolled_back"] = res.RolledBack
	result["read_back"] = res.Config != ""
	steps := make([]string, 0, len(res.Steps))
	for _, s := range res.Steps {
		steps = append(steps, printable(s, 300))
	}
	result["steps"] = steps
	if res.HostKey != nil {
		result["host_key"] = res.HostKey
	}
	if res.Identity.Known() {
		result["device_identity"] = identityItem(res.Identity)
	}
	result["ok"] = rerr == nil
	if rerr != nil {
		msg := rerr.Error()
		var e *configbackup.Error
		if errors.As(rerr, &e) {
			msg = e.Message
		}
		result["error"] = map[string]any{"kind": configbackup.KindOf(rerr), "message": printable(msg, 500)}
	}
	// Address and outcome only: credentials and configuration text are never logged.
	a.log.Info("configuration restore finished", "address", p.Address, "ok", rerr == nil, "committed", res.Committed, "confirmed", res.Confirmed, "rolled_back", res.RolledBack)
	a.spoolSingle(result)
}
