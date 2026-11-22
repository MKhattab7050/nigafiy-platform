//go:build darwin

package remotedesktop

import (
	"context"
	"os/exec"
	"time"
)

// Backend: screencapture for frames, CoreGraphics events through osascript (JXA) for input.
func Backend() string { return "screencapture+jxa" }

// Permissions asks macOS whether the agent holds Screen Recording and Accessibility.
func Permissions() map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", MacPermissionScript).Output()
	return ParseMacPermissions(string(out), err)
}
