//go:build windows

package filemgr

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dirHandle is an open folder (never a link or junction) whose location was checked.
type dirHandle struct {
	h    windows.Handle
	path string
}

const (
	dirAccess = windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE
	shareAll  = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	// isNameSurrogate: the reparse tag stands for another name (symbolic link, junction, volume mount
	// point): what the old code followed. Other reparse points (OneDrive placeholders, dedup) are
	// ordinary files and folders.
	reparseTagNameSurrogate = 0x20000000
)

// openDirNoFollow opens the folder at the resolved path real with FILE_FLAG_OPEN_REPARSE_POINT, so a
// junction or symbolic link put there is opened itself (and refused) instead of followed. Links on
// the way to it are caught by openCheckedDir comparing the handle's final path with real.
func openDirNoFollow(real string) (*dirHandle, error) {
	p, err := windows.UTF16PtrFromString(real)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, dirAccess, shareAll, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	d := &dirHandle{h: h, path: real}
	if err := mustBePlainDir(h); err != nil {
		d.close()
		return nil, err
	}
	return d, nil
}

func (d *dirHandle) close() {
	if d != nil && d.h != 0 && d.h != windows.InvalidHandle {
		_ = windows.CloseHandle(d.h)
		d.h = 0
	}
}

func (d *dirHandle) finalPath() (string, error) { return finalPath(syscall.Handle(d.h)) }

// attrTag reads the attributes and the reparse tag of an open handle.
func attrTag(h windows.Handle) (attrs, tag uint32, err error) {
	var info struct {
		FileAttributes uint32
		ReparseTag     uint32
	}
	const fileAttributeTagInfo = 9
	if err := windows.GetFileInformationByHandleEx(h, fileAttributeTagInfo, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return 0, 0, err
	}
	return info.FileAttributes, info.ReparseTag, nil
}

func isLink(attrs, tag uint32) bool {
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && tag&reparseTagNameSurrogate != 0
}

func mustBePlainDir(h windows.Handle) error {
	attrs, tag, err := attrTag(h)
	if err != nil {
		return err
	}
	if isLink(attrs, tag) {
		return errors.New("a link or junction is in the place of the folder")
	}
	if attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errors.New("not a folder")
	}
	return nil
}

func ntErr(err error) error {
	var st windows.NTStatus
	if errors.As(err, &st) {
		return st.Errno()
	}
	return err
}

// ntOpen opens name inside d (relative to its handle, one component, the entry itself even when it
// is a reparse point).
func (d *dirHandle) ntOpen(name string, access, disposition, options uint32) (windows.Handle, uintptr, error) {
	if err := validName(name); err != nil {
		return 0, 0, err
	}
	us, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, 0, err
	}
	oa := &windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: d.h,
		ObjectName:    us,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	var iosb windows.IO_STATUS_BLOCK
	var h windows.Handle
	err = windows.NtCreateFile(&h, access|windows.SYNCHRONIZE, oa, &iosb, nil, windows.FILE_ATTRIBUTE_NORMAL, shareAll,
		disposition, options|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_OPEN_FOR_BACKUP_INTENT, 0, 0)
	if err != nil {
		return 0, 0, ntErr(err)
	}
	return h, iosb.Information, nil
}

// child opens (create: or creates) the subfolder name; a link or junction there is refused.
func (d *dirHandle) child(name string, create bool) (*dirHandle, error) {
	disp := uint32(windows.FILE_OPEN)
	if create {
		disp = windows.FILE_OPEN_IF
	}
	h, _, err := d.ntOpen(name, dirAccess, disp, windows.FILE_DIRECTORY_FILE)
	if err != nil {
		return nil, fmt.Errorf("open folder %s: %w", name, err)
	}
	c := &dirHandle{h: h, path: d.path + `\` + name}
	if err := mustBePlainDir(h); err != nil {
		c.close()
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return c, nil
}

// osFile wraps a duplicate of the folder handle in an *os.File, whose directory reading works on
// the handle alone (GetFileInformationByHandleEx, restarting at the first entry): names, sizes,
// times and attributes come from the listing, and nothing is looked up again by path.
func (d *dirHandle) osFile() (*os.File, error) {
	var dup windows.Handle
	p := windows.CurrentProcess()
	if err := windows.DuplicateHandle(p, d.h, p, &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(dup), d.path), nil
}

// names lists the folder through its handle.
func (d *dirHandle) names() ([]string, error) {
	f, err := d.osFile()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

// readDir lists the folder with each entry's information, through its handle.
func (d *dirHandle) readDir() ([]fs.FileInfo, error) {
	f, err := d.osFile()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdir(-1)
}

// removeAll deletes the entry name. A folder is emptied through its own handle first; a link or
// junction is deleted itself (opened with FILE_OPEN_REPARSE_POINT) and never followed.
func (d *dirHandle) removeAll(name string) error {
	removeEntryHook(name)
	h, _, err := d.ntOpen(name, windows.DELETE|dirAccess, windows.FILE_OPEN, 0)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// A file that may not be read but may be deleted.
		h, _, err = d.ntOpen(name, windows.DELETE|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, windows.FILE_NON_DIRECTORY_FILE)
	}
	if err != nil {
		return fmt.Errorf("delete %s: %w", name, err)
	}
	defer windows.CloseHandle(h)
	attrs, tag, err := attrTag(h)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0 && !isLink(attrs, tag) {
		sub := &dirHandle{h: h, path: d.path + `\` + name}
		children, err := sub.names()
		if err != nil {
			return fmt.Errorf("list %s: %w", name, err)
		}
		for _, c := range children {
			if err := sub.removeAll(c); err != nil && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
				return err
			}
		}
	}
	return markDeleted(h, name)
}

func markDeleted(h windows.Handle, name string) error {
	// POSIX semantics take the name away at once (the parent folder can be removed right after);
	// read-only files are deleted like os.RemoveAll does.
	flags := uint32(windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS | windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE)
	err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfoEx, (*byte)(unsafe.Pointer(&flags)), 4)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) || errors.Is(err, windows.ERROR_INVALID_FUNCTION) {
		// Older Windows or a file system without the extended call (FAT): delete on close.
		del := uint32(1)
		err = windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, (*byte)(unsafe.Pointer(&del)), 4)
	}
	if err != nil {
		return fmt.Errorf("delete %s: %w", name, err)
	}
	return nil
}

// fileRenameInformation is FILE_RENAME_INFORMATION (the name follows in the same buffer).
type fileRenameInformation struct {
	Flags          uint32 // ReplaceIfExists: 0, never replace
	RootDirectory  windows.Handle
	FileNameLength uint32
	FileName       [1]uint16
}

// renameNoReplace renames srcName in src to dstName in dst: the entry is opened relative to src
// (the entry itself when it is a link) and renamed with RootDirectory = dst, never replacing.
func renameNoReplace(src *dirHandle, srcName string, dst *dirHandle, dstName string) error {
	if err := validName(dstName); err != nil {
		return err
	}
	h, _, err := src.ntOpen(srcName, windows.DELETE|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, 0)
	if err != nil {
		return fmt.Errorf("rename %s: %w", srcName, err)
	}
	defer windows.CloseHandle(h)
	name16 := utf16.Encode([]rune(dstName))
	size := int(unsafe.Offsetof(fileRenameInformation{}.FileName)) + len(name16)*2
	backing := make([]uint64, size/8+2)
	ri := (*fileRenameInformation)(unsafe.Pointer(&backing[0]))
	ri.RootDirectory = dst.h
	ri.FileNameLength = uint32(len(name16) * 2)
	copy(unsafe.Slice(&ri.FileName[0], len(name16)), name16)
	var iosb windows.IO_STATUS_BLOCK
	if err := windows.NtSetInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&backing[0])), uint32(size), windows.FileRenameInformation); err != nil {
		return fmt.Errorf("rename %s: %w", srcName, ntErr(err))
	}
	return nil
}

func isCrossDevice(err error) bool { return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE) }
