//go:build windows

package remotedesktop

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procGetDC            = user32.NewProc("GetDC")
	procReleaseDC        = user32.NewProc("ReleaseDC")
	procSetCursorPos     = user32.NewProc("SetCursorPos")
	procMouseEvent       = user32.NewProc("mouse_event")
	procKeybdEvent       = user32.NewProc("keybd_event")
	procVkKeyScanW       = user32.NewProc("VkKeyScanW")

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

	srcCopy        = 0x00CC0020
	captureBlt     = 0x40000000
	biRGB          = 0
	dibRGBColors   = 0
	keyeventfKeyUp = 0x0002

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

func getMetric(index int) int {
	r, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(r))
}

func EnumerateDisplays() ([]DisplayInfo, error) {
	primaryW := getMetric(smCxScreen)
	primaryH := getMetric(smCyScreen)
	if primaryW <= 0 || primaryH <= 0 {
		return nil, errors.New("unable to query Windows display dimensions")
	}
	monitors := getMetric(smCMonitors)
	displays := []DisplayInfo{
		{
			Index:   0,
			Name:    "Primary Display (1)",
			X:       0,
			Y:       0,
			Width:   primaryW,
			Height:  primaryH,
			Primary: true,
		},
	}
	virtW := getMetric(smCxVirtualScreen)
	virtH := getMetric(smCyVirtualScreen)
	virtX := getMetric(smXVirtualScreen)
	virtY := getMetric(smYVirtualScreen)
	if monitors > 1 && (virtW > primaryW || virtH > primaryH) {
		displays = append(displays, DisplayInfo{
			Index:   1,
			Name:    fmt.Sprintf("All Displays Combined (%d monitors)", monitors),
			X:       virtX,
			Y:       virtY,
			Width:   virtW,
			Height:  virtH,
			Primary: false,
		})
	}
	return displays, nil
}

func captureDisplayRGBA(disp DisplayInfo) (*image.RGBA, string, error) {
	if disp.Width <= 0 || disp.Height <= 0 {
		return nil, "", errors.New("invalid display dimensions")
	}
	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return renderDiagnosticDesktopRGBA(disp), "session0_fallback", nil
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return renderDiagnosticDesktopRGBA(disp), "session0_fallback", nil
	}
	defer procDeleteDC.Call(hdcMem)

	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, uintptr(disp.Width), uintptr(disp.Height))
	if hBitmap == 0 {
		return renderDiagnosticDesktopRGBA(disp), "session0_fallback", nil
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
		return renderDiagnosticDesktopRGBA(disp), "session0_fallback", nil
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
		return renderDiagnosticDesktopRGBA(disp), "session0_fallback", nil
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

func sendRune(r rune) {
	res, _, _ := procVkKeyScanW.Call(uintptr(uint16(r)))
	v := int16(res)
	if v == -1 {
		return
	}
	vk := byte(v & 0xff)
	shiftState := byte((v >> 8) & 0xff)
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
	}
	if len(k) == 1 {
		ch := strings.ToUpper(k)[0]
		if (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
			return ch
		}
	}
	return 0
}
