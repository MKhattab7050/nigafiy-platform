//go:build !windows && !linux && !darwin

package service

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"

	"github.com/nigafiy/agent/internal/desktop"
)

var errUnsupported = errors.New("installing the agent as a service is supported on Windows, Linux (systemd) and macOS (launchd)")

func DefaultName() string              { return "nigafiy-endpoint-agent" }
func DefaultStateDir() string          { return "./state-endpoint" }
func IsPrivileged() bool               { return false }
func InService() bool                  { return false }
func PrepareStateDir(dir string) error { return os.MkdirAll(dir, 0o700) }
func Install(_ Spec, _ bool) error     { return errUnsupported }
func Uninstall(_ string) error         { return errUnsupported }
func HelperLauncher(exe string, _ *slog.Logger) desktop.Launcher {
	return desktop.ExecLauncher{Path: exe, Args: HelperArgs()}
}

func Run(_ string, _ *slog.Logger, _ *desktop.Supervisor, _ desktop.Launcher, run func(ctx context.Context) error) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return run(ctx)
}
