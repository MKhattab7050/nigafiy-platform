//go:build windows

package remotedesktop

import (
	"image"
	"sync"
	"unsafe"
)

// The remote cursor drawn into the picture (Fleet Pro "show remote cursor"). GDI screen capture
// does not include the pointer, so it is rendered here: DrawIconEx onto black and onto white,
// alpha = 255 - (white - black), colour = black / alpha. Shapes are cached per cursor handle.

var (
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
	procDrawIconEx    = user32.NewProc("DrawIconEx")
	procCreateSolid   = gdi32.NewProc("CreateSolidBrush")
	procFillRect      = user32.NewProc("FillRect")
	cursorMu          sync.Mutex
	cursorCache       = map[uintptr]*cursorShape{}
)

type cursorInfo struct {
	cbSize  uint32
	flags   uint32
	hCursor uintptr
	x, y    int32
}

type iconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  uintptr
	hbmColor uintptr
}

type cursorShape struct {
	img    *image.NRGBA
	hx, hy int
}

const cursorShowing = 0x1

func renderCursor(h uintptr) *cursorShape {
	cursorMu.Lock()
	defer cursorMu.Unlock()
	if c, ok := cursorCache[h]; ok {
		return c
	}
	if len(cursorCache) > 64 {
		clear(cursorCache)
	}
	var ii iconInfo
	if r, _, _ := procGetIconInfo.Call(h, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return nil
	}
	if ii.hbmMask != 0 {
		defer procDeleteObject.Call(ii.hbmMask)
	}
	if ii.hbmColor != 0 {
		defer procDeleteObject.Call(ii.hbmColor)
	}
	size := getMetric(13) // SM_CXCURSOR
	if size <= 0 || size > 256 {
		size = 32
	}
	render := func(bg uint32) []byte {
		hdcScreen, _, _ := procGetDC.Call(0)
		defer procReleaseDC.Call(0, hdcScreen)
		hdc, _, _ := procCreateCompatibleDC.Call(hdcScreen)
		defer procDeleteDC.Call(hdc)
		bmp, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, uintptr(size), uintptr(size))
		defer procDeleteObject.Call(bmp)
		old, _, _ := procSelectObject.Call(hdc, bmp)
		defer procSelectObject.Call(hdc, old)
		brush, _, _ := procCreateSolid.Call(uintptr(bg))
		rect := [4]int32{0, 0, int32(size), int32(size)}
		procFillRect.Call(hdc, uintptr(unsafe.Pointer(&rect)), brush)
		procDeleteObject.Call(brush)
		procDrawIconEx.Call(hdc, 0, 0, h, uintptr(size), uintptr(size), 0, 0, 3) // DI_NORMAL
		var bi bitmapInfo
		bi.BmiHeader.BiSize = uint32(unsafe.Sizeof(bi.BmiHeader))
		bi.BmiHeader.BiWidth = int32(size)
		bi.BmiHeader.BiHeight = -int32(size)
		bi.BmiHeader.BiPlanes = 1
		bi.BmiHeader.BiBitCount = 32
		out := make([]byte, size*size*4)
		procGetDIBits.Call(hdc, bmp, 0, uintptr(size), uintptr(unsafe.Pointer(&out[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors)
		return out
	}
	black, white := render(0x000000), render(0xFFFFFF)
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for i := 0; i < size*size; i++ {
		var a int
		for c := 0; c < 3; c++ {
			a = max(a, 255-(int(white[i*4+c])-int(black[i*4+c])))
		}
		a = max(0, min(255, a))
		o := i * 4
		if a > 0 {
			img.Pix[o] = uint8(min(255, int(black[i*4+2])*255/a))
			img.Pix[o+1] = uint8(min(255, int(black[i*4+1])*255/a))
			img.Pix[o+2] = uint8(min(255, int(black[i*4])*255/a))
		}
		img.Pix[o+3] = uint8(a)
	}
	c := &cursorShape{img: img, hx: int(ii.xHotspot), hy: int(ii.yHotspot)}
	cursorCache[h] = c
	return c
}

// drawCursor blends the pointer into a captured picture of disp; false when it is hidden or
// elsewhere.
func drawCursor(img *image.RGBA, disp DisplayInfo) bool {
	ci := cursorInfo{cbSize: uint32(unsafe.Sizeof(cursorInfo{}))}
	if r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 || ci.flags&cursorShowing == 0 || ci.hCursor == 0 {
		return false
	}
	shape := renderCursor(ci.hCursor)
	if shape == nil {
		return false
	}
	BlendCursor(img, shape.img, int(ci.x)-disp.X-shape.hx, int(ci.y)-disp.Y-shape.hy)
	return true
}

// CursorSupported: the remote cursor can be drawn into the picture here.
const CursorSupported = true
