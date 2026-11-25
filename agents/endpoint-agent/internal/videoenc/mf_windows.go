package videoenc

// Windows Media Foundation H.264 encoder MFT through COM, without cgo.
//
// Sources: the Media Foundation SDK headers (mfapi.h, mftransform.h, mfobjects.h, codecapi.h,
// strmif.h) for the vtable orders, GUIDs and constants; the MSDN pages "H.264 Video Encoder"
// (CLSID_MSH264EncoderMFT, input NV12/I420/YUY2/IYUV, output type set before the input type),
// "Hardware MFTs" (MF_TRANSFORM_ASYNC_UNLOCK, METransformNeedInput / METransformHaveOutput) and
// "Basic MFT Processing Model" (ProcessInput / ProcessOutput / MF_E_TRANSFORM_NEED_MORE_INPUT,
// MF_E_TRANSFORM_STREAM_CHANGE).
//
// Every COM call runs on one locked OS thread per encoder (initialised for the multithreaded
// apartment), so Go's scheduler cannot move it between threads.

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modMfplat                = windows.NewLazySystemDLL("mfplat.dll")
	procMFStartup            = modMfplat.NewProc("MFStartup")
	procMFTEnumEx            = modMfplat.NewProc("MFTEnumEx")
	procMFCreateMediaType    = modMfplat.NewProc("MFCreateMediaType")
	procMFCreateSample       = modMfplat.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer = modMfplat.NewProc("MFCreateMemoryBuffer")
	modOle32                 = windows.NewLazySystemDLL("ole32.dll")
	procCoInitializeEx       = modOle32.NewProc("CoInitializeEx")
	procCoUninitialize       = modOle32.NewProc("CoUninitialize")
	procCoTaskMemFree        = modOle32.NewProc("CoTaskMemFree")
)

func guid(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	mftCategoryVideoEncoder = guid("{f79eac7d-e545-4387-bdee-d647d7bde42a}")
	mfMediaTypeVideo        = guid("{73646976-0000-0010-8000-00AA00389B71}")
	mfVideoFormatH264       = guid("{34363248-0000-0010-8000-00AA00389B71}")
	mfVideoFormatNV12       = guid("{3231564E-0000-0010-8000-00AA00389B71}")
	mfMTMajorType           = guid("{48eba18e-f8c9-4687-bf11-0a74c9f96a8f}")
	mfMTSubtype             = guid("{f7e34c9a-42e8-4714-b74b-cb29d72c35e5}")
	mfMTAvgBitrate          = guid("{20332624-fb0d-4d9e-bd0d-cbf6786c102e}")
	mfMTInterlaceMode       = guid("{e2724bb8-e676-4806-b4b2-a8d6efb44ccd}")
	mfMTFrameSize           = guid("{1652c33d-d6b2-4012-b834-72030849a37d}")
	mfMTFrameRate           = guid("{c459a2e8-3d2c-4e44-b132-fee5156c7bb0}")
	mfMTPixelAspectRatio    = guid("{c6376a1e-8d0a-4027-be45-6d9a0ad39bb6}")
	mfMTMpeg2Profile        = guid("{ad76a80b-2d5c-4e0b-b375-64e520137036}")
	mfMTMpegSequenceHeader  = guid("{3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3}")
	mfTransformAsync        = guid("{f81a699a-649a-497d-8c73-29f8fed6ad7a}")
	mfTransformAsyncUnlock  = guid("{e5666d6b-3422-4eb6-a421-da7db1f8e207}")
	mfLowLatency            = guid("{9c27891a-ed7a-40e1-88e8-b22727a024ee}")
	mftFriendlyName         = guid("{314ffbae-5b41-4c95-9c19-4e7d586face3}")
	codecAPIMeanBitRate     = guid("{f7222374-2144-4815-b550-a37f8e12ee52}")
	codecAPIGOPSize         = guid("{95f31b26-95a4-41aa-9303-246a7fc6eef1}")
	codecAPIForceKeyFrame   = guid("{398c1b98-8353-475a-9ef2-8f265d260345}")
	codecAPIRateControl     = guid("{1c0608e9-370c-4710-8a58-cb6181c42423}")
	iidIMFTransform         = guid("{bf94c121-5b05-4e6f-8000-ba598961414d}")
	iidICodecAPI            = guid("{901db4c7-31ce-41a2-85dc-8fa0bf41b8da}")
	iidIMFMediaEventGen     = guid("{2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D}")
)

const (
	mfVersion          = 0x00020070 // MF_SDK_VERSION << 16 | MF_API_VERSION
	mfStartupLite      = 1
	coinitMultithread  = 0
	mftEnumSyncMFT     = 0x1
	mftEnumHardware    = 0x4
	mftEnumSortFilter  = 0x40
	interlaceProgress  = 2
	h264ProfileBase    = 66 // eAVEncH264VProfile_Base
	rateControlCBR     = 0  // eAVEncCommonRateControlMode_CBR (encoders that refuse it keep their default)
	msgBeginStreaming  = 0x10000000
	msgEndStreaming    = 0x10000001
	msgStartOfStream   = 0x10000003
	msgCommandFlush    = 0
	outProvidesSamples = 0x100
	vtUI4              = 19
	eventNeedInput     = 601
	eventHaveOutput    = 602
	eventFlagNoWait    = 1

	hrNeedMoreInput  = 0xC00D6D72
	hrStreamChange   = 0xC00D6D61
	hrNotAccepting   = 0xC00D36B5
	hrNoEventsAvail  = 0xC00D3E80
	hrCoChangedModel = 0x80010106 // RPC_E_CHANGED_MODE: COM was already initialised on this thread
)

// IUnknown / IMFAttributes / IMFTransform / … vtable slots (SDK header order).
const (
	slotQueryInterface = 0
	slotRelease        = 2
	// IMFAttributes
	attrGetUINT32          = 7
	attrGetAllocatedString = 13
	attrGetAllocatedBlob   = 16
	attrSetUINT32          = 21
	attrSetUINT64          = 22
	attrSetGUID            = 24
	// IMFActivate (after the 33 IMFAttributes slots)
	actActivateObject = 33
	actShutdownObject = 34
	// IMFTransform
	mftGetOutputStreamInfo   = 7
	mftGetAttributes         = 8
	mftGetOutputAvailableTyp = 14
	mftSetInputType          = 15
	mftSetOutputType         = 16
	mftGetOutputCurrentType  = 18
	mftProcessMessage        = 23
	mftProcessInput          = 24
	mftProcessOutput         = 25
	// IMFSample (after IMFAttributes)
	smpSetSampleTime             = 36
	smpSetSampleDuration         = 38
	smpConvertToContiguousBuffer = 41
	smpAddBuffer                 = 42
	// IMFMediaBuffer
	bufLock             = 3
	bufUnlock           = 4
	bufSetCurrentLength = 6
	// IMFMediaEventGenerator
	evgGetEvent = 3
	// IMFMediaEvent (after IMFAttributes)
	evGetType = 33
	// ICodecAPI
	codecSetValue = 9
)

type hresultError struct {
	op string
	hr uint32
}

func (e *hresultError) Error() string { return fmt.Sprintf("%s failed (HRESULT 0x%08X)", e.op, e.hr) }

func check(op string, r uintptr) error {
	if int32(uint32(r)) < 0 {
		return &hresultError{op: op, hr: uint32(r)}
	}
	return nil
}

func isHR(err error, hr uint32) bool {
	var he *hresultError
	return errors.As(err, &he) && he.hr == hr
}

// call invokes vtable slot idx of a COM object.
func call(obj unsafe.Pointer, idx int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func release(obj unsafe.Pointer) {
	if obj != nil {
		call(obj, slotRelease)
	}
}

func qi(obj unsafe.Pointer, iid *windows.GUID) unsafe.Pointer {
	var out unsafe.Pointer
	if check("QueryInterface", call(obj, slotQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))) != nil {
		return nil
	}
	return out
}

func setU32(attrs unsafe.Pointer, key *windows.GUID, v uint32) error {
	return check("SetUINT32", call(attrs, attrSetUINT32, uintptr(unsafe.Pointer(key)), uintptr(v)))
}

func setU64(attrs unsafe.Pointer, key *windows.GUID, v uint64) error {
	return check("SetUINT64", call(attrs, attrSetUINT64, append([]uintptr{uintptr(unsafe.Pointer(key))}, u64Args(v)...)...))
}

func setGUID(attrs unsafe.Pointer, key, v *windows.GUID) error {
	return check("SetGUID", call(attrs, attrSetGUID, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(v))))
}

func getU32(attrs unsafe.Pointer, key *windows.GUID) (uint32, bool) {
	var v uint32
	if check("GetUINT32", call(attrs, attrGetUINT32, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&v)))) != nil {
		return 0, false
	}
	return v, true
}

func coFree(p unsafe.Pointer) {
	if p != nil {
		procCoTaskMemFree.Call(uintptr(p))
	}
}

func friendlyName(attrs unsafe.Pointer) string {
	var s *uint16
	var n uint32
	if check("GetAllocatedString", call(attrs, attrGetAllocatedString, uintptr(unsafe.Pointer(&mftFriendlyName)), uintptr(unsafe.Pointer(&s)), uintptr(unsafe.Pointer(&n)))) != nil || s == nil {
		return ""
	}
	defer coFree(unsafe.Pointer(s))
	return windows.UTF16PtrToString(s)
}

// variant is a VARIANT holding a VT_UI4 (24 bytes on 64-bit Windows, 16 on 32-bit).
type variant struct {
	vt      uint16
	_, _, _ uint16
	val     uint64
	_       uint64
}

func codecSet(codec unsafe.Pointer, key *windows.GUID, v uint32) error {
	if codec == nil {
		return errors.New("the encoder has no ICodecAPI")
	}
	vr := variant{vt: vtUI4, val: uint64(v)}
	return check("ICodecAPI.SetValue", call(codec, codecSetValue, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&vr))))
}

// ── Worker thread ───────────────────────────────────────────────────────────────────────────────

type worker struct {
	jobs chan func()
	done chan struct{}
}

var startupOnce sync.Once
var startupErr error

func newWorker() (*worker, error) {
	if err := modMfplat.Load(); err != nil {
		return nil, fmt.Errorf("%w: Media Foundation (mfplat.dll) is not installed (a Windows N edition without the Media Feature Pack?)", ErrUnavailable)
	}
	w := &worker{jobs: make(chan func()), done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(w.done)
		r, _, _ := procCoInitializeEx.Call(0, coinitMultithread)
		inited := int32(uint32(r)) >= 0
		if !inited && uint32(r) != hrCoChangedModel {
			ready <- check("CoInitializeEx", r)
			return
		}
		if inited {
			defer procCoUninitialize.Call()
		}
		startupOnce.Do(func() {
			r, _, _ := procMFStartup.Call(mfVersion, mfStartupLite)
			startupErr = check("MFStartup", r)
		})
		if startupErr != nil {
			ready <- startupErr
			return
		}
		ready <- nil
		for job := range w.jobs {
			job()
		}
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return w, nil
}

func (w *worker) do(fn func()) {
	done := make(chan struct{})
	w.jobs <- func() {
		defer close(done)
		fn()
	}
	<-done
}

func (w *worker) stop() {
	close(w.jobs)
	<-w.done
}

// ── Encoder ─────────────────────────────────────────────────────────────────────────────────────

type mfEncoder struct {
	w        *worker
	cfg      Config
	name     string
	mft      unsafe.Pointer // IMFTransform
	activate unsafe.Pointer // IMFActivate (shut down on Close)
	events   unsafe.Pointer // IMFMediaEventGenerator (asynchronous hardware MFTs)
	codec    unsafe.Pointer // ICodecAPI (may be nil)
	outFlags uint32
	outSize  uint32
	seqHdr   []byte
	needIn   int
	mu       sync.Mutex
	closed   bool
}

// Open finds a Media Foundation H.264 encoder: hardware first, then the software encoder.
func Open(cfg Config) (Encoder, error) {
	if cfg.Width < 2 || cfg.Height < 2 || cfg.Width%2 != 0 || cfg.Height%2 != 0 {
		return nil, fmt.Errorf("invalid encoder size %dx%d", cfg.Width, cfg.Height)
	}
	if cfg.FPS <= 0 {
		cfg.FPS = 30
	}
	if cfg.Bitrate <= 0 {
		cfg.Bitrate = 4_000_000
	}
	w, err := newWorker()
	if err != nil {
		return nil, err
	}
	var enc *mfEncoder
	var errs []string
	w.do(func() {
		order := []uint32{mftEnumHardware | mftEnumSortFilter, mftEnumSyncMFT | mftEnumSortFilter}
		if cfg.Software {
			order = order[1:]
		}
		for _, flags := range order {
			e, err := openFirst(w, cfg, flags)
			if e != nil {
				enc = e
				return
			}
			if err != nil {
				errs = append(errs, err.Error())
			}
		}
	})
	if enc == nil {
		w.stop()
		if len(errs) == 0 {
			return nil, fmt.Errorf("%w: Media Foundation lists no H.264 encoder (a Windows N edition without the Media Feature Pack?)", ErrUnavailable)
		}
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, errs[len(errs)-1])
	}
	return enc, nil
}

// openFirst enumerates encoders with flags and returns the first one that accepts the types.
func openFirst(w *worker, cfg Config, flags uint32) (*mfEncoder, error) {
	type regType struct{ major, sub windows.GUID }
	out := regType{mfMediaTypeVideo, mfVideoFormatH264}
	var arr unsafe.Pointer
	var count uint32
	args := append(guidArgs(&mftCategoryVideoEncoder), uintptr(flags), 0, uintptr(unsafe.Pointer(&out)), uintptr(unsafe.Pointer(&arr)), uintptr(unsafe.Pointer(&count)))
	r, _, _ := procMFTEnumEx.Call(args...)
	if err := check("MFTEnumEx", r); err != nil {
		return nil, err
	}
	if count == 0 || arr == nil {
		coFree(arr)
		return nil, nil
	}
	acts := unsafe.Slice((*unsafe.Pointer)(arr), count)
	defer coFree(arr)
	var chosen *mfEncoder
	var lastErr error
	for _, act := range acts {
		if chosen != nil {
			release(act)
			continue
		}
		name := friendlyName(act)
		var mft unsafe.Pointer
		if err := check("ActivateObject", call(act, actActivateObject, uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&mft)))); err != nil {
			lastErr = fmt.Errorf("%s: %w", name, err)
			release(act)
			continue
		}
		e := &mfEncoder{w: w, cfg: cfg, name: name, mft: mft, activate: act}
		if flags&mftEnumHardware != 0 {
			e.name = "Media Foundation H.264 (hardware: " + name + ")"
		} else {
			e.name = "Media Foundation H.264 (software: " + name + ")"
		}
		if err := e.configure(); err != nil {
			lastErr = fmt.Errorf("%s: %w", name, err)
			e.release()
			continue
		}
		chosen = e
	}
	return chosen, lastErr
}

func (e *mfEncoder) configure() error {
	if attrs := e.getAttributes(); attrs != nil {
		if v, ok := getU32(attrs, &mfTransformAsync); ok && v != 0 {
			if err := setU32(attrs, &mfTransformAsyncUnlock, 1); err != nil {
				release(attrs)
				return err
			}
			e.events = qi(e.mft, &iidIMFMediaEventGen)
			if e.events == nil {
				release(attrs)
				return errors.New("asynchronous encoder without an event generator")
			}
		}
		_ = setU32(attrs, &mfLowLatency, 1)
		release(attrs)
	}
	e.codec = qi(e.mft, &iidICodecAPI)
	if e.codec != nil {
		_ = codecSet(e.codec, &codecAPIRateControl, rateControlCBR)
		_ = codecSet(e.codec, &codecAPIMeanBitRate, uint32(e.cfg.Bitrate))
		_ = codecSet(e.codec, &codecAPIGOPSize, uint32(e.cfg.FPS*2))
		_ = codecSet(e.codec, &mfLowLatency, 1) // CODECAPI_AVLowLatencyMode has the same GUID
	}
	size := uint64(e.cfg.Width)<<32 | uint64(e.cfg.Height)
	rate := uint64(e.cfg.FPS)<<32 | 1
	outType, err := newType(&mfVideoFormatH264, size, rate, func(t unsafe.Pointer) error {
		if err := setU32(t, &mfMTAvgBitrate, uint32(e.cfg.Bitrate)); err != nil {
			return err
		}
		return setU32(t, &mfMTMpeg2Profile, h264ProfileBase)
	})
	if err != nil {
		return err
	}
	err = check("SetOutputType", call(e.mft, mftSetOutputType, 0, uintptr(outType), 0))
	release(outType)
	if err != nil {
		return err
	}
	inType, err := newType(&mfVideoFormatNV12, size, rate, nil)
	if err != nil {
		return err
	}
	err = check("SetInputType (NV12)", call(e.mft, mftSetInputType, 0, uintptr(inType), 0))
	release(inType)
	if err != nil {
		return err
	}
	if err := e.readOutputInfo(); err != nil {
		return err
	}
	if err := check("ProcessMessage(BEGIN_STREAMING)", call(e.mft, mftProcessMessage, msgBeginStreaming, 0)); err != nil {
		return err
	}
	return check("ProcessMessage(START_OF_STREAM)", call(e.mft, mftProcessMessage, msgStartOfStream, 0))
}

func (e *mfEncoder) getAttributes() unsafe.Pointer {
	var attrs unsafe.Pointer
	if check("GetAttributes", call(e.mft, mftGetAttributes, uintptr(unsafe.Pointer(&attrs)))) != nil {
		return nil
	}
	return attrs
}

func (e *mfEncoder) readOutputInfo() error {
	var info struct{ flags, size, align uint32 }
	if err := check("GetOutputStreamInfo", call(e.mft, mftGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&info)))); err != nil {
		return err
	}
	e.outFlags, e.outSize = info.flags, info.size
	if os.Getenv("NIGAFIY_MF_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "mf output info: flags=0x%x size=%d async=%v\n", info.flags, info.size, e.events != nil)
	}
	var t unsafe.Pointer
	if check("GetOutputCurrentType", call(e.mft, mftGetOutputCurrentType, 0, uintptr(unsafe.Pointer(&t)))) == nil {
		var p unsafe.Pointer
		var n uint32
		if check("GetAllocatedBlob", call(t, attrGetAllocatedBlob, uintptr(unsafe.Pointer(&mfMTMpegSequenceHeader)), uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&n)))) == nil && p != nil {
			b := append([]byte(nil), unsafe.Slice((*byte)(p), n)...)
			coFree(p)
			if len(SplitNALs(b)) > 0 && len(b) > 3 && b[0] == 0 && b[1] == 0 {
				e.seqHdr = b
			}
		}
		release(t)
	}
	return nil
}

func newType(sub *windows.GUID, size, rate uint64, extra func(unsafe.Pointer) error) (unsafe.Pointer, error) {
	var t unsafe.Pointer
	r, _, _ := procMFCreateMediaType.Call(uintptr(unsafe.Pointer(&t)))
	if err := check("MFCreateMediaType", r); err != nil {
		return nil, err
	}
	steps := []func() error{
		func() error { return setGUID(t, &mfMTMajorType, &mfMediaTypeVideo) },
		func() error { return setGUID(t, &mfMTSubtype, sub) },
		func() error { return setU64(t, &mfMTFrameSize, size) },
		func() error { return setU64(t, &mfMTFrameRate, rate) },
		func() error { return setU32(t, &mfMTInterlaceMode, interlaceProgress) },
		func() error { return setU64(t, &mfMTPixelAspectRatio, 1<<32|1) },
	}
	if extra != nil {
		steps = append(steps, func() error { return extra(t) })
	}
	for _, s := range steps {
		if err := s(); err != nil {
			release(t)
			return nil, err
		}
	}
	return t, nil
}

func (e *mfEncoder) Name() string { return e.name }

func (e *mfEncoder) SetBitrate(bps int) error {
	var err error
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("encoder closed")
	}
	e.w.do(func() { err = codecSet(e.codec, &codecAPIMeanBitRate, uint32(bps)) })
	if err == nil {
		e.cfg.Bitrate = bps
	}
	return err
}

func (e *mfEncoder) Encode(nv12 []byte, frame int64, key bool) ([]Unit, error) {
	if len(nv12) != e.cfg.Width*e.cfg.Height*3/2 {
		return nil, fmt.Errorf("picture is %d bytes, the encoder expects %dx%d NV12", len(nv12), e.cfg.Width, e.cfg.Height)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil, errors.New("encoder closed")
	}
	var units []Unit
	var err error
	e.w.do(func() { units, err = e.encode(nv12, frame, key) })
	return units, err
}

func (e *mfEncoder) encode(nv12 []byte, frame int64, key bool) ([]Unit, error) {
	if key {
		_ = codecSet(e.codec, &codecAPIForceKeyFrame, 1)
	}
	dur := int64(10_000_000 / e.cfg.FPS)
	sample, err := newSample(nv12, uint32(len(nv12)))
	if err != nil {
		return nil, err
	}
	defer release(sample)
	if err := check("SetSampleTime", call(sample, smpSetSampleTime, u64Args(uint64(frame*dur))...)); err != nil {
		return nil, err
	}
	_ = check("SetSampleDuration", call(sample, smpSetSampleDuration, u64Args(uint64(dur))...))
	if e.events != nil {
		return e.encodeAsync(sample)
	}
	var units []Unit
	err = check("ProcessInput", call(e.mft, mftProcessInput, 0, uintptr(sample), 0))
	if isHR(err, hrNotAccepting) {
		u, derr := e.drain()
		units = append(units, u...)
		if derr != nil {
			return units, derr
		}
		err = check("ProcessInput", call(e.mft, mftProcessInput, 0, uintptr(sample), 0))
	}
	if err != nil {
		return units, err
	}
	u, err := e.drain()
	return append(units, u...), err
}

// encodeAsync: a hardware MFT asks for input and announces output through events.
func (e *mfEncoder) encodeAsync(sample unsafe.Pointer) ([]Unit, error) {
	var units []Unit
	poll := func(until time.Time, stop func() bool) error {
		for {
			var ev unsafe.Pointer
			err := check("GetEvent", call(e.events, evgGetEvent, eventFlagNoWait, uintptr(unsafe.Pointer(&ev))))
			if isHR(err, hrNoEventsAvail) {
				if stop() || time.Now().After(until) {
					return nil
				}
				time.Sleep(time.Millisecond)
				continue
			}
			if err != nil {
				return err
			}
			var typ uint32
			_ = check("GetType", call(ev, evGetType, uintptr(unsafe.Pointer(&typ))))
			release(ev)
			switch typ {
			case eventNeedInput:
				e.needIn++
			case eventHaveOutput:
				u, err := e.processOutput()
				if err != nil && !isHR(err, hrNeedMoreInput) {
					return err
				}
				units = append(units, u...)
			}
			if stop() {
				return nil
			}
		}
	}
	if err := poll(time.Now().Add(200*time.Millisecond), func() bool { return e.needIn > 0 }); err != nil {
		return units, err
	}
	if e.needIn == 0 {
		return units, nil // the encoder is busy: this picture is skipped
	}
	if err := check("ProcessInput", call(e.mft, mftProcessInput, 0, uintptr(sample), 0)); err != nil {
		return units, err
	}
	e.needIn--
	got := len(units)
	err := poll(time.Now().Add(40*time.Millisecond), func() bool { return len(units) > got })
	return units, err
}

// drain collects output until the MFT wants more input.
func (e *mfEncoder) drain() ([]Unit, error) {
	var units []Unit
	for range 16 {
		u, err := e.processOutput()
		units = append(units, u...)
		if isHR(err, hrNeedMoreInput) {
			return units, nil
		}
		if err != nil {
			return units, err
		}
	}
	return units, nil
}

type outputDataBuffer struct {
	streamID uint32
	sample   unsafe.Pointer
	status   uint32
	events   unsafe.Pointer
}

func (e *mfEncoder) processOutput() ([]Unit, error) {
	for range 3 {
		var buf outputDataBuffer
		if e.outFlags&outProvidesSamples == 0 {
			size := max(e.outSize, uint32(e.cfg.Width*e.cfg.Height*3/2))
			s, err := newSample(nil, size)
			if err != nil {
				return nil, err
			}
			buf.sample = s
		}
		var status uint32
		err := check("ProcessOutput", call(e.mft, mftProcessOutput, 0, 1, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&status))))
		release(buf.events)
		if isHR(err, hrStreamChange) {
			release(buf.sample)
			// The encoder changed its output format: take the type it offers now.
			var t unsafe.Pointer
			if err := check("GetOutputAvailableType", call(e.mft, mftGetOutputAvailableTyp, 0, 0, uintptr(unsafe.Pointer(&t)))); err != nil {
				return nil, err
			}
			err = check("SetOutputType", call(e.mft, mftSetOutputType, 0, uintptr(t), 0))
			release(t)
			if err != nil {
				return nil, err
			}
			if err := e.readOutputInfo(); err != nil {
				return nil, err
			}
			if e.events != nil {
				// Asynchronous: the next METransformHaveOutput event brings the output.
				return nil, nil
			}
			continue
		}
		if err != nil {
			release(buf.sample)
			return nil, err
		}
		data, err := sampleBytes(buf.sample)
		release(buf.sample)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			return nil, nil
		}
		if len(SplitNALs(data)) > 0 && IsKey(data) {
			data = WithParameterSets(data, e.seqHdr)
			return []Unit{{Data: data, Key: true}}, nil
		}
		return []Unit{{Data: data}}, nil
	}
	return nil, errors.New("the encoder kept changing its output format")
}

func newSample(data []byte, size uint32) (unsafe.Pointer, error) {
	var mb unsafe.Pointer
	r, _, _ := procMFCreateMemoryBuffer.Call(uintptr(size), uintptr(unsafe.Pointer(&mb)))
	if err := check("MFCreateMemoryBuffer", r); err != nil {
		return nil, err
	}
	defer release(mb)
	if data != nil {
		var p unsafe.Pointer
		var maxLen, cur uint32
		if err := check("IMFMediaBuffer.Lock", call(mb, bufLock, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&maxLen)), uintptr(unsafe.Pointer(&cur)))); err != nil {
			return nil, err
		}
		copy(unsafe.Slice((*byte)(p), maxLen), data)
		call(mb, bufUnlock)
		if err := check("SetCurrentLength", call(mb, bufSetCurrentLength, uintptr(len(data)))); err != nil {
			return nil, err
		}
	}
	var s unsafe.Pointer
	r, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&s)))
	if err := check("MFCreateSample", r); err != nil {
		return nil, err
	}
	if err := check("AddBuffer", call(s, smpAddBuffer, uintptr(mb))); err != nil {
		release(s)
		return nil, err
	}
	return s, nil
}

func sampleBytes(s unsafe.Pointer) ([]byte, error) {
	if s == nil {
		return nil, nil
	}
	var mb unsafe.Pointer
	if err := check("ConvertToContiguousBuffer", call(s, smpConvertToContiguousBuffer, uintptr(unsafe.Pointer(&mb)))); err != nil {
		return nil, err
	}
	defer release(mb)
	var p unsafe.Pointer
	var maxLen, cur uint32
	if err := check("IMFMediaBuffer.Lock", call(mb, bufLock, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&maxLen)), uintptr(unsafe.Pointer(&cur)))); err != nil {
		return nil, err
	}
	out := append([]byte(nil), unsafe.Slice((*byte)(p), cur)...)
	call(mb, bufUnlock)
	return out, nil
}

func (e *mfEncoder) release() {
	if e.mft != nil {
		call(e.mft, mftProcessMessage, msgCommandFlush, 0)
		call(e.mft, mftProcessMessage, msgEndStreaming, 0)
	}
	release(e.codec)
	release(e.events)
	release(e.mft)
	if e.activate != nil {
		call(e.activate, actShutdownObject)
		release(e.activate)
	}
	e.codec, e.events, e.mft, e.activate = nil, nil, nil, nil
}

func (e *mfEncoder) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.closed = true
	e.w.do(e.release)
	e.w.stop()
}
