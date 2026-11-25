//go:build !windows

package filemgr

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// dirHandle is an open folder (never a symbolic link) whose location was checked.
type dirHandle struct {
	fd   int
	path string
}

const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC

// openDirNoFollow walks the resolved path real from "/" one component at a time with
// openat(O_NOFOLLOW|O_DIRECTORY): a symbolic link anywhere on the way (put there after real was
// resolved) makes the open fail instead of being followed.
func openDirNoFollow(real string) (*dirHandle, error) {
	clean := filepath.Clean(real)
	if !filepath.IsAbs(clean) {
		return nil, errors.New("path must be absolute")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: "/", Err: err}
	}
	for _, comp := range strings.Split(strings.Trim(clean, "/"), "/") {
		if comp == "" {
			continue
		}
		next, err := unix.Openat(fd, comp, dirFlags, 0)
		_ = unix.Close(fd)
		if err != nil {
			return nil, &fs.PathError{Op: "open", Path: clean, Err: err}
		}
		fd = next
	}
	return &dirHandle{fd: fd, path: clean}, nil
}

func (d *dirHandle) close() {
	if d != nil && d.fd >= 0 {
		_ = unix.Close(d.fd)
		d.fd = -1
	}
}

// finalPath: Linux reads it from the handle; elsewhere the no-follow walk that opened the folder
// guarantees it is the path walked.
func (d *dirHandle) finalPath() (string, error) {
	if runtime.GOOS == "linux" {
		if p, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", d.fd)); err == nil && filepath.IsAbs(p) {
			return p, nil
		}
	}
	return d.path, nil
}

// child opens (create: or creates) the subfolder name; a symbolic link there is refused.
func (d *dirHandle) child(name string, create bool) (*dirHandle, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	p := filepath.Join(d.path, name)
	if create {
		if err := unix.Mkdirat(d.fd, name, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return nil, &fs.PathError{Op: "mkdir", Path: p, Err: err}
		}
	}
	fd, err := unix.Openat(d.fd, name, dirFlags, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: p, Err: err}
	}
	return &dirHandle{fd: fd, path: p}, nil
}

// names lists the folder through (a duplicate of) its handle.
func (d *dirHandle) names() ([]string, error) {
	dup, err := unix.Dup(d.fd)
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(dup)
	if _, err := unix.Seek(dup, 0, 0); err != nil {
		_ = unix.Close(dup)
		return nil, err
	}
	f := os.NewFile(uintptr(dup), d.path)
	defer f.Close()
	return f.Readdirnames(-1)
}

// readDir lists the folder with each entry's information, read with fstatat relative to the
// handle (never following a link, never looking the entry up again by path).
func (d *dirHandle) readDir() ([]fs.FileInfo, error) {
	names, err := d.names()
	if err != nil {
		return nil, err
	}
	out := make([]fs.FileInfo, 0, len(names))
	for _, n := range names {
		var st unix.Stat_t
		if err := unix.Fstatat(d.fd, n, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			continue // removed since the listing
		}
		out = append(out, &statInfo{name: n, st: st})
	}
	return out, nil
}

// statInfo is an fs.FileInfo built from an fstatat result.
type statInfo struct {
	name string
	st   unix.Stat_t
}

func (s *statInfo) Name() string { return s.name }
func (s *statInfo) Size() int64  { return s.st.Size }
func (s *statInfo) IsDir() bool  { return s.Mode().IsDir() }
func (s *statInfo) Sys() any     { return &s.st }
func (s *statInfo) ModTime() time.Time {
	sec, nsec := s.st.Mtim.Unix()
	return time.Unix(sec, nsec)
}

func (s *statInfo) Mode() fs.FileMode {
	m := uint32(s.st.Mode)
	mode := fs.FileMode(m & 0o777)
	switch m & unix.S_IFMT {
	case unix.S_IFDIR:
		mode |= fs.ModeDir
	case unix.S_IFLNK:
		mode |= fs.ModeSymlink
	case unix.S_IFIFO:
		mode |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		mode |= fs.ModeSocket
	case unix.S_IFCHR:
		mode |= fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		mode |= fs.ModeDevice
	}
	if m&unix.S_ISUID != 0 {
		mode |= fs.ModeSetuid
	}
	if m&unix.S_ISGID != 0 {
		mode |= fs.ModeSetgid
	}
	if m&unix.S_ISVTX != 0 {
		mode |= fs.ModeSticky
	}
	return mode
}

// removeAll deletes the entry name with unlinkat. A folder is opened with O_NOFOLLOW and emptied
// through its own handle first; a symbolic link is unlinked itself and never followed.
func (d *dirHandle) removeAll(name string) error {
	if err := validName(name); err != nil {
		return err
	}
	p := filepath.Join(d.path, name)
	var st unix.Stat_t
	if err := unix.Fstatat(d.fd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &fs.PathError{Op: "delete", Path: p, Err: err}
	}
	removeEntryHook(name)
	if uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
		if err := unix.Unlinkat(d.fd, name, 0); err != nil {
			return &fs.PathError{Op: "delete", Path: p, Err: err}
		}
		return nil
	}
	// A link put here since the stat makes this open fail (ELOOP / ENOTDIR): nothing is followed,
	// and the link itself is what gets deleted.
	fd, err := unix.Openat(d.fd, name, dirFlags, 0)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		if serr := unix.Fstatat(d.fd, name, &st, unix.AT_SYMLINK_NOFOLLOW); serr == nil && uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
			if uerr := unix.Unlinkat(d.fd, name, 0); uerr != nil {
				return &fs.PathError{Op: "delete", Path: p, Err: uerr}
			}
			return nil
		}
	}
	if err != nil {
		return &fs.PathError{Op: "delete", Path: p, Err: err}
	}
	sub := &dirHandle{fd: fd, path: p}
	children, err := sub.names()
	if err != nil {
		sub.close()
		return &fs.PathError{Op: "delete", Path: p, Err: err}
	}
	for _, c := range children {
		if err := sub.removeAll(c); err != nil && !errors.Is(err, fs.ErrNotExist) {
			sub.close()
			return err
		}
	}
	sub.close()
	if err := unix.Unlinkat(d.fd, name, unix.AT_REMOVEDIR); err != nil {
		return &fs.PathError{Op: "delete", Path: p, Err: err}
	}
	return nil
}

// renameNoReplaceFallback: where the kernel or file system has no exclusive rename, check that the
// destination is free (relative to its handle, not following links) and rename. The check and the
// rename are two calls, so a name created between them could be replaced; the platform files use
// the atomic call whenever it is available.
func renameNoReplaceFallback(src *dirHandle, srcName string, dst *dirHandle, dstName string) error {
	var st unix.Stat_t
	if err := unix.Fstatat(dst.fd, dstName, &st, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		return &fs.PathError{Op: "rename", Path: filepath.Join(dst.path, dstName), Err: unix.EEXIST}
	} else if !errors.Is(err, unix.ENOENT) {
		return &fs.PathError{Op: "rename", Path: filepath.Join(dst.path, dstName), Err: err}
	}
	if err := unix.Renameat(src.fd, srcName, dst.fd, dstName); err != nil {
		return &os.LinkError{Op: "rename", Old: filepath.Join(src.path, srcName), New: filepath.Join(dst.path, dstName), Err: err}
	}
	return nil
}

func isCrossDevice(err error) bool { return errors.Is(err, unix.EXDEV) }
