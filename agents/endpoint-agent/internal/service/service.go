// Package service runs the endpoint agent as an operating-system service (a Windows service, a
// systemd unit, a launchd daemon) and starts the session helper (the same binary, run as
// `endpoint-agent session-helper`) inside the signed-in user's desktop session, where the screen,
// the consent dialog, the session banner and the clipboard live.
//
// The service never hides: the consent dialog and the always-on session banner are shown by the
// helper in the user's own session, exactly as when the agent runs on the desktop itself.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"time"

	"github.com/lan-detective/endpoint-agent/internal/config"
	"github.com/lan-detective/endpoint-agent/internal/desktop"
)

const (
	// DisplayName is what the service list shows.
	DisplayName = "Nigafiy Endpoint Agent"
	// Description is the service's description (Windows service list, systemd unit).
	Description = "Nigafiy managed-endpoint agent: reports inventory and health to your organization's Nigafiy server and runs authorized IT administration actions. Remote support sessions ask the signed-in user for consent where the policy says so and always show a visible session banner."
)

var validName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// ValidName checks a service name (letters, digits, '_', '.', '-'; at most 64).
func ValidName(name string) error {
	if !validName.MatchString(name) {
		return fmt.Errorf("service name %q is not valid: use letters, digits, '_', '.' or '-' (at most 64)", name)
	}
	return nil
}

// Spec is one service to install.
type Spec struct {
	Name string
	// Exe is the absolute path of the agent binary.
	Exe string
	// Args follow the binary on the service's command line (see RunArgs).
	Args []string
	// StateDir holds the credential and the service log.
	StateDir string
}

// RunArgs is the service's command line after the binary: `run` with the configuration. The
// enrollment token is never part of it (it is single-use and spent at install time), so it never
// lands in the service registry, the unit file or the plist.
func RunArgs(cfg config.Config, name string) ([]string, error) {
	state, err := filepath.Abs(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	args := []string{"run", "-service-name", name, "-server", cfg.ServerURL, "-state-dir", state, "-log-level", cfg.LogLevel}
	if cfg.CAFile != "" {
		ca, err := filepath.Abs(cfg.CAFile)
		if err != nil {
			return nil, err
		}
		args = append(args, "-ca-file", ca)
	}
	if cfg.TLSPinSHA256 != "" {
		args = append(args, "-tls-pin", cfg.TLSPinSHA256)
	}
	if cfg.AllowInsecureHTTP {
		args = append(args, "-allow-insecure-http")
	}
	return args, nil
}

// HelperArgs is the session helper's command line after the binary.
func HelperArgs() []string { return []string{"session-helper"} }

// SessionTracker is implemented by launchers that start the helper in a particular desktop
// session: Stale reports that the active session is no longer the helper's (fast user switching,
// a sign-in after the helper started at the sign-in screen, a remote session taking the console).
type SessionTracker interface {
	Stale() bool
}

// Watch restarts the supervisor's helper whenever the launcher says the active session changed.
// Windows also delivers session-change events to the service (handled at once); this poll is the
// backstop there and the only signal on Linux and macOS.
func Watch(ctx context.Context, sup *desktop.Supervisor, l desktop.Launcher, every time.Duration, log *slog.Logger) {
	t, ok := l.(SessionTracker)
	if !ok || sup == nil {
		return
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if t.Stale() {
				if log != nil {
					log.Info("the active desktop session changed; restarting the session helper", "where", l.Describe())
				}
				sup.Restart()
			}
		}
	}
}

// ErrNotPrivileged: installing a service needs an administrator (Windows) or root (Linux, macOS).
var ErrNotPrivileged = errors.New("installing or removing the service needs administrator rights (an elevated prompt on Windows, root on Linux and macOS)")
