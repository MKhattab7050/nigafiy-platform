//go:build !windows

package filemgr

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func isHiddenOrSystem(fullPath string, info os.FileInfo) (hidden bool, system bool) {
	name := info.Name()
	if strings.HasPrefix(name, ".") {
		hidden = true
	}
	clean := filepath.ToSlash(filepath.Clean(fullPath))
	if strings.HasPrefix(clean, "/proc") || strings.HasPrefix(clean, "/sys") || strings.HasPrefix(clean, "/dev") || strings.HasPrefix(clean, "/System") {
		system = true
	}
	return hidden, system
}

func platformRoots() []RootEntry {
	roots := []RootEntry{
		{Name: "/", Path: "/", Label: "Root Filesystem"},
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, RootEntry{
			Name:  "Home",
			Path:  filepath.Clean(home),
			Label: "User Home Directory",
		})
	}
	candidates := []struct {
		path  string
		label string
	}{
		{"/home", "Users (/home)"},
		{"/Users", "Users (/Users)"},
		{"/var/log", "System Logs (/var/log)"},
		{"/etc", "Configuration (/etc)"},
		{"/tmp", "Temporary Files (/tmp)"},
	}
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, struct {
			path  string
			label string
		}{"/Applications", "Applications"})
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c.path); err == nil && fi.IsDir() {
			roots = append(roots, RootEntry{
				Name:  filepath.Base(c.path),
				Path:  c.path,
				Label: c.label,
			})
		}
	}
	return roots
}

