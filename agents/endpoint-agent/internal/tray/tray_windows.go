//go:build windows

package tray

import (
	"errors"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")

	pRegisterClassExW       = user32.NewProc("RegisterClassExW")
	pCreateWindowExW        = user32.NewProc("CreateWindowExW")
	pDefWindowProcW         = user32.NewProc("DefWindowProcW")
	pDestroyWindow          = user32.NewProc("DestroyWindow")
	pGetMessageW            = user32.NewProc("GetMessageW")
	pTranslateMessage       = user32.NewProc("TranslateMessage")
	pDispatchMessageW       = user32.NewProc("DispatchMessageW")
	pPostMessageW           = user32.NewProc("PostMessageW")
	pPostQuitMessage        = user32.NewProc("PostQuitMessage")
	pLoadIconW              = user32.NewProc("LoadIconW")
	pCreatePopupMenu        = user32.NewProc("CreatePopupMenu")
	pAppendMenuW            = user32.NewProc("AppendMenuW")
	pTrackPopupMenu         = user32.NewProc("TrackPopupMenu")
	pDestroyMenu            = user32.NewProc("DestroyMenu")
	pGetCursorPos           = user32.NewProc("GetCursorPos")
	pSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	pRegisterWindowMessageW = user32.NewProc("RegisterWindowMessageW")
	pMessageBoxW            = user32.NewProc("MessageBoxW")
	pShellNotifyIconW       = shell32.NewProc("Shell_NotifyIconW")
	pGetModuleHandleW       = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	classOnce               sync.Once
	classErr                error
	className               = windows.StringToUTF16Ptr("NigafiyTrayWindow")
	windowsByHandle         sync.Map // hwnd → *Icon
	wndProcCallback         = syscall.NewCallback(wndProc)
)

const (
	wmClose       = 0x0010
	wmDestroy     = 0x0002
	wmCommand     = 0x0111
	wmLButtonUp   = 0x0202
	wmRButtonUp   = 0x0205
	wmApp         = 0x8000
	wmTrayIcon    = wmApp + 1
	wmUpdate      = wmApp + 2
	nimAdd        = 0
	nimModify     = 1
	nimDelete     = 2
	nifMessage    = 0x1
	nifIcon       = 0x2
	nifTip        = 0x4
	nifInfo       = 0x10
	niifInfo      = 0x1
	mfString      = 0x0
	mfGrayed      = 0x1
	mfSeparator   = 0x800
	tpmReturnCmd  = 0x100
	tpmRightBtn   = 0x2
	idiInfo       = 32516
	mbIconInfo    = 0x40
	mbTopmost     = 0x40000
	mbSetForegrnd = 0x10000
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type notifyIconData struct {
	Size            uint32
	Wnd             windows.HWND
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            windows.Handle
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	TimeoutVersion  uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GUIDItem        windows.GUID
	BalloonIcon     windows.Handle
}

type msg struct {
	Wnd     windows.HWND
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
	Private uint32
}

// Icon is one tray icon with its own window and message loop (on a locked OS thread).
type Icon struct {
	opts           Options
	hwnd           windows.HWND
	taskbarCreated uint32
	mu             sync.Mutex
	id, server     string
	balloon        [2]string
	done           chan struct{}
}

// Start adds the icon. It fails where there is no shell to show it (the sign-in desktop, a
// session without Explorer).
func Start(opts Options) (*Icon, error) {
	t := &Icon{opts: opts, done: make(chan struct{})}
	ready := make(chan error, 1)
	go t.loop(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return t, nil
}

func registerClass(inst windows.Handle) error {
	classOnce.Do(func() {
		wc := wndClassEx{WndProc: wndProcCallback, Instance: inst, ClassName: className}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			classErr = err
		}
	})
	return classErr
}

func (t *Icon) loop(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(t.done)
	inst, _, _ := pGetModuleHandleW.Call(0)
	if err := registerClass(windows.Handle(inst)); err != nil {
		ready <- err
		return
	}
	title := windows.StringToUTF16Ptr("Nigafiy")
	h, _, err := pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), 0, 0, 0, 0, 0, 0, 0, inst, 0)
	if h == 0 {
		ready <- err
		return
	}
	t.hwnd = windows.HWND(h)
	windowsByHandle.Store(h, t)
	tc, _, _ := pRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("TaskbarCreated"))))
	t.taskbarCreated = uint32(tc)
	if !t.notify(nimAdd) {
		windowsByHandle.Delete(h)
		_, _, _ = pDestroyWindow.Call(h)
		ready <- errors.New("Shell_NotifyIcon failed: no notification area on this desktop")
		return
	}
	ready <- nil
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		_, _, _ = pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func (t *Icon) notify(op uintptr) bool {
	t.mu.Lock()
	id, balloon := t.id, t.balloon
	t.balloon = [2]string{}
	t.mu.Unlock()
	icon, _, _ := pLoadIconW.Call(0, idiInfo)
	d := notifyIconData{Wnd: t.hwnd, ID: 1, Flags: nifMessage | nifIcon | nifTip, CallbackMessage: wmTrayIcon, Icon: windows.Handle(icon)}
	d.Size = uint32(unsafe.Sizeof(d))
	copyUTF16(d.Tip[:], Tooltip(id))
	if balloon[1] != "" && op == nimModify {
		d.Flags |= nifInfo
		d.InfoFlags = niifInfo
		copyUTF16(d.InfoTitle[:], balloon[0])
		copyUTF16(d.Info[:], balloon[1])
	}
	r, _, _ := pShellNotifyIconW.Call(op, uintptr(unsafe.Pointer(&d)))
	return r != 0
}

func copyUTF16(dst []uint16, s string) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return
	}
	if len(u) > len(dst) {
		u = u[:len(dst)]
		u[len(u)-1] = 0
	}
	copy(dst, u)
}

// SetInfo updates the Nigafiy ID (tooltip, menu) and the server shown in About.
func (t *Icon) SetInfo(nigafiyID, server string) {
	t.mu.Lock()
	changed := t.id != nigafiyID || t.server != server
	t.id, t.server = nigafiyID, server
	t.mu.Unlock()
	if changed {
		_, _, _ = pPostMessageW.Call(uintptr(t.hwnd), wmUpdate, 0, 0)
	}
}

// Notify shows a balloon next to the icon.
func (t *Icon) Notify(title, text string) {
	t.mu.Lock()
	t.balloon = [2]string{title, text}
	t.mu.Unlock()
	_, _, _ = pPostMessageW.Call(uintptr(t.hwnd), wmUpdate, 0, 0)
}

// Close removes the icon and ends its message loop.
func (t *Icon) Close() {
	_, _, _ = pPostMessageW.Call(uintptr(t.hwnd), wmClose, 0, 0)
	<-t.done
}

func (t *Icon) showMenu() {
	t.mu.Lock()
	labels := MenuLabels(t.id)
	t.mu.Unlock()
	menu, _, _ := pCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer pDestroyMenu.Call(menu)
	add := func(flags uintptr, id int) {
		_, _, _ = pAppendMenuW.Call(menu, flags, uintptr(id), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(labels[id]))))
	}
	add(mfString, ItemRequestHelp)
	add(mfString, ItemITActivity)
	_, _, _ = pAppendMenuW.Call(menu, mfSeparator, 0, 0)
	add(mfString|mfGrayed, ItemID)
	add(mfString, ItemAbout)
	var pt struct{ X, Y int32 }
	_, _, _ = pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// The menu closes when the person clicks elsewhere only if our window is in the foreground.
	_, _, _ = pSetForegroundWindow.Call(uintptr(t.hwnd))
	cmd, _, _ := pTrackPopupMenu.Call(menu, tpmReturnCmd|tpmRightBtn, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(t.hwnd), 0)
	switch int(cmd) {
	case ItemRequestHelp:
		if t.opts.OnRequestHelp != nil {
			go t.opts.OnRequestHelp()
		}
	case ItemITActivity:
		if t.opts.OnITActivity != nil {
			go t.opts.OnITActivity()
		}
	case ItemAbout:
		t.mu.Lock()
		text := AboutText(t.id, t.server)
		t.mu.Unlock()
		go func() {
			_, _, _ = pMessageBoxW.Call(0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(text))), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Nigafiy"))), mbIconInfo|mbTopmost|mbSetForegrnd)
		}()
	}
}

func wndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	if message == wmDestroy {
		_, _, _ = pPostQuitMessage.Call(0)
		return 0
	}
	v, ok := windowsByHandle.Load(hwnd)
	if ok {
		t := v.(*Icon)
		switch {
		case message == wmTrayIcon && (lParam&0xffff == wmRButtonUp || lParam&0xffff == wmLButtonUp):
			t.showMenu()
			return 0
		case message == wmUpdate:
			t.notify(nimModify)
			return 0
		case t.taskbarCreated != 0 && message == t.taskbarCreated:
			// Explorer restarted: the icon has to be added again.
			t.notify(nimAdd)
			return 0
		case message == wmClose:
			t.notify(nimDelete)
			windowsByHandle.Delete(hwnd)
			_, _, _ = pDestroyWindow.Call(hwnd)
			return 0
		}
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return r
}
