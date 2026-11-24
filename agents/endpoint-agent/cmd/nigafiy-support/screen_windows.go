//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var pMessageBoxW = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")

const (
	mbOK          = 0x0
	mbIconInfo    = 0x40
	mbIconError   = 0x10
	mbTopmost     = 0x40000
	mbSetForegrnd = 0x10000
)

func messageBox(caption, text string, flags uintptr) {
	_, _, _ = pMessageBoxW.Call(0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(text))), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(caption))), flags)
}

// showCode blocks until the person closes the window.
func showCode(caption, text string) {
	messageBox(caption, text, mbOK|mbIconInfo|mbTopmost|mbSetForegrnd)
}

func showError(caption, text string) { messageBox(caption, text, mbOK|mbIconError|mbTopmost) }

// removeSelf: a running program cannot delete its own file, so a hidden cmd waits until this
// process has exited and then deletes it.
func removeSelf(exe string) {
	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = `C:\Windows\System32\cmd.exe`
	}
	cmd := exec.Command(shell)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CmdLine:       `/d /c ping -n 3 127.0.0.1 >nul & del /f /q "` + exe + `"`,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
	_ = cmd.Start()
}
