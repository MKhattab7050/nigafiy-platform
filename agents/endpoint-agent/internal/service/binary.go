package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// BinaryName is the agent's file name inside the install folder.
func BinaryName() string {
	if runtime.GOOS == "windows" {
		return "nigafiy-agent.exe"
	}
	return "nigafiy-agent"
}

// PreviousName is the file the in-place upgrade keeps the replaced binary under (for a rollback,
// and for a manual one later). It sits next to the binary and is removed by the next upgrade and
// by the uninstaller.
func PreviousName(binary string) string {
	ext := filepath.Ext(binary)
	return strings.TrimSuffix(binary, ext) + ".previous" + ext
}

// SamePath reports whether a and b name the same file (case-insensitive on Windows and macOS,
// whose default file systems are), after making both absolute and clean.
func SamePath(a, b string) bool {
	aa, err1 := filepath.Abs(a)
	bb, err2 := filepath.Abs(b)
	if err1 != nil || err2 != nil {
		return false
	}
	aa, bb = filepath.Clean(aa), filepath.Clean(bb)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(aa, bb)
	}
	return aa == bb
}

// PlaceBinary copies src (the running agent) into dir as BinaryName and returns the copy's path.
// When src already is that file nothing is copied. created reports that the file did not exist
// before, so a failed install can remove exactly what it added. The copy is written next to the
// target and renamed into place, so a half-written binary is never left under the real name.
func PlaceBinary(src, dir string) (target string, created bool, err error) {
	dir, err = filepath.Abs(dir)
	if err != nil {
		return "", false, err
	}
	target = filepath.Join(dir, BinaryName())
	if SamePath(src, target) {
		return target, false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, fmt.Errorf("create the install folder %s: %w", dir, err)
	}
	_, statErr := os.Stat(target)
	created = errors.Is(statErr, os.ErrNotExist)
	if err := CopyFile(src, target); err != nil {
		return "", false, err
	}
	return target, created, nil
}

// CopyFile copies src to dst through a temporary file in dst's folder (executable on Unix).
func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return fmt.Errorf("copy to %s: %w", tmp, err)
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("move %s into place: %w", dst, err)
	}
	return nil
}

// RemovePlaced undoes PlaceBinary after a failed first install: the copy, and the folder when it
// is empty afterwards. Nothing else in the folder is touched.
func RemovePlaced(target string) {
	_ = os.Remove(target)
	_ = os.Remove(filepath.Dir(target)) // only succeeds when empty
}
