//go:build !windows

package clipboard

import (
	"bytes"
	"context"
	"errors"
	"image"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Linux: pictures and file lists through xclip (X11) or wl-clipboard (Wayland), the same tools the
// text clipboard uses, with the image/png and text/uri-list targets. macOS: not supported
// (ErrRichUnsupported).

// RichCommand returns the tool and arguments that read (write=false) or write a MIME type.
func RichCommand(goos string, wayland, write bool, mime string, lookPath func(string) (string, error)) (string, []string, error) {
	if goos != "linux" {
		return "", nil, ErrRichUnsupported
	}
	if wayland {
		tool := "wl-paste"
		args := []string{"--no-newline", "--type", mime}
		if write {
			tool, args = "wl-copy", []string{"--type", mime}
		}
		if _, err := lookPath(tool); err == nil {
			return tool, args, nil
		}
	}
	if _, err := lookPath("xclip"); err == nil {
		args := []string{"-selection", "clipboard", "-t", mime, "-o"}
		if write {
			args[len(args)-1] = "-i"
		}
		return "xclip", args, nil
	}
	return "", nil, errors.New("pictures and copied files need xclip (X11) or wl-clipboard (Wayland) on this computer")
}

func runRich(write bool, mime string, in []byte) ([]byte, error) {
	name, args, err := RichCommand(runtime.GOOS, os.Getenv("WAYLAND_DISPLAY") != "", write, mime, exec.LookPath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if write {
		cmd.Stdin = bytes.NewReader(in)
		return nil, cmd.Run()
	}
	return cmd.Output()
}

func readImagePNG() ([]byte, error) {
	b, err := runRich(false, "image/png", nil)
	if err != nil || len(b) == 0 {
		if errors.Is(err, ErrRichUnsupported) {
			return nil, err
		}
		return nil, ErrNoImage
	}
	return b, nil
}

func writeImagePNG(_ image.Image, data []byte) error {
	_, err := runRich(true, "image/png", data)
	return err
}

func readFiles() ([]string, error) {
	b, err := runRich(false, "text/uri-list", nil)
	if err != nil {
		if errors.Is(err, ErrRichUnsupported) {
			return nil, err
		}
		return nil, ErrNoFiles
	}
	out := ParseURIList(string(b))
	if len(out) == 0 {
		return nil, ErrNoFiles
	}
	return out, nil
}

func writeFiles(paths []string) error {
	var b strings.Builder
	for _, p := range paths {
		b.WriteString((&url.URL{Scheme: "file", Path: p}).String())
		b.WriteString("\r\n")
	}
	_, err := runRich(true, "text/uri-list", []byte(b.String()))
	return err
}
