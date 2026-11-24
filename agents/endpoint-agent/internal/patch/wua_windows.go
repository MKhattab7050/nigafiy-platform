//go:build windows

package patch

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The Windows Update Agent through its automation (IDispatch) interface, called with raw COM
// syscalls (no cgo, no extra module): Microsoft.Update.Session → UpdateSearcher.Search for what is
// missing, UpdateDownloader + UpdateInstaller for an approved install, Microsoft.Update.SystemInfo
// for a pending restart.

var (
	ole32              = windows.NewLazySystemDLL("ole32.dll")
	oleaut32           = windows.NewLazySystemDLL("oleaut32.dll")
	pCoInitializeEx    = ole32.NewProc("CoInitializeEx")
	pCoUninitialize    = ole32.NewProc("CoUninitialize")
	pCoCreateInstance  = ole32.NewProc("CoCreateInstance")
	pCLSIDFromProgID   = ole32.NewProc("CLSIDFromProgID")
	pSysAllocString    = oleaut32.NewProc("SysAllocString")
	pSysFreeString     = oleaut32.NewProc("SysFreeString")
	pVariantClear      = oleaut32.NewProc("VariantClear")
	iidIDispatch       = windows.GUID{Data1: 0x00020400, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidNull            = windows.GUID{}
	errDispatchMissing = errors.New("COM object missing")
)

const (
	vtEmpty    = 0
	vtNull     = 1
	vtI2       = 2
	vtI4       = 3
	vtDate     = 7
	vtBSTR     = 8
	vtDispatch = 9
	vtBool     = 11
	vtDecimal  = 14
	vtUI1      = 17
	vtUI4      = 19
	vtI8       = 20
	vtUI8      = 21
	vtInt      = 22
	vtUInt     = 23

	dispatchMethod      = 1
	dispatchPropertyGet = 2
	dispatchPropertyPut = 4
	dispidPropertyPut   = -3

	localeUserDefault = 0x400
	sFalse            = 1
	rpcEChangedMode   = 0x80010106
)

// variant is a VARIANT (16 bytes on 386, 24 on amd64 and arm64).
type variant struct {
	VT  uint16
	_   [3]uint16
	Val int64
	_   [unsafe.Sizeof(uintptr(0))*2 - 8]byte
}

type dispParams struct {
	args   uintptr
	named  uintptr
	cArgs  uint32
	cNamed uint32
}

type excepInfo struct {
	code        uint16
	_           uint16
	source      uintptr
	description uintptr
	helpFile    uintptr
	helpContext uint32
	_           uintptr
	deferred    uintptr
	scode       int32
}

// ptrAt turns an address owned by COM (not Go memory) into a pointer.
func ptrAt(p uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&p)) // #nosec G103 -- COM memory
}

// disp is an IDispatch pointer.
type disp uintptr

func (d disp) call(slot int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(ptrAt(uintptr(d)))                                   // #nosec G103 -- COM object
	fn := *(*uintptr)(ptrAt(vtbl + uintptr(slot)*unsafe.Sizeof(uintptr(0)))) // #nosec G103 -- vtable slot
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(d)}, args...)...)
	return r
}

func (d disp) release() {
	if d != 0 {
		d.call(2)
	}
}

func hrErr(what string, hr uintptr) error {
	return fmt.Errorf("%s: HRESULT 0x%08X", what, uint32(hr))
}

func bstr(s string) uintptr {
	p, err := windows.UTF16PtrFromString(s)
	if err != nil {
		p, _ = windows.UTF16PtrFromString(strings.ReplaceAll(s, "\x00", ""))
	}
	r, _, _ := pSysAllocString.Call(uintptr(unsafe.Pointer(p))) // #nosec G103 -- UTF-16 string for COM
	return r
}

func bstrString(p uintptr) string {
	if p == 0 {
		return ""
	}
	return windows.UTF16PtrToString((*uint16)(ptrAt(p)))
}

func freeBSTR(p uintptr) {
	if p != 0 {
		_, _, _ = pSysFreeString.Call(p)
	}
}

func (v *variant) clear() {
	_, _, _ = pVariantClear.Call(uintptr(unsafe.Pointer(v))) // #nosec G103 -- our VARIANT
}

func (v *variant) str() string {
	if v.VT == vtBSTR {
		return bstrString(uintptr(v.Val))
	}
	return ""
}

func (v *variant) int() int64 {
	switch v.VT {
	case vtI2:
		return int64(int16(v.Val))
	case vtI4, vtInt:
		return int64(int32(v.Val))
	case vtUI1:
		return int64(uint8(v.Val))
	case vtUI4, vtUInt:
		return int64(uint32(v.Val))
	case vtI8, vtUI8:
		return v.Val
	case vtDecimal:
		// DECIMAL overlays the whole VARIANT: scale at byte 2, sign at 3, Hi32 at 4, Lo64 at 8.
		b := (*[16]byte)(unsafe.Pointer(v)) // #nosec G103 -- our VARIANT
		scale, sign := b[2], b[3]
		hi := uint32(b[4]) | uint32(b[5])<<8 | uint32(b[6])<<16 | uint32(b[7])<<24
		lo := uint64(v.Val)
		if hi != 0 {
			return math.MaxInt64
		}
		n := lo
		for i := byte(0); i < scale; i++ {
			n /= 10
		}
		if sign&0x80 != 0 {
			return -int64(n) // #nosec G115 -- update sizes are far below 2^63
		}
		return int64(n) // #nosec G115 -- update sizes are far below 2^63
	}
	return 0
}

func (v *variant) boolean() bool { return v.VT == vtBool && int16(v.Val) != 0 }

func (v *variant) date() time.Time {
	if v.VT != vtDate {
		return time.Time{}
	}
	days := math.Float64frombits(uint64(v.Val)) // #nosec G115 -- the bits of a double
	base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	return base.Add(time.Duration(days * float64(24*time.Hour)))
}

func (v *variant) dispatch() disp {
	if v.VT == vtDispatch {
		return disp(v.Val) // #nosec G115 -- a pointer
	}
	return 0
}

// arg builds a VARIANT argument (BSTRs are freed after the call).
func arg(x any) variant {
	var v variant
	switch t := x.(type) {
	case string:
		v.VT, v.Val = vtBSTR, int64(bstr(t)) // #nosec G115 -- a pointer
	case int:
		v.VT, v.Val = vtI4, int64(int32(t)) // #nosec G115 -- small indexes
	case bool:
		v.VT = vtBool
		if t {
			v.Val = 0xFFFF
		}
	case disp:
		v.VT, v.Val = vtDispatch, int64(t) // #nosec G115 -- a pointer
	}
	return v
}

func (d disp) invoke(name string, flags uint16, args ...any) (variant, error) {
	var result variant
	if d == 0 {
		return result, errDispatchMissing
	}
	nameW, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return result, err
	}
	var id int32
	if hr := d.call(5, uintptr(unsafe.Pointer(&iidNull)), uintptr(unsafe.Pointer(&nameW)), 1, localeUserDefault, uintptr(unsafe.Pointer(&id))); hr != 0 { // #nosec G103 -- COM call
		return result, hrErr(name, hr)
	}
	vargs := make([]variant, len(args))
	for i, a := range args {
		vargs[len(args)-1-i] = arg(a) // DISPPARAMS lists the arguments last first
	}
	defer func() {
		for i := range vargs {
			if vargs[i].VT == vtBSTR {
				freeBSTR(uintptr(vargs[i].Val))
			}
		}
	}()
	params := dispParams{cArgs: uint32(len(vargs))} // #nosec G115 -- a few arguments
	if len(vargs) > 0 {
		params.args = uintptr(unsafe.Pointer(&vargs[0])) // #nosec G103 -- COM call
	}
	named := int32(dispidPropertyPut)
	if flags == dispatchPropertyPut {
		params.named, params.cNamed = uintptr(unsafe.Pointer(&named)), 1 // #nosec G103 -- COM call
	}
	var exc excepInfo
	var argErr uint32
	hr := d.call(6, uintptr(id), uintptr(unsafe.Pointer(&iidNull)), localeUserDefault, uintptr(flags), // #nosec G103 G115 -- COM call
		uintptr(unsafe.Pointer(&params)), uintptr(unsafe.Pointer(&result)), uintptr(unsafe.Pointer(&exc)), uintptr(unsafe.Pointer(&argErr))) // #nosec G103 -- COM call
	runtime.KeepAlive(vargs)
	runtime.KeepAlive(nameW)
	if hr != 0 {
		desc := strings.TrimSpace(bstrString(exc.description))
		freeBSTR(exc.source)
		freeBSTR(exc.description)
		freeBSTR(exc.helpFile)
		code := uint32(hr)
		if exc.scode != 0 {
			code = uint32(exc.scode) // #nosec G115 -- an HRESULT
		}
		if desc != "" {
			return result, fmt.Errorf("%s: %s (0x%08X)", name, desc, code)
		}
		return result, fmt.Errorf("%s: HRESULT 0x%08X", name, code)
	}
	return result, nil
}

func (d disp) get(name string, args ...any) (variant, error) {
	return d.invoke(name, dispatchPropertyGet|dispatchMethod, args...)
}

func (d disp) method(name string, args ...any) (variant, error) {
	return d.invoke(name, dispatchMethod, args...)
}

func (d disp) put(name string, value any) error {
	_, err := d.invoke(name, dispatchPropertyPut, value)
	return err
}

func (d disp) getString(name string) string {
	v, err := d.get(name)
	if err != nil {
		return ""
	}
	defer v.clear()
	return v.str()
}

func (d disp) getInt(name string) int64 {
	v, err := d.get(name)
	if err != nil {
		return 0
	}
	defer v.clear()
	return v.int()
}

func (d disp) getBool(name string) (bool, error) {
	v, err := d.get(name)
	if err != nil {
		return false, err
	}
	defer v.clear()
	return v.boolean(), nil
}

// getObject returns an owned object (release it).
func (d disp) getObject(name string, args ...any) (disp, error) {
	v, err := d.get(name, args...)
	if err != nil {
		return 0, err
	}
	o := v.dispatch()
	if o == 0 {
		v.clear()
		return 0, fmt.Errorf("%s: not an object", name)
	}
	return o, nil
}

func (d disp) callObject(name string, args ...any) (disp, error) {
	v, err := d.method(name, args...)
	if err != nil {
		return 0, err
	}
	o := v.dispatch()
	if o == 0 {
		v.clear()
		return 0, fmt.Errorf("%s: not an object", name)
	}
	return o, nil
}

func create(progID string) (disp, error) {
	p, err := windows.UTF16PtrFromString(progID)
	if err != nil {
		return 0, err
	}
	var clsid windows.GUID
	if hr, _, _ := pCLSIDFromProgID.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&clsid))); hr != 0 { // #nosec G103 -- COM call
		return 0, hrErr("CLSIDFromProgID "+progID, hr)
	}
	var out uintptr
	const clsctxInprocServer, clsctxLocalServer = 0x1, 0x4
	if hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsid)), 0, clsctxInprocServer|clsctxLocalServer, uintptr(unsafe.Pointer(&iidIDispatch)), uintptr(unsafe.Pointer(&out))); hr != 0 { // #nosec G103 -- COM call
		return 0, hrErr("CoCreateInstance "+progID, hr)
	}
	return disp(out), nil
}

// withCOM runs fn on one locked OS thread with COM initialized (single-threaded apartment).
func withCOM(fn func() error) error {
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		hr, _, _ := pCoInitializeEx.Call(0, 0x2)
		switch {
		case hr == 0 || hr == sFalse:
			defer func() { _, _, _ = pCoUninitialize.Call() }()
		case uint32(hr) == rpcEChangedMode:
		default:
			done <- hrErr("CoInitializeEx", hr)
			return
		}
		done <- fn()
	}()
	return <-done
}

// collection walks an IUpdateCollection / ICategoryCollection / IStringCollection.
func collection(c disp, each func(i int, item variant)) {
	n := int(c.getInt("Count"))
	for i := 0; i < n && i < 5000; i++ {
		v, err := c.get("Item", i)
		if err != nil {
			continue
		}
		each(i, v)
		v.clear()
	}
}

// WUAScanner is the Windows Update Agent.
type WUAScanner struct {
	// Elevated: the agent runs as an administrator or LocalSystem (installs possible).
	Elevated bool
	// Criteria for IUpdateSearcher.Search.
	Criteria string
}

const defaultCriteria = "IsInstalled=0 and IsHidden=0"

func (w *WUAScanner) criteria() string {
	if w.Criteria != "" {
		return w.Criteria
	}
	return defaultCriteria
}

func newSession() (disp, error) {
	s, err := create("Microsoft.Update.Session")
	if err != nil {
		return 0, err
	}
	_ = s.put("ClientApplicationID", "Nigafiy")
	return s, nil
}

// search returns the IUpdateCollection of missing updates (release both).
func search(session disp, criteria string) (searchResult disp, updates disp, err error) {
	searcher, err := session.callObject("CreateUpdateSearcher")
	if err != nil {
		return 0, 0, err
	}
	defer searcher.release()
	searchResult, err = searcher.callObject("Search", criteria)
	if err != nil {
		return 0, 0, err
	}
	updates, err = searchResult.getObject("Updates")
	if err != nil {
		searchResult.release()
		return 0, 0, err
	}
	return searchResult, updates, nil
}

func describe(u disp) Update {
	up := Update{Title: clip(u.getString("Title"), 500), Classification: "other"}
	if id, err := u.getObject("Identity"); err == nil {
		up.ID = id.getString("UpdateID")
		id.release()
	}
	if kbs, err := u.getObject("KBArticleIDs"); err == nil {
		collection(kbs, func(i int, item variant) {
			if i == 0 && item.str() != "" {
				up.KB = "KB" + item.str()
			}
		})
		kbs.release()
	}
	up.Severity = u.getString("MsrcSeverity")
	if n := u.getInt("MaxDownloadSize"); n > 0 {
		up.SizeBytes = n
	}
	if cats, err := u.getObject("Categories"); err == nil {
		collection(cats, func(_ int, item variant) {
			c := item.dispatch()
			if c == 0 || c.getString("Type") != "UpdateClassification" {
				return
			}
			up.Classification = WUAClass(c.getString("CategoryID"), c.getString("Name"))
		})
		cats.release()
	}
	if ib, err := u.getObject("InstallationBehavior"); err == nil {
		// RebootBehavior: 0 never, 1 always requires, 2 can request.
		up.RebootRequired = boolPtr(ib.getInt("RebootBehavior") != 0)
		ib.release()
	}
	if v, err := u.get("LastDeploymentChangeTime"); err == nil {
		if t := v.date(); !t.IsZero() {
			up.PublishedAt = t.UTC().Format(time.RFC3339)
		}
		v.clear()
	}
	return up
}

func rebootPending() *bool {
	si, err := create("Microsoft.Update.SystemInfo")
	if err != nil {
		return nil
	}
	defer si.release()
	b, err := si.getBool("RebootRequired")
	if err != nil {
		return nil
	}
	return boolPtr(b)
}

func (w *WUAScanner) Scan(ctx context.Context) Status {
	st := Status{Source: "wua", InstallSupported: w.Elevated, ScannedAt: time.Now().UTC(), Updates: []Update{}}
	err := withCOM(func() error {
		session, err := newSession()
		if err != nil {
			return err
		}
		defer session.release()
		res, updates, err := search(session, w.criteria())
		if err != nil {
			return err
		}
		defer res.release()
		defer updates.release()
		collection(updates, func(_ int, item variant) {
			if u := item.dispatch(); u != 0 && ctx.Err() == nil {
				st.Updates = append(st.Updates, describe(u))
			}
		})
		st.RebootPending = rebootPending()
		return ctx.Err()
	})
	if err != nil {
		st.Error = clip("Windows Update Agent: "+err.Error(), 500)
	}
	return st
}

func (w *WUAScanner) Install(ctx context.Context, items []Item) (InstallResult, error) {
	if !w.Elevated {
		return InstallResult{}, errors.New("installing updates needs the agent to run as an administrator (the Nigafiy service runs as LocalSystem)")
	}
	res := InstallResult{Results: []ItemResult{}}
	err := withCOM(func() error {
		session, err := newSession()
		if err != nil {
			return err
		}
		defer session.release()
		sres, updates, err := search(session, w.criteria())
		if err != nil {
			return err
		}
		defer sres.release()
		defer updates.release()
		coll, err := create("Microsoft.Update.UpdateColl")
		if err != nil {
			return err
		}
		defer coll.release()
		want := map[string]bool{}
		for _, it := range items {
			want[strings.ToLower(it.ID)] = true
		}
		var order []string
		collection(updates, func(_ int, item variant) {
			u := item.dispatch()
			if u == 0 {
				return
			}
			id := ""
			if ident, err := u.getObject("Identity"); err == nil {
				id = ident.getString("UpdateID")
				ident.release()
			}
			if !want[strings.ToLower(id)] {
				return
			}
			// The admin's approval is the acceptance of the update's licence terms.
			if ok, _ := u.getBool("EulaAccepted"); !ok {
				if v, err := u.method("AcceptEula"); err == nil {
					v.clear()
				}
			}
			if v, err := coll.method("Add", u); err == nil {
				v.clear()
				order = append(order, id)
			}
		})
		found := map[string]bool{}
		for _, id := range order {
			found[strings.ToLower(id)] = true
		}
		for _, it := range items {
			if !found[strings.ToLower(it.ID)] {
				res.Results = append(res.Results, ItemResult{ID: it.ID, Result: "not_started", HResult: "no longer missing on this computer"})
			}
		}
		if len(order) == 0 {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		downloader, err := session.callObject("CreateUpdateDownloader")
		if err != nil {
			return err
		}
		defer downloader.release()
		if err := downloader.put("Updates", coll); err != nil {
			return err
		}
		dres, err := downloader.callObject("Download")
		if err != nil {
			return fmt.Errorf("download: %w", err)
		}
		dres.release()
		installer, err := session.callObject("CreateUpdateInstaller")
		if err != nil {
			return err
		}
		defer installer.release()
		_ = installer.put("ForceQuiet", true)
		if err := installer.put("Updates", coll); err != nil {
			return err
		}
		ires, err := installer.callObject("Install")
		if err != nil {
			return fmt.Errorf("install: %w", err)
		}
		defer ires.release()
		res.RebootRequired, _ = ires.getBool("RebootRequired")
		for i, id := range order {
			r := ItemResult{ID: id, Result: "not_started"}
			if ur, err := ires.callObject("GetUpdateResult", i); err == nil {
				r.Result = WUAResult(int(ur.getInt("ResultCode")))
				if hr := ur.getInt("HResult"); hr != 0 {
					r.HResult = fmt.Sprintf("0x%08X", uint32(hr)) // #nosec G115 -- an HRESULT
				}
				r.RebootRequired, _ = ur.getBool("RebootRequired")
				ur.release()
			}
			res.Results = append(res.Results, r)
		}
		return nil
	})
	return res, err
}

// New returns the Windows Update Agent scanner.
func New() Scanner {
	return &WUAScanner{Elevated: windows.GetCurrentProcessToken().IsElevated()}
}
