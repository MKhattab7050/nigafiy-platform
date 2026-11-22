//go:build !windows

package clipboard

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func readText() (string, error) {
	name, args, err := ReadCommand(runtime.GOOS, os.Getenv("WAYLAND_DISPLAY") != "", exec.LookPath)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func writeText(text string) error {
	name, args, err := WriteCommand(runtime.GOOS, os.Getenv("WAYLAND_DISPLAY") != "", exec.LookPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}
