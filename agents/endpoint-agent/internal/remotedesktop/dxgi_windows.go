package remotedesktop

// Screen capture through DXGI Desktop Duplication (Windows 8+), without cgo.
//
// GDI (BitBlt from the screen DC) copies the whole desktop back from the graphics card on every
// picture: 23 ms of the 27 ms a 1080p capture took on the owner's PC (2026-11-27), which held the
// computer's screen on a phone to 9–15 pictures a second. Desktop Duplication hands over the
// desktop the compositor already drew, as a GPU texture; one copy into a CPU-readable texture
// costs a millisecond or two, and when nothing changed there is nothing to copy at all.
//
// Sources: the Windows SDK headers dxgi.h, dxgi1_2.h and d3d11.h for the vtable orders, IIDs,
// structs and constants; MSDN "Desktop Duplication API", IDXGIOutputDuplication::AcquireNextFrame
// (DXGI_ERROR_WAIT_TIMEOUT when the desktop did not change, DXGI_ERROR_ACCESS_LOST when the
// duplication must be made again: a mode change, the secure desktop, a full-screen game) and
// ReleaseFrame (before the next AcquireNextFrame).
//
// Anything DXGI cannot do (no duplication on this output, a rotated screen, Remote Desktop
// sessions on some systems, the UAC desktop) falls back to GDI for that picture, so capture never
// gets worse than it was. NIGAFIY_RD_GDI=1 turns DXGI off.

import (
	"errors"
	"fmt"
	"image"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/nigafiy/agent/internal/par"
)

var (
	modDXGI                = windows.NewLazySystemDLL("dxgi.dll")
	procCreateDXGIFactory1 = modDXGI.NewProc("CreateDXGIFactory1")
	modD3D11               = windows.NewLazySystemDLL("d3d11.dll")
	procD3D11CreateDevice  = modD3D11.NewProc("D3D11CreateDevice")
)

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	iidIDXGIFactory1   = mustGUID("{770aae78-f26f-4dba-a829-253c83d1b387}")
	iidIDXGIOutput1    = mustGUID("{00cddea8-939b-4b83-a340-a685226666cc}")
	iidID3D11Texture2D = mustGUID("{6f15aaf2-d208-4e89-9ab4-489535d34f9c}")
)

// Vtable slots (SDK header order; IUnknown 0–2, IDXGIObject 3–6, ID3D11DeviceChild 3–6).
const (
	vtQueryInterface = 0
	vtRelease        = 2
	// IDXGIFactory
	vtFactoryEnumAdapters = 7
	// IDXGIAdapter
	vtAdapterEnumOutputs = 7
	// IDXGIOutput
	vtOutputGetDesc = 7
	// IDXGIOutput1
	vtOutput1DuplicateOutput = 22
	// IDXGIOutputDuplication
	vtDuplAcquireNextFrame = 8
	vtDuplReleaseFrame     = 14
	// ID3D11Device
	vtDeviceCreateTexture2D = 5
	// ID3D11DeviceContext
	vtCtxMap          = 14
	vtCtxUnmap        = 15
	vtCtxCopyResource = 47
	// ID3D11Texture2D
	vtTexGetDesc = 10
)

const (
	d3dDriverTypeUnknown   = 0
	d3d11SDKVersion        = 7
	d3d11CreateBGRASupport = 0x20
	dxgiFormatB8G8R8A8     = 87
	d3d11UsageStaging      = 3
	d3d11CPUAccessRead     = 0x20000
	d3d11MapRead           = 1
	dxgiRotationIdentity   = 1

	hrWaitTimeout = 0x887A0027
	hrAccessLost  = 0x887A0026
	hrNotFound    = 0x887A0002
)

// dxgiOutputDesc is DXGI_OUTPUT_DESC.
type dxgiOutputDesc struct {
	DeviceName [32]uint16
	Left       int32
	Top        int32
	Right      int32
	Bottom     int32
	Attached   int32
	Rotation   uint32
	Monitor    uintptr
}

// dxgiFrameInfo is DXGI_OUTDUPL_FRAME_INFO (48 bytes; padded for safety).
type dxgiFrameInfo struct {
	LastPresentTime     int64
	LastMouseUpdateTime int64
	AccumulatedFrames   uint32
	RectsCoalesced      int32
	ProtectedMasked     int32
	PointerX, PointerY  int32
	PointerVisible      int32
	TotalMetadataSize   uint32
	PointerShapeSize    uint32
	_                   [16]byte
}

// d3d11Texture2DDesc is D3D11_TEXTURE2D_DESC.
type d3d11Texture2DDesc struct {
	Width, Height, MipLevels, ArraySize, Format uint32
	SampleCount, SampleQuality                  uint32
	Usage, BindFlags, CPUAccessFlags, MiscFlags uint32
}

// d3d11Mapped is D3D11_MAPPED_SUBRESOURCE.
type d3d11Mapped struct {
	Data       unsafe.Pointer
	RowPitch   uint32
	DepthPitch uint32
}

func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uint32 {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return uint32(r)
}

func comRelease(obj *unsafe.Pointer) {
	if *obj != nil {
		comCall(*obj, vtRelease)
		*obj = nil
	}
}

func hrErr(what string, hr uint32) error {
	if int32(hr) >= 0 {
		return nil
	}
	return fmt.Errorf("dxgi %s: 0x%08X", what, hr)
}

// duplicator is one output's Desktop Duplication with its device and the CPU copy of the picture.
type duplicator struct {
	rect    image.Rectangle
	device  unsafe.Pointer
	ctx     unsafe.Pointer
	dupl    unsafe.Pointer
	staging unsafe.Pointer
	w, h    int
	// last: the newest picture (RGBA), handed out as a copy when the desktop did not change.
	last *image.RGBA
}

func (d *duplicator) close() {
	comRelease(&d.staging)
	comRelease(&d.dupl)
	comRelease(&d.ctx)
	comRelease(&d.device)
}

// openDuplicator finds the output covering rect and starts duplicating it.
func openDuplicator(rect image.Rectangle) (*duplicator, error) {
	if err := procCreateDXGIFactory1.Find(); err != nil {
		return nil, err
	}
	var factory unsafe.Pointer
	if hr, _, _ := procCreateDXGIFactory1.Call(uintptr(unsafe.Pointer(&iidIDXGIFactory1)), uintptr(unsafe.Pointer(&factory))); int32(hr) < 0 {
		return nil, hrErr("CreateDXGIFactory1", uint32(hr))
	}
	defer comRelease(&factory)
	for a := uint32(0); ; a++ {
		var adapter unsafe.Pointer
		if hr := comCall(factory, vtFactoryEnumAdapters, uintptr(a), uintptr(unsafe.Pointer(&adapter))); hr == hrNotFound {
			break
		} else if err := hrErr("EnumAdapters", hr); err != nil {
			return nil, err
		}
		d, err := openOnAdapter(adapter, rect)
		comRelease(&adapter)
		if d != nil || err != nil {
			return d, err
		}
	}
	return nil, errors.New("dxgi: no output covers this display")
}

func openOnAdapter(adapter unsafe.Pointer, rect image.Rectangle) (*duplicator, error) {
	for o := uint32(0); ; o++ {
		var output unsafe.Pointer
		if hr := comCall(adapter, vtAdapterEnumOutputs, uintptr(o), uintptr(unsafe.Pointer(&output))); hr == hrNotFound {
			return nil, nil
		} else if err := hrErr("EnumOutputs", hr); err != nil {
			return nil, err
		}
		var desc dxgiOutputDesc
		comCall(output, vtOutputGetDesc, uintptr(unsafe.Pointer(&desc)))
		r := image.Rect(int(desc.Left), int(desc.Top), int(desc.Right), int(desc.Bottom))
		if r != rect {
			comRelease(&output)
			continue
		}
		defer comRelease(&output)
		if desc.Rotation > dxgiRotationIdentity {
			return nil, errors.New("dxgi: rotated screen (GDI handles it)")
		}
		d := &duplicator{rect: rect}
		var level uint32
		if hr, _, _ := procD3D11CreateDevice.Call(uintptr(adapter), d3dDriverTypeUnknown, 0, d3d11CreateBGRASupport, 0, 0, d3d11SDKVersion,
			uintptr(unsafe.Pointer(&d.device)), uintptr(unsafe.Pointer(&level)), uintptr(unsafe.Pointer(&d.ctx))); int32(hr) < 0 {
			return nil, hrErr("D3D11CreateDevice", uint32(hr))
		}
		var output1 unsafe.Pointer
		if err := hrErr("QueryInterface(IDXGIOutput1)", comCall(output, vtQueryInterface, uintptr(unsafe.Pointer(&iidIDXGIOutput1)), uintptr(unsafe.Pointer(&output1)))); err != nil {
			d.close()
			return nil, err
		}
		hr := comCall(output1, vtOutput1DuplicateOutput, uintptr(d.device), uintptr(unsafe.Pointer(&d.dupl)))
		comRelease(&output1)
		if err := hrErr("DuplicateOutput", hr); err != nil {
			d.close()
			return nil, err
		}
		return d, nil
	}
}

// grab returns the current desktop picture (a new image the caller may draw on). changed is false
// when the desktop is the same as last time.
func (d *duplicator) grab() (img *image.RGBA, changed bool, err error) {
	var info dxgiFrameInfo
	var res unsafe.Pointer
	// No wait: the stream paces itself; "nothing new" is answered with the last picture.
	timeout := uintptr(0)
	if d.last == nil {
		timeout = 500 // the first frame after DuplicateOutput comes at once; allow for a slow start
	}
	hr := comCall(d.dupl, vtDuplAcquireNextFrame, timeout, uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&res)))
	if hr == hrWaitTimeout {
		if d.last == nil {
			return nil, false, errors.New("dxgi: no first frame")
		}
		return cloneRGBA(d.last), false, nil
	}
	if err := hrErr("AcquireNextFrame", hr); err != nil {
		return nil, false, err
	}
	defer comCall(d.dupl, vtDuplReleaseFrame)
	defer comRelease(&res)
	if info.LastPresentTime == 0 && d.last != nil {
		// Only the pointer moved (the agent draws the pointer itself).
		return cloneRGBA(d.last), false, nil
	}
	var tex unsafe.Pointer
	if err := hrErr("QueryInterface(ID3D11Texture2D)", comCall(res, vtQueryInterface, uintptr(unsafe.Pointer(&iidID3D11Texture2D)), uintptr(unsafe.Pointer(&tex)))); err != nil {
		return nil, false, err
	}
	defer comRelease(&tex)
	var desc d3d11Texture2DDesc
	comCall(tex, vtTexGetDesc, uintptr(unsafe.Pointer(&desc)))
	if desc.Format != dxgiFormatB8G8R8A8 {
		return nil, false, fmt.Errorf("dxgi: desktop format %d (GDI handles it)", desc.Format)
	}
	if d.staging == nil || d.w != int(desc.Width) || d.h != int(desc.Height) {
		comRelease(&d.staging)
		sd := d3d11Texture2DDesc{Width: desc.Width, Height: desc.Height, MipLevels: 1, ArraySize: 1, Format: dxgiFormatB8G8R8A8,
			SampleCount: 1, Usage: d3d11UsageStaging, CPUAccessFlags: d3d11CPUAccessRead}
		if err := hrErr("CreateTexture2D", comCall(d.device, vtDeviceCreateTexture2D, uintptr(unsafe.Pointer(&sd)), 0, uintptr(unsafe.Pointer(&d.staging)))); err != nil {
			return nil, false, err
		}
		d.w, d.h = int(desc.Width), int(desc.Height)
	}
	comCall(d.ctx, vtCtxCopyResource, uintptr(d.staging), uintptr(tex))
	var m d3d11Mapped
	if err := hrErr("Map", comCall(d.ctx, vtCtxMap, uintptr(d.staging), 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&m)))); err != nil {
		return nil, false, err
	}
	out := image.NewRGBA(image.Rect(0, 0, d.w, d.h))
	src := unsafe.Slice((*byte)(m.Data), int(m.RowPitch)*d.h)
	pitch, w := int(m.RowPitch), d.w
	par.Rows(d.h, func(lo, hi int) {
		for y := lo; y < hi; y++ {
			s := src[y*pitch : y*pitch+w*4]
			o := out.Pix[y*out.Stride : y*out.Stride+w*4]
			for i := 0; i < len(s); i += 4 {
				o[i], o[i+1], o[i+2], o[i+3] = s[i+2], s[i+1], s[i], 255
			}
		}
	})
	comCall(d.ctx, vtCtxUnmap, uintptr(d.staging), 0)
	d.last = out
	return cloneRGBA(out), true, nil
}

func cloneRGBA(img *image.RGBA) *image.RGBA {
	out := &image.RGBA{Pix: make([]byte, len(img.Pix)), Stride: img.Stride, Rect: img.Rect}
	par.Rows(img.Rect.Dy(), func(lo, hi int) {
		copy(out.Pix[lo*img.Stride:hi*img.Stride], img.Pix[lo*img.Stride:hi*img.Stride])
	})
	return out
}

// dxgiCapture keeps one duplicator per display. Every DXGI call runs under mu (the immediate
// context is not thread-safe, and the JPEG stream and the video can both capture).
var dxgiCapture struct {
	mu    sync.Mutex
	dups  map[image.Rectangle]*duplicator
	off   map[image.Rectangle]time.Time // a display DXGI failed on: GDI until then
	never bool
}

// dxgiRetry: after DXGI fails on a display, GDI captures it for this long before DXGI is tried
// again (the UAC desktop or a full-screen game usually ends by then).
const dxgiRetry = 5 * time.Second

// captureDXGI captures disp with Desktop Duplication; ok false means use GDI for this picture.
func captureDXGI(disp DisplayInfo) (*image.RGBA, bool) {
	c := &dxgiCapture
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.never || os.Getenv("NIGAFIY_RD_GDI") == "1" {
		return nil, false
	}
	if c.dups == nil {
		c.dups = map[image.Rectangle]*duplicator{}
		c.off = map[image.Rectangle]time.Time{}
		if procD3D11CreateDevice.Find() != nil || procCreateDXGIFactory1.Find() != nil {
			c.never = true // Windows 7 or older
			return nil, false
		}
	}
	rect := image.Rect(disp.X, disp.Y, disp.X+disp.Width, disp.Y+disp.Height)
	if until, bad := c.off[rect]; bad && time.Now().Before(until) {
		return nil, false
	}
	for attempt := 0; attempt < 2; attempt++ {
		d := c.dups[rect]
		if d == nil {
			var err error
			if d, err = openDuplicator(rect); err != nil || d == nil {
				c.off[rect] = time.Now().Add(dxgiRetry)
				return nil, false
			}
			c.dups[rect] = d
		}
		img, _, err := d.grab()
		if err == nil {
			if img.Rect.Dx() != disp.Width || img.Rect.Dy() != disp.Height {
				// DPI virtualisation or a mode change mid-way: GDI's picture matches the coordinates.
				d.close()
				delete(c.dups, rect)
				c.off[rect] = time.Now().Add(dxgiRetry)
				return nil, false
			}
			return img, true
		}
		// Lost (mode change, secure desktop) or broken: make it again once, then fall back.
		d.close()
		delete(c.dups, rect)
	}
	c.off[rect] = time.Now().Add(dxgiRetry)
	return nil, false
}
