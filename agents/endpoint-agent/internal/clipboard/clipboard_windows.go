//go:build windows

package clipboard

import (
	"fmt"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                     = syscall.NewLazyDLL("user32.dll")
	kernel32                   = syscall.NewLazyDLL("kernel32.dll")
	pOpenClipboard             = user32.NewProc("OpenClipboard")
	pCloseClipboard            = user32.NewProc("CloseClipboard")
	pEmptyClipboard            = user32.NewProc("EmptyClipboard")
	pGetClipboardData          = user32.NewProc("GetClipboardData")
	pSetClipboardData          = user32.NewProc("SetClipboardData")
	pIsFormatAvailable         = user32.NewProc("IsClipboardFormatAvailable")
	pGlobalAlloc               = kernel32.NewProc("GlobalAlloc")
	pGlobalFree                = kernel32.NewProc("GlobalFree")
	pGlobalLock                = kernel32.NewProc("GlobalLock")
	pGlobalUnlock              = kernel32.NewProc("GlobalUnlock")
	pGlobalSize                = kernel32.NewProc("GlobalSize")
	cfUnicodeText      uintptr = 13
	gmemMoveable       uintptr = 0x0002
)

// open retries for a moment: another program may hold the clipboard briefly.
func open() error {
	for i := 0; i < 20; i++ {
		if r, _, _ := pOpenClipboard.Call(0); r != 0 {
			return nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	return fmt.Errorf("the clipboard is in use by another program")
}

func readText() (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := open(); err != nil {
		return "", err
	}
	defer pCloseClipboard.Call()
	if r, _, _ := pIsFormatAvailable.Call(cfUnicodeText); r == 0 {
		return "", ErrNoText
	}
	h, _, err := pGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return "", fmt.Errorf("GetClipboardData: %v", err)
	}
	p, _, err := pGlobalLock.Call(h)
	if p == 0 {
		return "", fmt.Errorf("GlobalLock: %v", err)
	}
	defer pGlobalUnlock.Call(h)
	size, _, _ := pGlobalSize.Call(h)
	n := int(size / 2)
	// Bound the read by the allocation and by the size limit (+1 to detect "too long").
	limit := min(n, MaxChars*2+1)
	units := unsafe.Slice((*uint16)(memAt(p)), limit) // #nosec G103 -- clipboard memory locked above
	end := 0
	for end < len(units) && units[end] != 0 {
		end++
	}
	return syscall.UTF16ToString(units[:end]), nil
}

func writeText(text string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	units, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	if err := open(); err != nil {
		return err
	}
	defer pCloseClipboard.Call()
	if r, _, err := pEmptyClipboard.Call(); r == 0 {
		return fmt.Errorf("EmptyClipboard: %v", err)
	}
	size := uintptr(len(units) * 2)
	h, _, err := pGlobalAlloc.Call(gmemMoveable, size)
	if h == 0 {
		return fmt.Errorf("GlobalAlloc: %v", err)
	}
	p, _, err := pGlobalLock.Call(h)
	if p == 0 {
		_, _, _ = pGlobalFree.Call(h)
		return fmt.Errorf("GlobalLock: %v", err)
	}
	copy(unsafe.Slice((*uint16)(memAt(p)), len(units)), units) // #nosec G103 -- our own allocation
	_, _, _ = pGlobalUnlock.Call(h)
	if r, _, err := pSetClipboardData.Call(cfUnicodeText, h); r == 0 {
		_, _, _ = pGlobalFree.Call(h)
		return fmt.Errorf("SetClipboardData: %v", err)
	}
	return nil // the clipboard owns the memory now
}

// memAt turns an address returned by GlobalLock into a pointer (the memory is not Go-managed).
func memAt(p uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&p)) // #nosec G103
}
