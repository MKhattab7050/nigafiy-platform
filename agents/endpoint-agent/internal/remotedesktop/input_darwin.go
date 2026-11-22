//go:build darwin

package remotedesktop

import (
	"context"
	"fmt"
	"image"
	"os/exec"
	"strings"
	"time"
)

// platformInput injects one event through CoreGraphics (see macinput.go). Needs Accessibility.
func platformInput(ev InputEvent) (bool, error) {
	arg, err := MacInputArg(ev)
	if err != nil {
		return true, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", MacInputScript, arg).CombinedOutput()
	if err != nil {
		return true, fmt.Errorf("macOS input (CoreGraphics via osascript): %v: %s", err, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// platformCapture: macOS keeps screencapture (rd_other.go).
func platformCapture() (*image.RGBA, string, bool, error) { return nil, "", false, nil }
