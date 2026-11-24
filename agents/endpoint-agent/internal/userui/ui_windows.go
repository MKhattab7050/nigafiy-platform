//go:build windows

package userui

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Native Win32 windows, created with plain syscalls (no cgo). Each window runs its own message loop
// on a locked OS thread; one shared window procedure dispatches by window handle.

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	pRegisterClassExW    = user32.NewProc("RegisterClassExW")
	pCreateWindowExW     = user32.NewProc("CreateWindowExW")
	pDefWindowProcW      = user32.NewProc("DefWindowProcW")
	pGetMessageW         = user32.NewProc("GetMessageW")
	pTranslateMessage    = user32.NewProc("TranslateMessage")
	pDispatchMessageW    = user32.NewProc("DispatchMessageW")
	pPostMessageW        = user32.NewProc("PostMessageW")
	pSendMessageW        = user32.NewProc("SendMessageW")
	pDestroyWindow       = user32.NewProc("DestroyWindow")
	pPostQuitMessage     = user32.NewProc("PostQuitMessage")
	pSetWindowTextW      = user32.NewProc("SetWindowTextW")
	pSetTimer            = user32.NewProc("SetTimer")
	pKillTimer           = user32.NewProc("KillTimer")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pShowWindow          = user32.NewProc("ShowWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pLoadCursorW         = user32.NewProc("LoadCursorW")
	pGetDlgItem          = user32.NewProc("GetDlgItem")
	pGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	pGetStockObject      = gdi32.NewProc("GetStockObject")
	pGetSysColorBrush    = user32.NewProc("GetSysColorBrush")
)

const (
	wmDestroy  = 0x0002
	wmClose    = 0x0010
	wmSetFont  = 0x0030
	wmCommand  = 0x0111
	wmTimer    = 0x0113
	wmAppClose = 0x8001
	bmClick    = 0x00F5

	wsPopup        = 0x80000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsVisible      = 0x10000000
	wsChild        = 0x40000000
	wsTabStop      = 0x00010000
	bsDefPushBtn   = 0x00000001
	bsPushButton   = 0x00000000
	ssLeft         = 0x00000000
	wsExTopmost    = 0x00000008
	wsExToolWindow = 0x00000080
	wsExDlgFrame   = 0x00000001

	swShow         = 5
	hwndTopmost    = ^uintptr(0) // (HWND)-1
	swpNoMove      = 0x0002
	swpNoSize      = 0x0001
	swpNoActivate  = 0x0010
	swpShowWindow  = 0x0040
	smCxScreen     = 0
	smCyScreen     = 1
	defaultGUIFont = 17
	colorBtnFace   = 15
	idcArrow       = 32512

	idAllow   = 101
	idDecline = 102
	idEnd     = 103
	idText    = 110
	timerTick = 1
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type point struct{ x, y int32 }

type msg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	pt       point
	lPrivate uint32
}

// window is the Go side of one top-level window.
type window struct {
	onCommand func(id int)
	onTimer   func()
	// onClose returns true when the window may close (the banner refuses: only End closes it).
	onClose func() bool
}

var (
	classOnce  sync.Once
	classErr   error
	className  = syscall.StringToUTF16Ptr("NigafiySupportWindow")
	windowsMu  sync.Mutex
	windowsMap = map[uintptr]*window{}
	wndProcPtr = syscall.NewCallback(wndProc)
)

func wndProc(hwnd uintptr, m uint32, wParam, lParam uintptr) uintptr {
	windowsMu.Lock()
	w := windowsMap[hwnd]
	windowsMu.Unlock()
	switch m {
	case wmCommand:
		if w != nil && w.onCommand != nil {
			w.onCommand(int(wParam & 0xffff))
		}
		return 0
	case wmTimer:
		if w != nil && w.onTimer != nil {
			w.onTimer()
		}
		return 0
	case wmClose:
		if w != nil && w.onClose != nil && !w.onClose() {
			return 0
		}
		_, _, _ = pDestroyWindow.Call(hwnd)
		return 0
	case wmAppClose:
		_, _, _ = pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		windowsMu.Lock()
		delete(windowsMap, hwnd)
		windowsMu.Unlock()
		_, _, _ = pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, uintptr(m), wParam, lParam)
	return r
}

func registerClass() error {
	classOnce.Do(func() {
		hInst, _, _ := pGetModuleHandleW.Call(0)
		cursor, _, _ := pLoadCursorW.Call(0, idcArrow)
		brush, _, _ := pGetSysColorBrush.Call(colorBtnFace)
		wc := wndClassEx{lpfnWndProc: wndProcPtr, hInstance: hInst, hCursor: cursor, hbrBackground: brush, lpszClassName: className}
		wc.cbSize = uint32(unsafe.Sizeof(wc))
		if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			classErr = fmt.Errorf("RegisterClassExW: %v", err)
		}
	})
	return classErr
}

func metric(i int) int {
	r, _, _ := pGetSystemMetrics.Call(uintptr(i))
	return int(int32(r))
}

func utf16(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("?")
	}
	return p
}

func createChild(parent uintptr, class, text string, style uintptr, x, y, w, h, id int) uintptr {
	hInst, _, _ := pGetModuleHandleW.Call(0)
	hwnd, _, _ := pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(utf16(class))), uintptr(unsafe.Pointer(utf16(text))),
		wsChild|wsVisible|style, uintptr(x), uintptr(y), uintptr(w), uintptr(h), parent, uintptr(id), hInst, 0)
	font, _, _ := pGetStockObject.Call(defaultGUIFont)
	_, _, _ = pSendMessageW.Call(hwnd, wmSetFont, font, 1)
	return hwnd
}

// spec of a top-level window: geometry, texts, buttons.
type spec struct {
	title   string
	text    string
	exStyle uintptr
	style   uintptr
	w, h    int
	top     bool // top-centre (banner) instead of screen centre
	buttons []struct {
		id    int
		label string
		def   bool
	}
}

// runWindow creates the window on a locked thread, calls ready(hwnd), and runs its message loop
// until the window is destroyed. It returns when the loop ends.
func runWindow(s spec, w *window, ready func(hwnd uintptr), failed func(error)) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := registerClass(); err != nil {
		failed(err)
		return
	}
	sw, sh := metric(smCxScreen), metric(smCyScreen)
	if sw <= 0 || sh <= 0 {
		failed(ErrUnavailable)
		return
	}
	x, y := (sw-s.w)/2, (sh-s.h)/2
	if s.top {
		y = 12
	}
	hInst, _, _ := pGetModuleHandleW.Call(0)
	hwnd, _, err := pCreateWindowExW.Call(s.exStyle, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(utf16(s.title))),
		s.style, uintptr(x), uintptr(y), uintptr(s.w), uintptr(s.h), 0, 0, hInst, 0)
	if hwnd == 0 {
		failed(fmt.Errorf("%w: CreateWindowExW: %v", ErrUnavailable, err))
		return
	}
	windowsMu.Lock()
	windowsMap[hwnd] = w
	windowsMu.Unlock()

	btnW, btnH, gap := 150, 28, 10
	textH := s.h - btnH - 70
	createChild(hwnd, "STATIC", s.text, ssLeft, 14, 10, s.w-34, textH, idText)
	bx := s.w - 24 - len(s.buttons)*(btnW+gap) + gap
	for i, b := range s.buttons {
		style := uintptr(wsTabStop | bsPushButton)
		if b.def {
			style = wsTabStop | bsDefPushBtn
		}
		createChild(hwnd, "BUTTON", b.label, style, bx+i*(btnW+gap), textH+18, btnW, btnH, b.id)
	}
	_, _, _ = pShowWindow.Call(hwnd, swShow)
	_, _, _ = pSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
	_, _, _ = pSetForegroundWindow.Call(hwnd)
	_, _, _ = pSetTimer.Call(hwnd, timerTick, 1000, 0)
	ready(hwnd)

	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		_, _, _ = pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	_, _, _ = pKillTimer.Call(hwnd, timerTick)
}

type winUI struct {
	mu     sync.Mutex
	banner *bannerWin
}

type bannerWin struct {
	session string
	hwnd    uintptr
	done    chan struct{}
}

func newPlatformUI() UI { return &winUI{} }

func (u *winUI) Consent(ctx context.Context, req ConsentRequest) (ConsentAnswer, error) {
	req = req.Normalize()
	answer := make(chan ConsentAnswer, 1)
	errc := make(chan error, 1)
	hwndc := make(chan uintptr, 1)
	left := req.TimeoutSeconds
	var textHwnd uintptr
	var once sync.Once
	finish := func(hwnd uintptr, a ConsentAnswer) {
		once.Do(func() {
			answer <- a
			_, _, _ = pPostMessageW.Call(hwnd, wmAppClose, 0, 0)
		})
	}
	var self uintptr
	w := &window{}
	w.onCommand = func(id int) {
		switch id {
		case idAllow:
			finish(self, Accepted)
		case idDecline:
			finish(self, Denied)
		}
	}
	w.onTimer = func() {
		left--
		if left <= 0 {
			finish(self, TimedOut)
			return
		}
		_, _, _ = pSetWindowTextW.Call(textHwnd, uintptr(unsafe.Pointer(utf16(ConsentText(req, left)))))
		// Stay in front of other windows while the question is open.
		_, _, _ = pSetWindowPos.Call(self, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
	w.onClose = func() bool {
		finish(self, Denied) // closing the dialog is a refusal
		return true
	}
	title, allow, decline := req.Labels()
	s := spec{title: title, text: ConsentText(req, left), exStyle: wsExTopmost | wsExDlgFrame, style: wsPopup | wsCaption | wsSysMenu | wsVisible, w: 560, h: 340,
		buttons: []struct {
			id    int
			label string
			def   bool
		}{{idAllow, allow, false}, {idDecline, decline, true}}}
	go runWindow(s, w, func(hwnd uintptr) {
		self = hwnd
		textHwnd, _, _ = pGetDlgItem.Call(hwnd, idText)
		hwndc <- hwnd
		if testConsentShown != nil {
			testConsentShown(hwnd)
		}
	}, func(err error) { errc <- err })

	var hwnd uintptr
	select {
	case hwnd = <-hwndc:
	case err := <-errc:
		return "", err
	case <-ctx.Done():
		return "", ctx.Err()
	}
	select {
	case a := <-answer:
		return a, nil
	case <-ctx.Done():
		finish(hwnd, Denied)
		return "", ctx.Err()
	case <-time.After(time.Duration(req.TimeoutSeconds+5) * time.Second):
		finish(hwnd, TimedOut)
		return TimedOut, nil
	}
}

func (u *winUI) ShowBanner(info BannerInfo, onEnd func()) error {
	info = info.Normalize()
	u.mu.Lock()
	old := u.banner
	u.banner = nil
	u.mu.Unlock()
	if old != nil {
		_, _, _ = pPostMessageW.Call(old.hwnd, wmAppClose, 0, 0)
	}
	b := &bannerWin{session: info.SessionID, done: make(chan struct{})}
	var once sync.Once
	w := &window{}
	w.onCommand = func(id int) {
		if id == idEnd {
			once.Do(func() {
				if onEnd != nil {
					go onEnd()
				}
			})
			_, _, _ = pPostMessageW.Call(b.hwnd, wmAppClose, 0, 0)
		}
	}
	w.onTimer = func() {
		// Re-assert "always on top" every second: another topmost window must not cover it.
		_, _, _ = pSetWindowPos.Call(b.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
	}
	w.onClose = func() bool { return false } // Alt+F4 does not hide it; End session ends the session
	h := 150
	if info.Permissions != nil {
		h = 200 // two more lines: what is allowed, in English and Arabic
	}
	s := spec{title: BannerTitle, text: BannerText(info), exStyle: wsExTopmost | wsExToolWindow, style: wsPopup | wsCaption | wsVisible, w: 620, h: h, top: true,
		buttons: []struct {
			id    int
			label string
			def   bool
		}{{idEnd, EndLabel, false}}}
	ready := make(chan error, 1)
	go func() {
		defer close(b.done)
		runWindow(s, w, func(hwnd uintptr) { b.hwnd = hwnd; ready <- nil }, func(err error) { ready <- err })
	}()
	if err := <-ready; err != nil {
		return err
	}
	u.mu.Lock()
	u.banner = b
	u.mu.Unlock()
	return nil
}

func (u *winUI) HideBanner(sessionID string) {
	u.mu.Lock()
	b := u.banner
	if b != nil && (sessionID == "" || b.session == sessionID) {
		u.banner = nil
	} else {
		b = nil
	}
	u.mu.Unlock()
	if b != nil {
		_, _, _ = pPostMessageW.Call(b.hwnd, wmAppClose, 0, 0)
		select {
		case <-b.done:
		case <-time.After(2 * time.Second):
		}
	}
}

// testConsentShown lets a test press the dialog's buttons the way a person would.
var testConsentShown func(hwnd uintptr)

// pressButton clicks a button of the current banner or a window (tests: what the user's click does).
func pressButton(hwnd uintptr, id int) {
	btn, _, _ := pGetDlgItem.Call(hwnd, uintptr(id))
	_, _, _ = pPostMessageW.Call(btn, bmClick, 0, 0)
}
