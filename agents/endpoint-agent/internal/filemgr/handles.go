package filemgr

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Handle-relative changes (R-7, the rest of EXT-8). mkdir, rename, move and delete no longer act on a
// path name after it was checked: the folder they change is opened first, refusing a link or junction
// in its place, the handle's real location is checked against the same allowed roots and protected
// locations, and the change is made relative to that handle (NtCreateFile with a root directory and
// SetFileInformationByHandle / NtSetInformationFile on Windows; openat, mkdirat, renameat and
// unlinkat with O_NOFOLLOW on Linux and macOS). A folder swapped for a link after the check is then
// refused instead of followed. The platform files provide dirHandle:
//
//	openDirNoFollow(real) opens exactly the resolved folder real, refusing links (every component on
//	                      Linux/macOS, the folder itself on Windows, where the final-path check below
//	                      covers the components before it)
//	finalPath()           where the open folder really is
//	child(name, create)   opens (or creates) a subfolder, never through a link
//	names()               the folder's entries, read through the handle
//	removeAll(name)       deletes an entry, a folder with everything in it; links are deleted
//	                      themselves and never followed
//	renameNoReplace(...)  renames an entry between two open folders, never replacing anything

// afterResolve runs between resolving a folder's real path and opening it; tests use it to swap the
// folder for a link at exactly that moment.
var afterResolve = func(dir string) {}

// removeEntryHook runs inside a recursive delete for each entry, at the point a swap is most
// dangerous on that platform (tests only).
var removeEntryHook = func(name string) {}

// samePath compares two real paths; Windows paths are case-insensitive.
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// checkReal applies the guards to a real (resolved) location.
func checkReal(real string, g guard) error {
	if strings.HasPrefix(filepath.ToSlash(real), "//") {
		return errors.New("path resolves to a network or device location")
	}
	if err := checkGuards(real, resolvedRoots(g.roots), g.mutating); err != nil {
		return fmt.Errorf("the folder is not where the path was checked: %w", err)
	}
	return nil
}

// openCheckedDir opens the folder dir for handle-relative work and returns it with its real
// location. The handle must be a folder (not a link) at exactly the location dir resolved to; the
// caller checks the guards for the entry it is about to change (real joined with the entry name).
func openCheckedDir(dir string) (*dirHandle, string, error) {
	real, err := realPath(dir)
	if err != nil {
		return nil, "", err
	}
	if strings.HasPrefix(filepath.ToSlash(real), "//") {
		return nil, "", errors.New("path resolves to a network or device location")
	}
	afterResolve(dir)
	d, err := openDirNoFollow(real)
	if err != nil {
		return nil, "", fmt.Errorf("the folder changed while it was being opened: %w", err)
	}
	got, err := d.finalPath()
	if err != nil {
		d.close()
		return nil, "", fmt.Errorf("cannot confirm where the opened folder is: %w", err)
	}
	if !samePath(got, real) {
		d.close()
		return nil, "", errors.New("the folder changed while it was being opened")
	}
	return d, real, nil
}

// validName refuses anything but a single plain name (the platform calls use names relative to a
// handle; a separator or a stream suffix would reach somewhere else).
func validName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") ||
		(runtime.GOOS == "windows" && strings.ContainsAny(name, `\:`)) {
		return fmt.Errorf("invalid name %q", name)
	}
	return nil
}

// mkdirChecked creates clean and any missing folders above it (like os.MkdirAll), each one inside
// the checked handle of the folder above. Every folder it creates is checked against the guards at
// its real location; an existing folder on the way that is (or became) a link is refused.
func mkdirChecked(clean string, g guard) error {
	base := clean
	var missing []string
	for {
		if _, err := os.Lstat(base); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(base)
		if parent == base {
			return errors.New("no existing folder to create in")
		}
		missing = append([]string{filepath.Base(base)}, missing...)
		base = parent
	}
	d, real, err := openCheckedDir(base)
	if err != nil {
		return err
	}
	defer func() { d.close() }()
	if len(missing) == 0 {
		return nil // clean exists and is a folder
	}
	for _, name := range missing {
		if err := validName(name); err != nil {
			return err
		}
		real = filepath.Join(real, name)
		if err := checkReal(real, g); err != nil {
			return err
		}
		next, err := d.child(name, true)
		if err != nil {
			return err
		}
		d.close()
		d = next
	}
	return nil
}

// renameChecked renames clean to newName in the same folder, through the checked folder handle.
// It never replaces an existing entry.
func renameChecked(clean, newName string, g guard) error {
	leaf := filepath.Base(clean)
	if err := validName(leaf); err != nil {
		return err
	}
	if err := validName(newName); err != nil {
		return err
	}
	d, real, err := openCheckedDir(filepath.Dir(clean))
	if err != nil {
		return err
	}
	defer d.close()
	if err := checkReal(filepath.Join(real, leaf), g); err != nil {
		return err
	}
	if err := checkReal(filepath.Join(real, newName), g); err != nil {
		return err
	}
	return renameNoReplace(d, leaf, d, newName)
}

// removeChecked deletes clean (a folder with everything in it) through the checked handle of its
// folder. Like os.RemoveAll, something already gone is not an error.
func removeChecked(clean string, g guard) error {
	leaf := filepath.Base(clean)
	if err := validName(leaf); err != nil {
		return err
	}
	d, real, err := openCheckedDir(filepath.Dir(clean))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	defer d.close()
	if err := checkReal(filepath.Join(real, leaf), g); err != nil {
		return err
	}
	if err := d.removeAll(leaf); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// openListedDir opens the folder clean for reading (list, search, copy) and checks its real
// location against the read guards, so a folder swapped for a link after the path check cannot
// show or hand out the contents of a place outside the allowed roots.
func openListedDir(clean string, roots []string) (*dirHandle, string, error) {
	d, real, err := openCheckedDir(clean)
	if err != nil {
		return nil, "", err
	}
	if err := checkReal(real, guard{roots, false}); err != nil {
		d.close()
		return nil, "", err
	}
	return d, real, nil
}

// readDirChecked lists the folder clean through its checked handle, sorted by name.
func readDirChecked(clean string, roots []string) ([]fs.FileInfo, error) {
	d, _, err := openListedDir(clean, roots)
	if err != nil {
		return nil, err
	}
	defer d.close()
	infos, err := d.readDir()
	if err != nil {
		return nil, err
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name() < infos[j].Name() })
	return infos, nil
}

// searchChecked walks the folder clean through handles: each subfolder is opened relative to the
// folder above it and never through a link (links are listed, not entered), like WalkDir did.
func searchChecked(clean, queryLower string, showHidden bool, roots []string) ([]FileEntry, error) {
	d, real, err := openListedDir(clean, roots)
	if err != nil {
		return nil, err
	}
	defer d.close()
	var hits []FileEntry
	var walk func(d *dirHandle, shown, real string, depth int) bool
	walk = func(d *dirHandle, shown, real string, depth int) bool {
		infos, err := d.readDir()
		if err != nil {
			return true
		}
		sort.Slice(infos, func(i, j int) bool { return infos[i].Name() < infos[j].Name() })
		for _, info := range infos {
			name := info.Name()
			full, fullReal := filepath.Join(shown, name), filepath.Join(real, name)
			// Never walk into (or name the files of) a credential store.
			if isForbiddenCredentialPath(full) || isForbiddenCredentialPath(fullReal) || depth > MaxSearchDepth {
				continue
			}
			hidden, sys := isHiddenOrSystem(full, info)
			if !showHidden && (hidden || sys) {
				continue
			}
			if strings.Contains(strings.ToLower(name), queryLower) {
				hits = append(hits, fileEntry(full, info, hidden, sys))
				if len(hits) >= MaxSearchHits {
					return false
				}
			}
			if info.IsDir() && info.Mode()&fs.ModeSymlink == 0 {
				sub, err := d.child(name, false)
				if err != nil {
					continue
				}
				more := walk(sub, full, fullReal, depth+1)
				sub.close()
				if !more {
					return false
				}
			}
		}
		return true
	}
	walk(d, clean, real, 1)
	return hits, nil
}

// walkChecked lists every file and folder under clean, folders before their contents, through
// handles like searchChecked: links are listed, never entered, and credential stores are skipped.
// The answer stops at MaxWalkEntries entries or MaxWalkDepth levels and then says Truncated.
func walkChecked(clean string, showHidden bool, roots []string) (Response, error) {
	d, real, err := openListedDir(clean, roots)
	if err != nil {
		return Response{}, fmt.Errorf("read directory failed: %w", err)
	}
	defer d.close()
	out := Response{Op: "walk", Path: clean, Entries: []FileEntry{}}
	var walk func(d *dirHandle, shown, real string, depth int) bool
	walk = func(d *dirHandle, shown, real string, depth int) bool {
		infos, err := d.readDir()
		if err != nil {
			return true
		}
		sort.Slice(infos, func(i, j int) bool { return infos[i].Name() < infos[j].Name() })
		for _, info := range infos {
			name := info.Name()
			full, fullReal := filepath.Join(shown, name), filepath.Join(real, name)
			if isForbiddenCredentialPath(full) || isForbiddenCredentialPath(fullReal) {
				continue
			}
			hidden, sys := isHiddenOrSystem(full, info)
			if !showHidden && (hidden || sys) {
				continue
			}
			if len(out.Entries) >= MaxWalkEntries {
				out.Truncated = true
				return false
			}
			out.Entries = append(out.Entries, fileEntry(full, info, hidden, sys))
			if !info.IsDir() {
				out.TotalFiles++
				out.TotalSize += info.Size()
				continue
			}
			out.TotalDirs++
			if info.Mode()&fs.ModeSymlink != 0 {
				continue
			}
			if depth >= MaxWalkDepth {
				out.Truncated = true
				continue
			}
			sub, err := d.child(name, false)
			if err != nil {
				continue
			}
			more := walk(sub, full, fullReal, depth+1)
			sub.close()
			if !more {
				return false
			}
		}
		return true
	}
	walk(d, clean, real, 1)
	return out, nil
}

func fileEntry(full string, info fs.FileInfo, hidden, sys bool) FileEntry {
	ext := ""
	if !info.IsDir() {
		ext = strings.TrimPrefix(strings.ToLower(filepath.Ext(info.Name())), ".")
	}
	return FileEntry{
		Name:     info.Name(),
		Path:     full,
		IsDir:    info.IsDir(),
		Ext:      ext,
		Size:     info.Size(),
		Mode:     info.Mode().String(),
		ModTime:  info.ModTime().UTC().Format(time.RFC3339),
		IsHidden: hidden,
		IsSystem: sys,
	}
}

// moveChecked moves src into the folder of dst (dst's name is src's name) by a handle-relative
// rename. Only when the two are on different volumes does it copy (through checked handles) and
// then delete the source (through a checked handle).
func moveChecked(src, dst string, roots []string) error {
	g := guard{roots, true}
	leaf := filepath.Base(src)
	if err := validName(leaf); err != nil {
		return err
	}
	if isSameOrSubpath(dst, src) {
		return errors.New("cannot move a directory into itself")
	}
	sd, sReal, err := openCheckedDir(filepath.Dir(src))
	if err != nil {
		return err
	}
	defer sd.close()
	dd, dReal, err := openCheckedDir(filepath.Dir(dst))
	if err != nil {
		return err
	}
	defer dd.close()
	from, to := filepath.Join(sReal, leaf), filepath.Join(dReal, filepath.Base(dst))
	if err := checkReal(from, g); err != nil {
		return err
	}
	if err := checkReal(to, g); err != nil {
		return err
	}
	if isSameOrSubpath(to, from) {
		return errors.New("cannot move a directory into itself")
	}
	err = renameNoReplace(sd, leaf, dd, filepath.Base(dst))
	if err == nil || !isCrossDevice(err) {
		return err
	}
	if err := copyRecursive(src, dst, roots); err != nil {
		return err
	}
	return removeChecked(src, g)
}
