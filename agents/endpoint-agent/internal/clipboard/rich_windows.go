//go:build windows

package clipboard

import (
	"fmt"
	"image"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	shell32         = syscall.NewLazyDLL("shell32.dll")
	pDragQueryFileW = shell32.NewProc("DragQueryFileW")
	pRegisterFormat = user32.NewProc("RegisterClipboardFormatW")
)

const (
	cfDIB   uintptr = 8
	cfHDROP uintptr = 15
	cfDIBV5 uintptr = 17
	// DROPEFFECT_COPY under "Preferred DropEffect": Explorer pastes a copy, never a move.
	dropEffectCopy = 1
)

func globalBytes(h uintptr) ([]byte, error) {
	p, _, err := pGlobalLock.Call(h)
	if p == 0 {
		return nil, fmt.Errorf("GlobalLock: %v", err)
	}
	defer pGlobalUnlock.Call(h)
	size, _, _ := pGlobalSize.Call(h)
	if size == 0 || size > 512<<20 {
		return nil, fmt.Errorf("clipboard block of %d bytes", size)
	}
	out := make([]byte, size)
	copy(out, unsafe.Slice((*byte)(memAt(p)), size)) // #nosec G103 -- clipboard memory locked above
	return out, nil
}

func setGlobal(format uintptr, data []byte) error {
	h, _, err := pGlobalAlloc.Call(gmemMoveable, uintptr(len(data)))
	if h == 0 {
		return fmt.Errorf("GlobalAlloc: %v", err)
	}
	p, _, err := pGlobalLock.Call(h)
	if p == 0 {
		_, _, _ = pGlobalFree.Call(h)
		return fmt.Errorf("GlobalLock: %v", err)
	}
	copy(unsafe.Slice((*byte)(memAt(p)), len(data)), data) // #nosec G103 -- our own allocation
	_, _, _ = pGlobalUnlock.Call(h)
	if r, _, err := pSetClipboardData.Call(format, h); r == 0 {
		_, _, _ = pGlobalFree.Call(h)
		return fmt.Errorf("SetClipboardData: %v", err)
	}
	return nil
}

func readImagePNG() ([]byte, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := open(); err != nil {
		return nil, err
	}
	format := cfDIBV5
	if r, _, _ := pIsFormatAvailable.Call(cfDIBV5); r == 0 {
		format = cfDIB
		if r, _, _ := pIsFormatAvailable.Call(cfDIB); r == 0 {
			_, _, _ = pCloseClipboard.Call()
			return nil, ErrNoImage
		}
	}
	h, _, err := pGetClipboardData.Call(format)
	if h == 0 {
		_, _, _ = pCloseClipboard.Call()
		return nil, fmt.Errorf("GetClipboardData: %v", err)
	}
	b, err := globalBytes(h)
	_, _, _ = pCloseClipboard.Call()
	if err != nil {
		return nil, err
	}
	img, err := DIBToImage(b)
	if err != nil {
		return nil, err
	}
	return EncodePNG(img)
}

func writeImagePNG(img image.Image, _ []byte) error {
	dib := ImageToDIB(img)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := open(); err != nil {
		return err
	}
	defer pCloseClipboard.Call()
	if r, _, err := pEmptyClipboard.Call(); r == 0 {
		return fmt.Errorf("EmptyClipboard: %v", err)
	}
	return setGlobal(cfDIB, dib)
}

func readFiles() ([]string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := open(); err != nil {
		return nil, err
	}
	defer pCloseClipboard.Call()
	if r, _, _ := pIsFormatAvailable.Call(cfHDROP); r == 0 {
		return nil, ErrNoFiles
	}
	h, _, err := pGetClipboardData.Call(cfHDROP)
	if h == 0 {
		return nil, fmt.Errorf("GetClipboardData: %v", err)
	}
	n, _, _ := pDragQueryFileW.Call(h, 0xFFFFFFFF, 0, 0)
	var out []string
	for i := uintptr(0); i < n && len(out) < MaxFiles; i++ {
		l, _, _ := pDragQueryFileW.Call(h, i, 0, 0)
		if l == 0 || l > 32767 {
			continue
		}
		buf := make([]uint16, l+1)
		pDragQueryFileW.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), l+1)
		out = append(out, syscall.UTF16ToString(buf))
	}
	if len(out) == 0 {
		return nil, ErrNoFiles
	}
	return out, nil
}

func writeFiles(paths []string) error {
	drop := DropFiles(paths)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := open(); err != nil {
		return err
	}
	defer pCloseClipboard.Call()
	if r, _, err := pEmptyClipboard.Call(); r == 0 {
		return fmt.Errorf("EmptyClipboard: %v", err)
	}
	if err := setGlobal(cfHDROP, drop); err != nil {
		return err
	}
	if f, _, _ := pRegisterFormat.Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("Preferred DropEffect")))); f != 0 {
		_ = setGlobal(f, []byte{dropEffectCopy, 0, 0, 0})
	}
	return nil
}
