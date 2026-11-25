//go:build !windows

package filemgr

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func realPath(p string) (string, error) { return filepath.EvalSymlinks(p) }

// openedPath returns the real location of an open file (EXT-8). Linux reads it from the handle
// (/proc/self/fd); elsewhere the name is resolved again and must still be the very file that is
// open (same device and inode), or the open is refused as changed underneath.
func openedPath(f *os.File) (string, error) {
	if runtime.GOOS == "linux" {
		if p, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd())); err == nil && filepath.IsAbs(p) {
			return p, nil
		}
	}
	real, err := filepath.EvalSymlinks(f.Name())
	if err != nil {
		return "", err
	}
	open, err := f.Stat()
	if err != nil {
		return "", err
	}
	named, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !os.SameFile(open, named) {
		return "", errors.New("the file changed while it was being opened")
	}
	return real, nil
}
