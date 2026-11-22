//go:build windows

package remotedesktop

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	dpiOnce                sync.Once
	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procSetCursorPos       = user32.NewProc("SetCursorPos")
	procMouseEvent         = user32.NewProc("mouse_event")
	procKeybdEvent         = user32.NewProc("keybd_event")
	procSendInput          = user32.NewProc("SendInput")
	procVkKeyScanW         = user32.NewProc("VkKeyScanW")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
)

const (
	smCxScreen        = 0
	smCyScreen        = 1
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79
	smCMonitors       = 80

	srcCopy          = 0x00CC0020
	captureBlt       = 0x40000000
	biRGB            = 0
	dibRGBColors     = 0
	inputKeyboard    = 1
	keyeventfKeyUp   = 0x0002
	keyeventfUnicode = 0x0004

	mouseeventfLeftDown   = 0x0002
	mouseeventfLeftUp     = 0x0004
	mouseeventfRightDown  = 0x0008
	mouseeventfRightUp    = 0x0010
	mouseeventfMiddleDown = 0x0020
	mouseeventfMiddleUp   = 0x0040
	mouseeventfWheel      = 0x0800
)

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type bitmapInfo struct {
	BmiHeader bitmapInfoHeader
	BmiColors [1]uint32
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

// winInput matches the Win32 INPUT struct layout on both 32-bit (28 bytes) and 64-bit (40 bytes) Windows.
type winInput struct {
	typ uint32
	ki  keybdInput
	pad [8]byte
}

func ensureDPIAware() {
	dpiOnce.Do(func() {
		_, _, _ = procSetProcessDPIAware.Call()
	})
}

func getMetric(index int) int {
	ensureDPIAware()
	r, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(r))
}

// EnumerateDisplays lists every monitor (EnumDisplayMonitors + GetMonitorInfoW, physical pixels:
// the process is DPI aware), the primary first, then the others left to right. With more than one
// monitor a last entry, All displays, covers the whole virtual screen (the bounding box of all).
func EnumerateDisplays() ([]DisplayInfo, error) {
	ensureDPIAware()
	mons, err := enumMonitors()
	if err != nil || len(mons) == 0 {
		// No monitor list (a service desktop, an old API): the primary screen from the metrics.
		w, h := getMetric(smCxScreen), getMetric(smCyScreen)
		if w <= 0 || h <= 0 {
			return nil, errors.New("unable to query Windows display dimensions")
		}
		return []DisplayInfo{{Index: 0, Name: "Display 1", Width: w, Height: h, Primary: true}}, nil
	}
	return OrderDisplays(mons), nil
}

type winRect struct{ Left, Top, Right, Bottom int32 }

// monitorInfoEx is MONITORINFOEXW.
type monitorInfoEx struct {
	CbSize    uint32
	RcMonitor winRect
	RcWork    winRect
	DwFlags   uint32
	SzDevice  [32]uint16
}

const monitorInfoPrimary = 1

var (
	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
	monMu                   sync.Mutex
	monFound                []DisplayInfo
	// One callback for the life of the process (Windows callbacks cannot be released).
	monCallback = syscall.NewCallback(func(hmon, _, _, _ uintptr) uintptr {
		mi := monitorInfoEx{CbSize: uint32(unsafe.Sizeof(monitorInfoEx{}))}
		if r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&mi))); r != 0 {
			monFound = append(monFound, DisplayInfo{
				Name:    strings.TrimPrefix(syscall.UTF16ToString(mi.SzDevice[:]), `\\.\`),
				X:       int(mi.RcMonitor.Left),
				Y:       int(mi.RcMonitor.Top),
				Width:   int(mi.RcMonitor.Right - mi.RcMonitor.Left),
				Height:  int(mi.RcMonitor.Bottom - mi.RcMonitor.Top),
				Primary: mi.DwFlags&monitorInfoPrimary != 0,
			})
		}
		return 1 // continue
	})
)

func enumMonitors() ([]DisplayInfo, error) {
	monMu.Lock()
	defer monMu.Unlock()
	monFound = nil
	r, _, e := procEnumDisplayMonitors.Call(0, 0, monCallback, 0)
	if r == 0 {
		return nil, fmt.Errorf("EnumDisplayMonitors: %v", e)
	}
	found := monFound
	monFound = nil
	return found, nil
}

func captureDisplayRGBA(disp DisplayInfo) (*image.RGBA, string, error) {
	ensureDPIAware()
	if disp.Width <= 0 || disp.Height <= 0 {
		return nil, "", errors.New("invalid display dimensions")
	}
	// Failures are reported, never papered over with a made-up picture. The usual cause is an
	// agent running as a service in session 0, which has no interactive desktop to read.
	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, "", errNoDesktop
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, "", errNoDesktop
	}
	defer procDeleteDC.Call(hdcMem)

	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, uintptr(disp.Width), uintptr(disp.Height))
	if hBitmap == 0 {
		return nil, "", errNoDesktop
	}
	defer procDeleteObject.Call(hBitmap)

	oldObj, _, _ := procSelectObject.Call(hdcMem, hBitmap)
	defer procSelectObject.Call(hdcMem, oldObj)

	ok, _, _ := procBitBlt.Call(
		hdcMem,
		0,
		0,
		uintptr(disp.Width),
		uintptr(disp.Height),
		hdcScreen,
		uintptr(disp.X),
		uintptr(disp.Y),
		uintptr(srcCopy),
	)
	if ok == 0 {
		return nil, "", errNoDesktop
	}

	var bi bitmapInfo
	bi.BmiHeader.BiSize = uint32(unsafe.Sizeof(bi.BmiHeader))
	bi.BmiHeader.BiWidth = int32(disp.Width)
	bi.BmiHeader.BiHeight = -int32(disp.Height) // top-down DIB
	bi.BmiHeader.BiPlanes = 1
	bi.BmiHeader.BiBitCount = 32
	bi.BmiHeader.BiCompression = biRGB

	img := image.NewRGBA(image.Rect(0, 0, disp.Width, disp.Height))
	lines, _, _ := procGetDIBits.Call(
		hdcMem,
		hBitmap,
		0,
		uintptr(disp.Height),
		uintptr(unsafe.Pointer(&img.Pix[0])),
		uintptr(unsafe.Pointer(&bi)),
		dibRGBColors,
	)
	if lines == 0 {
		return nil, "", errNoDesktop
	}

	// Convert BGRA to RGBA in-place.
	pix := img.Pix
	for i := 0; i < len(pix); i += 4 {
		b := pix[i]
		r := pix[i+2]
		pix[i] = r
		pix[i+2] = b
		pix[i+3] = 255
	}
	return img, "native_gdi", nil
}

func InjectInput(ev InputEvent) error {
	displays, err := EnumerateDisplays()
	if err != nil || len(displays) == 0 {
		return errors.New("no display available for input injection")
	}
	idx := ev.DisplayIndex
	if idx < 0 || idx >= len(displays) {
		idx = 0
	}
	disp := displays[idx]

	nx := ev.NormalizedX
	if nx < 0 {
		nx = 0
	} else if nx > 1 {
		nx = 1
	}
	ny := ev.NormalizedY
	if ny < 0 {
		ny = 0
	} else if ny > 1 {
		ny = 1
	}
	absX := disp.X + int(nx*float64(disp.Width))
	absY := disp.Y + int(ny*float64(disp.Height))

	switch ev.Kind {
	case "mouse_move":
		procSetCursorPos.Call(uintptr(absX), uintptr(absY))
		return nil

	case "mouse_click":
		procSetCursorPos.Call(uintptr(absX), uintptr(absY))
		down, up := mouseButtons(ev.Button)
		procMouseEvent.Call(uintptr(down), 0, 0, 0, 0)
		procMouseEvent.Call(uintptr(up), 0, 0, 0, 0)
		if ev.Double {
			time.Sleep(40 * time.Millisecond)
			procMouseEvent.Call(uintptr(down), 0, 0, 0, 0)
			procMouseEvent.Call(uintptr(up), 0, 0, 0, 0)
		}
		return nil

	case "mouse_down":
		procSetCursorPos.Call(uintptr(absX), uintptr(absY))
		down, _ := mouseButtons(ev.Button)
		procMouseEvent.Call(uintptr(down), 0, 0, 0, 0)
		return nil

	case "mouse_up":
		procSetCursorPos.Call(uintptr(absX), uintptr(absY))
		_, up := mouseButtons(ev.Button)
		procMouseEvent.Call(uintptr(up), 0, 0, 0, 0)
		return nil

	case "mouse_wheel":
		procSetCursorPos.Call(uintptr(absX), uintptr(absY))
		delta := int32(ev.DeltaY)
		procMouseEvent.Call(uintptr(mouseeventfWheel), 0, 0, uintptr(uint32(delta)), 0)
		return nil

	case "key_press":
		vk := mapKeyToVK(ev.Key)
		if vk == 0 {
			return fmt.Errorf("unsupported key: %s", ev.Key)
		}
		if ev.Ctrl {
			procKeybdEvent.Call(0x11, 0, 0, 0)
		}
		if ev.Alt {
			procKeybdEvent.Call(0x12, 0, 0, 0)
		}
		if ev.Shift {
			procKeybdEvent.Call(0x10, 0, 0, 0)
		}
		procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
		procKeybdEvent.Call(uintptr(vk), 0, keyeventfKeyUp, 0)
		if ev.Shift {
			procKeybdEvent.Call(0x10, 0, keyeventfKeyUp, 0)
		}
		if ev.Alt {
			procKeybdEvent.Call(0x12, 0, keyeventfKeyUp, 0)
		}
		if ev.Ctrl {
			procKeybdEvent.Call(0x11, 0, keyeventfKeyUp, 0)
		}
		return nil

	case "text":
		for _, r := range ev.Text {
			sendRune(r)
		}
		return nil

	default:
		return fmt.Errorf("unknown input event kind: %s", ev.Kind)
	}
}

func mouseButtons(btn string) (uint32, uint32) {
	switch strings.ToLower(btn) {
	case "right":
		return mouseeventfRightDown, mouseeventfRightUp
	case "middle":
		return mouseeventfMiddleDown, mouseeventfMiddleUp
	default:
		return mouseeventfLeftDown, mouseeventfLeftUp
	}
}

func buildUnicodeInputs(r rune) []winInput {
	units := utf16.Encode([]rune{r})
	inputs := make([]winInput, 0, len(units)*2)
	for _, u := range units {
		inputs = append(inputs,
			winInput{
				typ: inputKeyboard,
				ki: keybdInput{
					wScan:   u,
					dwFlags: keyeventfUnicode,
				},
			},
			winInput{
				typ: inputKeyboard,
				ki: keybdInput{
					wScan:   u,
					dwFlags: keyeventfUnicode | keyeventfKeyUp,
				},
			},
		)
	}
	return inputs
}

func sendUnicodeRune(r rune) {
	inputs := buildUnicodeInputs(r)
	if len(inputs) == 0 {
		return
	}
	_, _, _ = procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
}

func sendRune(r rune) {
	if r < 0 || r > 0xffff {
		sendUnicodeRune(r)
		return
	}
	res, _, _ := procVkKeyScanW.Call(uintptr(uint16(r)))
	v := int16(res)
	shiftState := byte((v >> 8) & 0xff)
	if v == -1 || (shiftState&6) != 0 {
		sendUnicodeRune(r)
		return
	}
	vk := byte(v & 0xff)
	if shiftState&1 != 0 {
		procKeybdEvent.Call(0x10, 0, 0, 0)
	}
	procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
	procKeybdEvent.Call(uintptr(vk), 0, keyeventfKeyUp, 0)
	if shiftState&1 != 0 {
		procKeybdEvent.Call(0x10, 0, keyeventfKeyUp, 0)
	}
}

func mapKeyToVK(k string) byte {
	switch strings.ToLower(strings.TrimSpace(k)) {
	case "enter", "return":
		return 0x0D
	case "backspace":
		return 0x08
	case "tab":
		return 0x09
	case "escape", "esc":
		return 0x1B
	case "space", " ":
		return 0x20
	case "delete", "del":
		return 0x2E
	case "home":
		return 0x24
	case "end":
		return 0x23
	case "pageup":
		return 0x21
	case "pagedown":
		return 0x22
	case "arrowleft", "left":
		return 0x25
	case "arrowup", "up":
		return 0x26
	case "arrowright", "right":
		return 0x27
	case "arrowdown", "down":
		return 0x28
	case "f1":
		return 0x70
	case "f2":
		return 0x71
	case "f3":
		return 0x72
	case "f4":
		return 0x73
	case "f5":
		return 0x74
	case "f6":
		return 0x75
	case "f7":
		return 0x76
	case "f8":
		return 0x77
	case "f9":
		return 0x78
	case "f10":
		return 0x79
	case "f11":
		return 0x7A
	case "f12":
		return 0x7B
	case ";":
		return 0xBA
	case "=":
		return 0xBB
	case ",":
		return 0xBC
	case "-":
		return 0xBD
	case ".":
		return 0xBE
	case "/":
		return 0xBF
	case "`":
		return 0xC0
	case "[":
		return 0xDB
	case `\`:
		return 0xDC
	case "]":
		return 0xDD
	case "'":
		return 0xDE
	}
	if len(k) == 1 {
		ch := strings.ToUpper(k)[0]
		if (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
			return ch
		}
	}
	return 0
}

// Backend names the capture/input mechanism.
func Backend() string { return "gdi" }

// Permissions: Windows has no per-app screen privacy permission.
func Permissions() map[string]string { return nil }
