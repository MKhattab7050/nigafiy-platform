//go:build !windows

package remotedesktop

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
)

func EnumerateDisplays() ([]DisplayInfo, error) {
	return []DisplayInfo{
		{
			Index:   0,
			Name:    "Primary Display (1)",
			X:       0,
			Y:       0,
			Width:   1920,
			Height:  1080,
			Primary: true,
		},
	}, nil
}

func captureDisplayRGBA(disp DisplayInfo) (*image.RGBA, string, error) {
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ld_screen_%d.png", os.Getpid()))
	defer os.Remove(tmpFile)

	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("/usr/sbin/screencapture", "-x", "-t", "png", tmpFile)
	} else {
		// Linux X11 / Wayland screenshot utilities
		if _, err := exec.LookPath("scrot"); err == nil {
			cmd = exec.Command("scrot", "-o", tmpFile)
		} else if _, err := exec.LookPath("gnome-screenshot"); err == nil {
			cmd = exec.Command("gnome-screenshot", "-f", tmpFile)
		} else if _, err := exec.LookPath("import"); err == nil {
			cmd = exec.Command("import", "-window", "root", tmpFile)
		} else {
			return nil, "", errors.New("no screenshot tool found (install scrot, gnome-screenshot or ImageMagick)")
		}
	}

	if err := cmd.Run(); err != nil {
		return nil, "", fmt.Errorf("%w: %v", errNoDesktop, err)
	}

	raw, err := os.ReadFile(tmpFile)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", errNoDesktop, err)
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", fmt.Errorf("screenshot could not be decoded: %v", err)
	}
	b := src.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			rgba.Set(x, y, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return rgba, "native", nil
}

func InjectInput(ev InputEvent) error {
	if runtime.GOOS == "linux" {
		if _, err := exec.LookPath("xdotool"); err != nil {
			return errors.New("xdotool is required for remote input injection on Linux X11")
		}
		x := strconv.Itoa(int(ev.NormalizedX * 1920))
		y := strconv.Itoa(int(ev.NormalizedY * 1080))
		switch ev.Kind {
		case "mouse_move":
			return exec.Command("xdotool", "mousemove", x, y).Run()
		case "mouse_click":
			btn := "1"
			if ev.Button == "right" {
				btn = "3"
			} else if ev.Button == "middle" {
				btn = "2"
			}
			return exec.Command("xdotool", "mousemove", x, y, "click", btn).Run()
		case "text":
			return exec.Command("xdotool", "type", "--", ev.Text).Run()
		case "key_press":
			return exec.Command("xdotool", "key", ev.Key).Run()
		}
	}
	return errors.New("remote input injection requires platform accessibility permissions")
}
