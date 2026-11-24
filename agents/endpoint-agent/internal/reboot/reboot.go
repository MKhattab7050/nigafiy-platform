// Package reboot is "restart and reconnect" on the agent side: a normal restart, or a restart into
// Safe Mode with Networking (Windows) with the agent's service allowed to start there, and the
// clean-up that ALWAYS follows: the safe-boot flag is cleared as soon as the agent starts again,
// when setting it or restarting fails, and whenever the server asks (fleet_safe_boot_clear).
//
// The agent never leaves a computer stuck in safe mode on purpose: a marker file in the state
// directory records that it set the flag, the next start clears it before doing anything else,
// and the heartbeat reports whether the marker is still there (boot_state.safe_boot_flag).
//
// Commands run through Runner so tests use a fake: nothing in the tests runs bcdedit, reg or a
// restart.
package reboot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Runner runs one program and returns its combined output.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

type Manager struct {
	StateDir    string
	ServiceName string
	GOOS        string
	// InService: the agent is the LocalSystem service (needed to start in safe mode).
	InService bool
	Run       Runner
	// Restart restarts the computer (the agent's power_action path); message is shown to the user.
	Restart func(ctx context.Context, message string) error
}

const markerName = "safeboot.json"

var (
	ErrNotWindows   = errors.New("Safe Mode with Networking is available on Windows only")
	ErrNeedsService = errors.New("safe_mode_needs_service: Safe Mode with Networking needs the Nigafiy agent installed as a service, so it can start in safe mode")
)

func (m *Manager) marker() string { return filepath.Join(m.StateDir, markerName) }

// SafeBootPending: the agent set the safe-boot flag and has not confirmed clearing it.
func (m *Manager) SafeBootPending() bool {
	_, err := os.Stat(m.marker())
	return err == nil
}

func (m *Manager) safeBootKey() string {
	return `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\` + m.ServiceName
}

func (m *Manager) run(ctx context.Context, name string, args ...string) error {
	out, err := m.Run(ctx, name, args...)
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// SetSafeBoot registers the service for safe mode with networking and sets the boot flag. On any
// failure everything it did is undone.
func (m *Manager) SetSafeBoot(ctx context.Context) error {
	if m.GOOS != "windows" {
		return ErrNotWindows
	}
	if !m.InService {
		return ErrNeedsService
	}
	if err := os.MkdirAll(m.StateDir, 0o700); err != nil {
		return err
	}
	// The marker first: if the agent dies half-way, its next start still clears the flag.
	if err := os.WriteFile(m.marker(), []byte(fmt.Sprintf(`{"set_at":%q}`, time.Now().UTC().Format(time.RFC3339))), 0o600); err != nil {
		return err
	}
	if err := m.run(ctx, "reg", "add", m.safeBootKey(), "/ve", "/t", "REG_SZ", "/d", "Service", "/f"); err != nil {
		_ = m.Clear(ctx)
		return err
	}
	if err := m.run(ctx, "bcdedit", "/set", "{current}", "safeboot", "network"); err != nil {
		_ = m.Clear(ctx)
		return err
	}
	return nil
}

// Clear removes the safe-boot flag and the service's safe-mode registration. The marker goes only
// when the flag is really gone (bcdedit succeeded, or reported that the value is not set).
func (m *Manager) Clear(ctx context.Context) error {
	if m.GOOS != "windows" {
		_ = os.Remove(m.marker())
		return nil
	}
	out, err := m.Run(ctx, "bcdedit", "/deletevalue", "{current}", "safeboot")
	if err != nil && !notSet(string(out)) {
		return fmt.Errorf("bcdedit /deletevalue {current} safeboot: %w: %s", err, strings.TrimSpace(string(out)))
	}
	_, _ = m.Run(ctx, "reg", "delete", m.safeBootKey(), "/f")
	if err := os.Remove(m.marker()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// notSet: bcdedit's answer when the element is not there (English and the error code it prints).
func notSet(out string) bool {
	o := strings.ToLower(out)
	return strings.Contains(o, "element not found") || strings.Contains(o, "0xc0000225")
}

// ClearAtStart runs before anything else when the agent starts: a flag it set before the restart
// is cleared now, so the NEXT boot is normal whatever happens to this session.
func (m *Manager) ClearAtStart(ctx context.Context) (cleared bool, err error) {
	if !m.SafeBootPending() {
		return false, nil
	}
	if err := m.Clear(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// RestartForReconnect: safe mode first (when asked), then the restart with a message for the
// person at the computer. If the restart cannot be started the flag is cleared again.
func (m *Manager) RestartForReconnect(ctx context.Context, mode, operator, reason string) (safeBootSet bool, err error) {
	switch mode {
	case "normal":
	case "safe_mode":
		if err := m.SetSafeBoot(ctx); err != nil {
			return false, err
		}
		safeBootSet = true
	default:
		return false, fmt.Errorf("unknown restart mode %q", mode)
	}
	msg := RestartMessage(mode, operator, reason)
	if err := m.Restart(ctx, msg); err != nil {
		if safeBootSet {
			if cerr := m.Clear(ctx); cerr != nil {
				return true, fmt.Errorf("%w (and clearing safe boot failed: %v)", err, cerr)
			}
		}
		return false, err
	}
	return safeBootSet, nil
}

// RestartMessage is what the person sees before the restart (never empty, says who and why).
func RestartMessage(mode, operator, reason string) string {
	if operator == "" {
		operator = "An IT operator"
	}
	where := "restarts this computer"
	if mode == "safe_mode" {
		where = "restarts this computer in Safe Mode with Networking"
	}
	msg := fmt.Sprintf("Nigafiy: %s %s. Reason: %s. The support session continues after the restart.", operator, where, reason)
	if len(msg) > 500 {
		msg = msg[:500]
	}
	return msg
}
