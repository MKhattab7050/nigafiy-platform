//go:build windows && (amd64 || arm64)

package audio

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// WASAPI loopback capture of the default playback device, with COM vtable calls through plain
// syscalls (no cgo). 64-bit only: IAudioClient::Initialize takes 64-bit durations by value.

var (
	ole32              = syscall.NewLazyDLL("ole32.dll")
	pCoInitializeEx    = ole32.NewProc("CoInitializeEx")
	pCoUninitialize    = ole32.NewProc("CoUninitialize")
	pCoCreateInstance  = ole32.NewProc("CoCreateInstance")
	pCoTaskMemFree     = ole32.NewProc("CoTaskMemFree")
	clsidMMDeviceEnum  = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnum   = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient    = guid{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCapture   = guid{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
	subtypeIEEEFloat   = guid{0x00000003, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
	errDeviceNotActive = errors.New("no audio playback device is active on this computer")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	CbSize         uint16
}

const (
	coinitMultithreaded   = 0x0
	clsctxAll             = 0x17
	eRender               = 0
	eConsole              = 0
	sharedMode            = 0
	streamFlagsLoopback   = 0x00020000
	bufferFlagsSilent     = 0x2
	waveFormatPCM         = 1
	waveFormatIEEEFloat   = 3
	waveFormatExtensibleT = 0xFFFE
	hrNotFound            = 0x80070490
)

// comObj is a COM interface pointer: its first word points at the vtable.
type comObj uintptr

func (o comObj) call(slot int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(ptrAt(uintptr(o)))                                   // #nosec G103 -- COM object
	fn := *(*uintptr)(ptrAt(vtbl + uintptr(slot)*unsafe.Sizeof(uintptr(0)))) // #nosec G103 -- vtable slot
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(o)}, args...)...)
	return r
}

func (o comObj) release() {
	if o != 0 {
		o.call(2)
	}
}

func hr(r uintptr, what string) error {
	if int32(r) < 0 {
		if uint32(r) == hrNotFound {
			return errDeviceNotActive
		}
		return fmt.Errorf("%s failed (HRESULT 0x%08X)", what, uint32(r))
	}
	return nil
}

type wasapiCapture struct {
	stop   chan struct{}
	done   chan struct{}
	once   sync.Once
	format Format
}

func (c *wasapiCapture) Stop() {
	c.once.Do(func() { close(c.stop) })
	<-c.done
}

func (c *wasapiCapture) Format() Format { return c.format }

func start(opts Options, onPacket func(Header, []byte)) (Capture, error) {
	c := &wasapiCapture{stop: make(chan struct{}), done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		defer close(c.done)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if err := c.run(opts, onPacket, ready); err != nil {
			select {
			case ready <- err:
			default:
			}
		}
	}()
	if err := <-ready; err != nil {
		<-c.done
		return nil, err
	}
	return c, nil
}

func (c *wasapiCapture) run(opts Options, onPacket func(Header, []byte), ready chan<- error) error {
	if r, _, _ := pCoInitializeEx.Call(0, coinitMultithreaded); int32(r) < 0 && uint32(r) != 0x80010106 { // RPC_E_CHANGED_MODE
		return fmt.Errorf("CoInitializeEx failed (0x%08X)", uint32(r))
	}
	defer pCoUninitialize.Call()

	var enum comObj
	if err := hr(pcall(pCoCreateInstance, uintptr(unsafe.Pointer(&clsidMMDeviceEnum)), 0, clsctxAll, uintptr(unsafe.Pointer(&iidIMMDeviceEnum)), uintptr(unsafe.Pointer(&enum))), "CoCreateInstance(MMDeviceEnumerator)"); err != nil {
		return err
	}
	defer enum.release()
	var dev comObj
	// IMMDeviceEnumerator::GetDefaultAudioEndpoint (slot 4)
	if err := hr(enum.call(4, eRender, eConsole, uintptr(unsafe.Pointer(&dev))), "GetDefaultAudioEndpoint"); err != nil {
		return err
	}
	defer dev.release()
	var client comObj
	// IMMDevice::Activate (slot 3)
	if err := hr(dev.call(3, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&client))), "IMMDevice::Activate"); err != nil {
		return err
	}
	defer client.release()
	var wfx *waveFormatEx
	// IAudioClient::GetMixFormat (slot 8)
	if err := hr(client.call(8, uintptr(unsafe.Pointer(&wfx))), "GetMixFormat"); err != nil {
		return err
	}
	defer pCoTaskMemFree.Call(uintptr(unsafe.Pointer(wfx)))
	f := Format{Rate: int(wfx.SamplesPerSec), Channels: int(wfx.Channels), Bits: int(wfx.BitsPerSample)}
	switch wfx.FormatTag {
	case waveFormatIEEEFloat:
		f.Float = true
	case waveFormatPCM:
	case waveFormatExtensibleT:
		// WAVEFORMATEXTENSIBLE is packed: SubFormat starts at byte 24 (Go would pad the struct).
		if wfx.CbSize >= 22 {
			sub := *(*guid)(unsafe.Add(unsafe.Pointer(wfx), 24)) // #nosec G103 -- cbSize says it is there
			f.Float = sub == subtypeIEEEFloat
		}
	default:
		return fmt.Errorf("the playback device's format (tag %d) is not supported", wfx.FormatTag)
	}
	c.format = f
	// IAudioClient::Initialize (slot 3): shared, loopback, 200 ms buffer.
	if err := hr(client.call(3, sharedMode, streamFlagsLoopback, uintptr(2_000_000), 0, uintptr(unsafe.Pointer(wfx)), 0), "IAudioClient::Initialize"); err != nil {
		return err
	}
	var capture comObj
	// IAudioClient::GetService (slot 14)
	if err := hr(client.call(14, uintptr(unsafe.Pointer(&iidIAudioCapture)), uintptr(unsafe.Pointer(&capture))), "GetService(IAudioCaptureClient)"); err != nil {
		return err
	}
	defer capture.release()
	// IAudioClient::Start (slot 10)
	if err := hr(client.call(10), "IAudioClient::Start"); err != nil {
		return err
	}
	defer client.call(11) // Stop
	outCh := min(2, f.Channels)
	if opts.Mono {
		outCh = 1
	}
	pk := NewPacketizer(f.Rate, outCh, onPacket)
	ready <- nil

	frameBytes := f.Channels * f.Bits / 8
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-c.stop:
			return nil
		case <-tick.C:
		}
		for {
			var frames uint32
			// IAudioCaptureClient::GetNextPacketSize (slot 5)
			if err := hr(capture.call(5, uintptr(unsafe.Pointer(&frames))), "GetNextPacketSize"); err != nil {
				return err
			}
			if frames == 0 {
				break
			}
			var data uintptr
			var n, flags uint32
			// IAudioCaptureClient::GetBuffer (slot 3)
			if err := hr(capture.call(3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&flags)), 0, 0), "GetBuffer"); err != nil {
				return err
			}
			size := int(n) * frameBytes
			raw := make([]byte, size)
			if flags&bufferFlagsSilent == 0 && data != 0 && size > 0 {
				copy(raw, unsafe.Slice((*byte)(ptrAt(data)), size)) // #nosec G103 -- WASAPI buffer of n frames
			}
			capture.call(4, uintptr(n)) // ReleaseBuffer
			pk.Write(ToInt16(raw, f, opts.Mono))
		}
	}
}

func pcall(p *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := p.Call(args...)
	return r
}

// ptrAt turns an address owned by COM / WASAPI (not Go memory) into a pointer.
func ptrAt(p uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&p)) // #nosec G103
}
