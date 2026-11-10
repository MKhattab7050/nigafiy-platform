//go:build windows

package filemgr

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func isHiddenOrSystem(fullPath string, info os.FileInfo) (hidden bool, system bool) {
	name := info.Name()
	if strings.HasPrefix(name, ".") {
		hidden = true
	}
	if sys, ok := info.Sys().(*syscall.Win32FileAttributeData); ok && sys != nil {
		if sys.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
			hidden = true
		}
		if sys.FileAttributes&syscall.FILE_ATTRIBUTE_SYSTEM != 0 {
			system = true
		}
	}
	return hidden, system
}

func platformRoots() []RootEntry {
	var roots []RootEntry
	for c := 'A'; c <= 'Z'; c++ {
		drive := string(c) + `:\`
		if fi, err := os.Stat(drive); err == nil && fi.IsDir() {
			roots = append(roots, RootEntry{
				Name:  string(c) + ":",
				Path:  drive,
				Label: "Local Disk (" + string(c) + ":)",
			})
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, RootEntry{
			Name:  "Home",
			Path:  filepath.Clean(home),
			Label: "User Home Directory",
		})
	}
	return roots
}

