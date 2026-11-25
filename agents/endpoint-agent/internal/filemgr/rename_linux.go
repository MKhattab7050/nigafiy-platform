//go:build linux

package filemgr

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames relative to both folder handles with renameat2(RENAME_NOREPLACE): an
// existing destination is never replaced.
func renameNoReplace(src *dirHandle, srcName string, dst *dirHandle, dstName string) error {
	if err := validName(srcName); err != nil {
		return err
	}
	if err := validName(dstName); err != nil {
		return err
	}
	err := unix.Renameat2(src.fd, srcName, dst.fd, dstName, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) {
		return renameNoReplaceFallback(src, srcName, dst, dstName)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: filepath.Join(src.path, srcName), New: filepath.Join(dst.path, dstName), Err: err}
	}
	return nil
}
