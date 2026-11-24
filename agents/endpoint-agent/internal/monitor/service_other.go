//go:build !windows

package monitor

import (
	"context"
	"os/exec"
	"runtime"
	"time"
)

func hideWindow(*exec.Cmd) {}

// serviceState: systemd on Linux (`systemctl is-active`), launchd on macOS (`launchctl list`).
// The name is a separate argument after "--", never parsed by a shell.
func serviceState(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		out, err := exec.CommandContext(ctx, "launchctl", "list", name).CombinedOutput()
		return LaunchctlState(string(out), err)
	}
	out, _ := exec.CommandContext(ctx, "systemctl", "is-active", "--", name).Output()
	return SystemctlState(string(out))
}
