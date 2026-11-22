package clipboard

import "errors"

// Clipboard tools on Linux (Wayland: wl-clipboard; X11: xclip or xsel) and macOS (pbcopy /
// pbpaste). The text always travels on stdin/stdout, never as an argument.

var errNoTool = errors.New("no clipboard tool found: install wl-clipboard (Wayland), xclip or xsel (X11)")

func ReadCommand(goos string, wayland bool, lookPath func(string) (string, error)) (string, []string, error) {
	if goos == "darwin" {
		return "/usr/bin/pbpaste", nil, nil
	}
	if wayland {
		if p, err := lookPath("wl-paste"); err == nil {
			return p, []string{"--no-newline", "--type", "text/plain"}, nil
		}
	}
	if p, err := lookPath("xclip"); err == nil {
		return p, []string{"-selection", "clipboard", "-o"}, nil
	}
	if p, err := lookPath("xsel"); err == nil {
		return p, []string{"--clipboard", "--output"}, nil
	}
	return "", nil, errNoTool
}

func WriteCommand(goos string, wayland bool, lookPath func(string) (string, error)) (string, []string, error) {
	if goos == "darwin" {
		return "/usr/bin/pbcopy", nil, nil
	}
	if wayland {
		if p, err := lookPath("wl-copy"); err == nil {
			return p, []string{"--type", "text/plain"}, nil
		}
	}
	if p, err := lookPath("xclip"); err == nil {
		return p, []string{"-selection", "clipboard", "-i"}, nil
	}
	if p, err := lookPath("xsel"); err == nil {
		return p, []string{"--clipboard", "--input"}, nil
	}
	return "", nil, errNoTool
}
