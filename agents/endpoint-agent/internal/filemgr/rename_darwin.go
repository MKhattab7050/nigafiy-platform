//go:build darwin

package filemgr

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames relative to both folder handles with renameatx_np(RENAME_EXCL): an
// existing destination is never replaced.
func renameNoReplace(src *dirHandle, srcName string, dst *dirHandle, dstName string) error {
	if err := validName(srcName); err != nil {
		return err
	}
	if err := validName(dstName); err != nil {
		return err
	}
	err := unix.RenameatxNp(src.fd, srcName, dst.fd, dstName, unix.RENAME_EXCL)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EINVAL) {
		return renameNoReplaceFallback(src, srcName, dst, dstName)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: filepath.Join(src.path, srcName), New: filepath.Join(dst.path, dstName), Err: err}
	}
	return nil
}
