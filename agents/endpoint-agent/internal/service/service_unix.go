//go:build linux || darwin

package service

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
)

// IsPrivileged: running as root.
func IsPrivileged() bool { return os.Geteuid() == 0 }

// InService is false on Linux and macOS: systemd and launchd run the agent as a plain process.
func InService() bool { return false }

// PrepareStateDir creates the state directory readable by its owner (root) only.
func PrepareStateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// Run runs the agent in the foreground until SIGINT/SIGTERM (systemd and launchd stop it with
// SIGTERM), restarting the session helper when the active session changes.
func Run(_ string, log *slog.Logger, sup *desktop.Supervisor, l desktop.Launcher, run func(ctx context.Context) error) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go Watch(ctx, sup, l, 10*time.Second, log)
	return run(ctx)
}

func runTool(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// parseKV reads `key=value` lines (loginctl show-*, and the like).
func parseKV(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			m[k] = v
		}
	}
	return m
}
