//go:build windows

package inputblock

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	pSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	pUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	pCallNextHookEx      = user32.NewProc("CallNextHookEx")
	pGetMessageW         = user32.NewProc("GetMessageW")
	pPostThreadMessageW  = user32.NewProc("PostThreadMessageW")
	pGetCurrentThreadId  = kernel32.NewProc("GetCurrentThreadId")
	pGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
)

const (
	whKeyboardLL   = 13
	whMouseLL      = 14
	hcAction       = 0
	wmKeyDown      = 0x0100
	wmKeyUp        = 0x0101
	wmSysKeyDown   = 0x0104
	wmSysKeyUp     = 0x0105
	wmQuit         = 0x0012
	llkhfInjected  = 0x10
	llmhfInjected  = 0x01
	llkhfLowerIL   = 0x02 // injected from a lower integrity level: still injected
	llmhfLowerIL   = 0x02
	injectedKbMask = llkhfInjected | llkhfLowerIL
	injectedMsMask = llmhfInjected | llmhfLowerIL
)

type kbdLLHookStruct struct {
	vkCode      uint32
	scanCode    uint32
	flags       uint32
	time        uint32
	dwExtraInfo uintptr
}

type msLLHookStruct struct {
	x, y        int32
	mouseData   uint32
	flags       uint32
	time        uint32
	dwExtraInfo uintptr
}

// One block at a time per process (hooks are global to the desktop anyway).
var (
	mu      sync.Mutex
	current *winBlocker
	// The callbacks live for the process (Windows callbacks cannot be released).
	kbProc = syscall.NewCallback(keyboardProc)
	msProc = syscall.NewCallback(mouseProc)
)

type winBlocker struct {
	thread uint32
	done   chan struct{}
	once   sync.Once
	combo  Combo
	onEnd  func()
}

func keyboardProc(nCode int, wParam, lParam uintptr) uintptr {
	if nCode == hcAction {
		mu.Lock()
		b := current
		mu.Unlock()
		if b != nil {
			k := (*kbdLLHookStruct)(unsafe.Pointer(lParam)) // #nosec G103 -- the hook's own struct
			if k.flags&injectedKbMask == 0 {
				down := wParam == wmKeyDown || wParam == wmSysKeyDown
				if b.combo.Key(k.vkCode, down) && b.onEnd != nil {
					go b.onEnd()
				}
				return 1 // the person's key never reaches a program
			}
		}
	}
	r, _, _ := pCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
	return r
}

func mouseProc(nCode int, wParam, lParam uintptr) uintptr {
	if nCode == hcAction {
		mu.Lock()
		b := current
		mu.Unlock()
		if b != nil {
			m := (*msLLHookStruct)(unsafe.Pointer(lParam)) // #nosec G103 -- the hook's own struct
			if m.flags&injectedMsMask == 0 {
				return 1
			}
		}
	}
	r, _, _ := pCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
	return r
}

func start(onEnd func()) (Blocker, error) {
	mu.Lock()
	if current != nil {
		mu.Unlock()
		return nil, fmt.Errorf("input is already blocked")
	}
	b := &winBlocker{done: make(chan struct{}), onEnd: onEnd}
	current = b
	mu.Unlock()

	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(b.done)
		tid, _, _ := pGetCurrentThreadId.Call()
		b.thread = uint32(tid)
		hInst, _, _ := pGetModuleHandleW.Call(0)
		kh, _, err := pSetWindowsHookExW.Call(whKeyboardLL, kbProc, hInst, 0)
		if kh == 0 {
			ready <- fmt.Errorf("SetWindowsHookEx(keyboard): %v", err)
			return
		}
		mh, _, err := pSetWindowsHookExW.Call(whMouseLL, msProc, hInst, 0)
		if mh == 0 {
			_, _, _ = pUnhookWindowsHookEx.Call(kh)
			ready <- fmt.Errorf("SetWindowsHookEx(mouse): %v", err)
			return
		}
		ready <- nil
		// Low-level hooks are called through this thread's message loop.
		var m [48]byte
		for {
			r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m[0])), 0, 0, 0)
			if int32(r) <= 0 {
				break
			}
		}
		_, _, _ = pUnhookWindowsHookEx.Call(mh)
		_, _, _ = pUnhookWindowsHookEx.Call(kh)
	}()
	if err := <-ready; err != nil {
		mu.Lock()
		current = nil
		mu.Unlock()
		return nil, err
	}
	return b, nil
}

func (b *winBlocker) Stop() {
	b.once.Do(func() {
		mu.Lock()
		if current == b {
			current = nil
		}
		mu.Unlock()
		_, _, _ = pPostThreadMessageW.Call(uintptr(b.thread), wmQuit, 0, 0)
		<-b.done
	})
}
