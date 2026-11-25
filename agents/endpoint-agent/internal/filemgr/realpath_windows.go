//go:build windows

package filemgr

import (
	"os"
	"strings"
	"syscall"
	"unsafe"
)

var procGetFinalPathNameByHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

// realPath returns where p really is, following symlinks and directory junctions (Go's
// EvalSymlinks does not follow junctions on Windows).
func realPath(p string) (string, error) {
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	// FILE_FLAG_BACKUP_SEMANTICS opens directories too; no access rights are needed for the query.
	h, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(h)
	return finalPath(h)
}

// openedPath returns the real location of an open file, from its handle (EXT-8): what the
// handle reads or writes, whatever its path name points at by now.
func openedPath(f *os.File) (string, error) { return finalPath(syscall.Handle(f.Fd())) }

func finalPath(h syscall.Handle) (string, error) {
	buf := make([]uint16, 1024)
	for {
		n, _, callErr := procGetFinalPathNameByHandleW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0)
		if n == 0 {
			return "", callErr
		}
		if int(n) < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]uint16, n+1)
	}
	out := syscall.UTF16ToString(buf)
	switch {
	case strings.HasPrefix(out, `\\?\UNC\`):
		out = `\\` + out[len(`\\?\UNC\`):]
	case strings.HasPrefix(out, `\\?\`):
		out = out[len(`\\?\`):]
	}
	return out, nil
}
