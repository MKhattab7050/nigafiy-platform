//go:build !windows

package remotedesktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// EnumerateDisplays reports the one screen these tools capture. Its size is only filled in when it
// can be measured (xdotool on X11); otherwise it is 0x0 and the captured frame carries the size.
func EnumerateDisplays() ([]DisplayInfo, error) {
	w, h, _ := screenGeometry()
	return []DisplayInfo{{Index: 0, Name: "Primary display", Width: w, Height: h, Primary: true}}, nil
}

// screenGeometry asks the X server for the screen size; there is no guessed default.
func screenGeometry() (int, int, error) {
	if runtime.GOOS != "linux" {
		return 0, 0, errors.New("screen size is not available on this platform")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "xdotool", "getdisplaygeometry").Output()
	if err != nil {
		return 0, 0, fmt.Errorf("xdotool getdisplaygeometry: %v", err)
	}
	f := strings.Fields(string(out))
	if len(f) != 2 {
		return 0, 0, errors.New("unexpected xdotool getdisplaygeometry output")
	}
	w, err1 := strconv.Atoi(f[0])
	h, err2 := strconv.Atoi(f[1])
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return 0, 0, errors.New("unexpected xdotool getdisplaygeometry output")
	}
	return w, h, nil
}

func captureDisplayRGBA(disp DisplayInfo) (*image.RGBA, string, error) {
	f, err := os.CreateTemp("", "ld_screen_*.png")
	if err != nil {
		return nil, "", fmt.Errorf("create temp file: %w", err)
	}
	tmpFile := f.Name()
	_ = f.Close()
	defer os.Remove(tmpFile)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.CommandContext(ctx, "/usr/sbin/screencapture", "-x", "-t", "png", tmpFile)
	} else {
		// Linux X11 / Wayland screenshot utilities
		if _, err := exec.LookPath("scrot"); err == nil {
			cmd = exec.CommandContext(ctx, "scrot", "-o", tmpFile)
		} else if _, err := exec.LookPath("gnome-screenshot"); err == nil {
			cmd = exec.CommandContext(ctx, "gnome-screenshot", "-f", tmpFile)
		} else if _, err := exec.LookPath("import"); err == nil {
			cmd = exec.CommandContext(ctx, "import", "-window", "root", tmpFile)
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
	srcBounds := src.Bounds()
	bounds := image.Rect(0, 0, srcBounds.Dx(), srcBounds.Dy())
	rgba := image.NewRGBA(bounds)
	draw.Draw(rgba, bounds, src, srcBounds.Min, draw.Src)
	return rgba, "native", nil
}

func InjectInput(ev InputEvent) error {
	if runtime.GOOS == "linux" {
		if _, err := exec.LookPath("xdotool"); err != nil {
			return errors.New("xdotool is required for remote input injection on Linux X11")
		}
		sw, sh, err := screenGeometry()
		if err != nil {
			return fmt.Errorf("cannot place the pointer: %v", err)
		}
		x := strconv.Itoa(int(ev.NormalizedX * float64(sw-1)))
		y := strconv.Itoa(int(ev.NormalizedY * float64(sh-1)))
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
			if ev.Key == "" || strings.HasPrefix(ev.Key, "-") {
				return errors.New("invalid key name")
			}
			return exec.Command("xdotool", "key", "--", ev.Key).Run()
		}
	}
	return errors.New("remote input injection requires platform accessibility permissions")
}
