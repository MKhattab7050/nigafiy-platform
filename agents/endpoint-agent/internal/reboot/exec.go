package reboot

import (
	"context"
	"os/exec"
)

// ExecRunner runs the real program (the agent service; never used by tests).
func ExecRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
