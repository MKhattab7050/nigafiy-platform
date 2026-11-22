package control

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// packageCommand builds the package-manager command line for a validated package id. Every
// manager gets the id after "--" (on top of packageIDPattern, which already refuses a leading "-").
// On Linux the manager is detected: apt-get, then dnf, zypper and yum.
func (r Runner) packageCommand(action, pkg string) (string, []string, error) {
	if !packageIDPattern.MatchString(pkg) {
		return "", nil, errors.New("Invalid package identifier")
	}
	if action != "install" && action != "upgrade" && action != "uninstall" {
		return "", nil, errors.New("Unsupported software action")
	}
	switch r.goos() {
	case "windows":
		if action == "uninstall" {
			return "winget", []string{"uninstall", "--id", pkg, "--silent"}, nil
		}
		return "winget", []string{action, "--id", pkg, "--silent", "--accept-package-agreements", "--accept-source-agreements"}, nil
	case "darwin":
		return "brew", []string{action, "--", pkg}, nil
	}
	switch {
	case r.has("apt-get"):
		switch action {
		case "install":
			return "apt-get", []string{"install", "-y", "--", pkg}, nil
		case "upgrade":
			// --only-upgrade: an "upgrade" never installs a package that is not there yet.
			return "apt-get", []string{"install", "--only-upgrade", "-y", "--", pkg}, nil
		default:
			return "apt-get", []string{"remove", "-y", "--", pkg}, nil
		}
	case r.has("dnf"):
		verb := map[string]string{"install": "install", "upgrade": "upgrade", "uninstall": "remove"}[action]
		return "dnf", []string{verb, "-y", "--", pkg}, nil
	case r.has("zypper"):
		verb := map[string]string{"install": "install", "upgrade": "update", "uninstall": "remove"}[action]
		return "zypper", []string{"--non-interactive", verb, "--", pkg}, nil
	case r.has("yum"):
		verb := map[string]string{"install": "install", "upgrade": "update", "uninstall": "remove"}[action]
		return "yum", []string{verb, "-y", "--", pkg}, nil
	}
	return "", nil, errors.New("no supported package manager found (apt-get, dnf, zypper or yum)")
}

type tailKey struct{}

// withTailOutput asks DefaultRunner to keep the end of a long output instead of its start.
func withTailOutput(ctx context.Context) context.Context {
	return context.WithValue(ctx, tailKey{}, true)
}

func keepTail(ctx context.Context) bool {
	v, _ := ctx.Value(tailKey{}).(bool)
	return v
}

// TailLogLines keeps the last n log lines of `log show --style compact` output (dropping the
// "Timestamp …" header and a possibly cut first line), each shortened to maxRunes characters so the
// requested count fits in one command result.
func TailLogLines(out string, n, maxRunes int) string {
	if n <= 0 {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(out, "\r", ""), "\n")
	kept := make([]string, 0, n)
	for i := len(lines) - 1; i >= 0 && len(kept) < n; i-- {
		t := strings.TrimRight(lines[i], " \t")
		if strings.TrimSpace(t) == "" || strings.HasPrefix(t, "Timestamp ") {
			continue
		}
		if maxRunes > 0 && utf8.RuneCountInString(t) > maxRunes {
			r := []rune(t)
			t = string(r[:maxRunes-1]) + "…"
		}
		kept = append(kept, t)
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return strings.Join(kept, "\n")
}
