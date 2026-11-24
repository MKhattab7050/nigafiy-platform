//go:build windows

package userui

import (
	"context"
	"fmt"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/nigafiy/agent/internal/remotedesktop"
)

var (
	pBeginPaint             = user32.NewProc("BeginPaint")
	pEndPaint               = user32.NewProc("EndPaint")
	pInvalidateRect         = user32.NewProc("InvalidateRect")
	pSetLayeredWindowAttrs  = user32.NewProc("SetLayeredWindowAttributes")
	pSetWindowDisplayAffin  = user32.NewProc("SetWindowDisplayAffinity")
	pFillRect               = user32.NewProc("FillRect")
	pDrawTextW              = user32.NewProc("DrawTextW")
	pGetClientRect          = user32.NewProc("GetClientRect")
	pGetWindowTextW         = user32.NewProc("GetWindowTextW")
	pGetWindowTextLengthW   = user32.NewProc("GetWindowTextLengthW")
	pFlashWindow            = user32.NewProc("FlashWindow")
	pCreateSolidBrush       = gdi32.NewProc("CreateSolidBrush")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pSetTextColor           = gdi32.NewProc("SetTextColor")
	pSetBkMode              = gdi32.NewProc("SetBkMode")
	pCreateFontW            = gdi32.NewProc("CreateFontW")
	pCreatePen              = gdi32.NewProc("CreatePen")
	pMoveToEx               = gdi32.NewProc("MoveToEx")
	pLineTo                 = gdi32.NewProc("LineTo")
	pEllipse                = gdi32.NewProc("Ellipse")
	pGetStockObjectForBrush = gdi32.NewProc("GetStockObject")
)

type paintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     [4]int32
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

const (
	wsExLayered       = 0x00080000
	wsExTransparent   = 0x00000020
	wsExNoActivate    = 0x08000000
	wsBorder          = 0x00800000
	wsVScroll         = 0x00200000
	esMultiline       = 0x0004
	esReadOnly        = 0x0800
	esAutoVScroll     = 0x0040
	esAutoHScroll     = 0x0080
	emSetSel          = 0x00B1
	emScrollCaret     = 0x00B7
	lwaColorKey       = 0x1
	lwaAlpha          = 0x2
	wdaExcludeCapture = 0x11
	dtCenter          = 0x1
	dtWordBreak       = 0x10
	dtCalcRect        = 0x400
	dtNoPrefix        = 0x800
	transparentBk     = 1
	psSolid           = 0
	nullPen           = 8
	smXVirtual        = 76
	smYVirtual        = 77
	smCxVirtual       = 78
	smCyVirtual       = 79

	idChatHistory = 201
	idChatInput   = 202
	idChatSend    = 203
	idAskInput    = 204
	idAskOK       = 205
	idAskYes      = 206
	idAskNo       = 207

	// Privacy screen colours: a dark blue page with white text, never plain black.
	privacyBackground = 0x432A0F // BGR of #0f2a43
	privacyText       = 0xFFFFFF
	overlayKey        = 0x010001 // the transparent colour of the overlay
)

func rgb(r, g, b uint8) uintptr { return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16 }

func newFont(height int, bold bool) uintptr {
	weight := 400
	if bold {
		weight = 600
	}
	f, _, _ := pCreateFontW.Call(uintptr(uint32(int32(-height))), 0, 0, 0, uintptr(weight), 0, 0, 0, 1 /*DEFAULT_CHARSET*/, 0, 0, 5 /*CLEARTYPE*/, 0,
		uintptr(unsafe.Pointer(utf16("Segoe UI"))))
	return f
}

func windowText(hwnd uintptr) string {
	n, _, _ := pGetWindowTextLengthW.Call(hwnd)
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	_, _, _ = pGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), n+1)
	return syscall.UTF16ToString(buf)
}

type toolWin struct {
	hwnd uintptr
	done chan struct{}
}

func (t *toolWin) close() {
	if t == nil {
		return
	}
	_, _, _ = pPostMessageW.Call(t.hwnd, wmAppClose, 0, 0)
	select {
	case <-t.done:
	case <-time.After(2 * time.Second):
	}
}

// openWindow runs a window on its own thread and returns once it exists.
func openWindow(s spec, w *window) (*toolWin, error) {
	t := &toolWin{done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		defer close(t.done)
		runWindow(s, w, func(hwnd uintptr) { t.hwnd = hwnd; ready <- nil }, func(err error) { ready <- err })
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return t, nil
}

type winTools struct {
	mu             sync.Mutex
	privacy        []*toolWin
	privacySession string
	chat           *toolWin
	chatSession    string
	chatLines      []ChatLine
	chatReply      func(string)
	overlay        *toolWin
	overlaySession string
	ov             overlayState
}

// ── Privacy screen ──────────────────────────────────────────────────────────────────────────────

func (u *winUI) PrivacyScreen(sessionID string, on bool, info BannerInfo) (PrivacyResult, error) {
	t := &u.tools
	t.mu.Lock()
	old := t.privacy
	t.privacy, t.privacySession = nil, ""
	t.mu.Unlock()
	for _, w := range old {
		w.close()
	}
	if !on {
		return PrivacyResult{}, nil
	}
	displays, err := remotedesktop.EnumerateDisplays()
	if err != nil {
		return PrivacyResult{}, err
	}
	text := PrivacyText(info)
	res := PrivacyResult{Excluded: true}
	var wins []*toolWin
	for _, d := range displays {
		if d.All {
			continue
		}
		font := newFont(max(22, d.Height/30), true)
		w := &window{onClose: func() bool { return false }}
		w.onPaint = func(hwnd, hdc uintptr) {
			var rc [4]int32
			_, _, _ = pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
			brush, _, _ := pCreateSolidBrush.Call(privacyBackground)
			_, _, _ = pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), brush)
			_, _, _ = pDeleteObject.Call(brush)
			old, _, _ := pSelectObject.Call(hdc, font)
			_, _, _ = pSetTextColor.Call(hdc, privacyText)
			_, _, _ = pSetBkMode.Call(hdc, transparentBk)
			margin := rc[2] / 10
			box := [4]int32{margin, 0, rc[2] - margin, rc[3]}
			txt := utf16(text)
			_, _, _ = pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(txt)), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtCenter|dtWordBreak|dtNoPrefix|dtCalcRect)
			h := box[3] - box[1]
			box = [4]int32{margin, (rc[3] - h) / 2, rc[2] - margin, (rc[3]-h)/2 + h}
			_, _, _ = pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(txt)), ^uintptr(0), uintptr(unsafe.Pointer(&box)), dtCenter|dtWordBreak|dtNoPrefix)
			_, _, _ = pSelectObject.Call(hdc, old)
		}
		var excluded bool
		s := spec{
			exStyle: wsExTopmost | wsExToolWindow | wsExLayered | wsExTransparent | wsExNoActivate, style: wsPopup | wsVisible,
			rect: &[4]int{d.X, d.Y, d.Width, d.Height}, noActivate: true,
			custom: func(hwnd uintptr) {
				_, _, _ = pSetLayeredWindowAttrs.Call(hwnd, 0, 255, lwaAlpha)
				// The operator keeps seeing the real desktop: this window is left out of capture.
				r, _, _ := pSetWindowDisplayAffin.Call(hwnd, wdaExcludeCapture)
				excluded = r != 0
			},
		}
		tw, err := openWindow(s, w)
		if err != nil {
			for _, x := range wins {
				x.close()
			}
			return PrivacyResult{}, err
		}
		res.Excluded = res.Excluded && excluded
		wins = append(wins, tw)
	}
	res.Monitors = len(wins)
	if !res.Excluded {
		res.Note = "SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) needs Windows 10 version 2004 or later; GDI capture still leaves the layered privacy window out"
	}
	t.mu.Lock()
	t.privacy, t.privacySession = wins, sessionID
	t.mu.Unlock()
	return res, nil
}

// ── Chat ────────────────────────────────────────────────────────────────────────────────────────

func (u *winUI) Chat(sessionID string, line ChatLine, onReply func(string)) error {
	t := &u.tools
	t.mu.Lock()
	if t.chatSession != sessionID {
		old := t.chat
		t.chat, t.chatLines = nil, nil
		t.mu.Unlock()
		old.close()
		t.mu.Lock()
	}
	t.chatSession, t.chatReply = sessionID, onReply
	if len(t.chatLines) >= 200 {
		t.chatLines = t.chatLines[1:]
	}
	t.chatLines = append(t.chatLines, ChatLine{From: Clean(line.From, 80), Text: line.Text})
	existing := t.chat
	t.mu.Unlock()
	if existing != nil {
		_, _, _ = pPostMessageW.Call(existing.hwnd, wmAppWake, 0, 0)
		return nil
	}
	var history, input uintptr
	refresh := func(self uintptr) {
		t.mu.Lock()
		text := ChatTranscript(t.chatLines)
		t.mu.Unlock()
		_, _, _ = pSetWindowTextW.Call(history, uintptr(unsafe.Pointer(utf16(text))))
		_, _, _ = pSendMessageW.Call(history, emSetSel, 0xFFFF, 0xFFFF)
		_, _, _ = pSendMessageW.Call(history, emScrollCaret, 0, 0)
		_, _, _ = pFlashWindow.Call(self, 1)
	}
	var self uintptr
	w := &window{}
	w.onWake = func() { refresh(self) }
	w.onCommand = func(id int) {
		if id != idChatSend {
			return
		}
		text := CleanMultiline(windowText(input), MaxChatText)
		if text == "" {
			return
		}
		_, _, _ = pSetWindowTextW.Call(input, uintptr(unsafe.Pointer(utf16(""))))
		t.mu.Lock()
		t.chatLines = append(t.chatLines, ChatLine{From: YouLabel, Text: text})
		reply := t.chatReply
		t.mu.Unlock()
		refresh(self)
		if reply != nil {
			go reply(text)
		}
	}
	w.onClose = func() bool {
		t.mu.Lock()
		if t.chat != nil && t.chat.hwnd == self {
			t.chat = nil
		}
		t.mu.Unlock()
		return true
	}
	const cw, ch = 480, 440
	s := spec{title: ChatTitle, exStyle: wsExTopmost, style: wsPopup | wsCaption | wsSysMenu | wsVisible, w: cw, h: ch,
		custom: func(hwnd uintptr) {
			self = hwnd
			history = createChild(hwnd, "EDIT", "", wsBorder|wsVScroll|esMultiline|esReadOnly|esAutoVScroll, 10, 10, cw-36, ch-130, idChatHistory)
			createChild(hwnd, "STATIC", ReplyLabel, ssLeft, 10, ch-112, 200, 18, idText)
			input = createChild(hwnd, "EDIT", "", wsBorder|wsTabStop|esAutoHScroll, 10, ch-90, cw-170, 26, idChatInput)
			createChild(hwnd, "BUTTON", SendLabel, wsTabStop|bsDefPushBtn, cw-150, ch-91, 124, 28, idChatSend)
			refresh(hwnd)
		}}
	tw, err := openWindow(s, w)
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.chat = tw
	t.mu.Unlock()
	return nil
}

func (u *winUI) CloseChat(sessionID string) {
	t := &u.tools
	t.mu.Lock()
	if sessionID != "" && t.chatSession != sessionID {
		t.mu.Unlock()
		return
	}
	c := t.chat
	t.chat, t.chatLines, t.chatSession, t.chatReply = nil, nil, "", nil
	t.mu.Unlock()
	c.close()
}

// ── A question the person answers ───────────────────────────────────────────────────────────────

func (u *winUI) Ask(ctx context.Context, req AskRequest) (AskAnswer, error) {
	req = req.Normalize()
	answer := make(chan AskAnswer, 1)
	var once sync.Once
	var self, input, textHwnd uintptr
	finish := func(a AskAnswer) {
		once.Do(func() {
			answer <- a
			_, _, _ = pPostMessageW.Call(self, wmAppClose, 0, 0)
		})
	}
	left := req.TimeoutSeconds
	body := func() string {
		return fmt.Sprintf("%s:\n%s\n\n(%d s)", req.Operator, req.Text, left)
	}
	w := &window{}
	w.onCommand = func(id int) {
		switch id {
		case idAskOK:
			if req.Kind == "text" {
				finish(AskAnswer{Answer: "text", Text: CleanMultiline(windowText(input), MaxChatText)})
				return
			}
			finish(AskAnswer{Answer: "ok"})
		case idAskYes:
			finish(AskAnswer{Answer: "yes"})
		case idAskNo:
			finish(AskAnswer{Answer: "no"})
		}
	}
	w.onTimer = func() {
		left--
		if left <= 0 {
			finish(AskAnswer{Answer: "timeout"})
			return
		}
		_, _, _ = pSetWindowTextW.Call(textHwnd, uintptr(unsafe.Pointer(utf16(body()))))
	}
	w.onClose = func() bool { finish(AskAnswer{Answer: "closed"}); return true }
	const aw, ah = 520, 300
	s := spec{title: AskTitle, exStyle: wsExTopmost | wsExDlgFrame, style: wsPopup | wsCaption | wsSysMenu | wsVisible, w: aw, h: ah,
		custom: func(hwnd uintptr) {
			self = hwnd
			textH := ah - 120
			if req.Kind == "text" {
				textH = ah - 150
			}
			textHwnd = createChild(hwnd, "STATIC", body(), ssLeft, 14, 10, aw-40, textH, idText)
			by := ah - 80
			switch req.Kind {
			case "yes_no":
				createChild(hwnd, "BUTTON", YesLabel, wsTabStop|bsDefPushBtn, aw-300, by, 130, 28, idAskYes)
				createChild(hwnd, "BUTTON", NoLabel, wsTabStop|bsPushButton, aw-160, by, 130, 28, idAskNo)
			case "text":
				input = createChild(hwnd, "EDIT", "", wsBorder|wsTabStop|esAutoHScroll, 14, by-36, aw-44, 26, idAskInput)
				createChild(hwnd, "BUTTON", SendLabel, wsTabStop|bsDefPushBtn, aw-160, by, 130, 28, idAskOK)
			default:
				createChild(hwnd, "BUTTON", OKLabel, wsTabStop|bsDefPushBtn, aw-160, by, 130, 28, idAskOK)
			}
			if testAskShown != nil {
				testAskShown(hwnd)
			}
		}}
	tw, err := openWindow(s, w)
	if err != nil {
		return AskAnswer{}, err
	}
	select {
	case a := <-answer:
		return a, nil
	case <-ctx.Done():
		finish(AskAnswer{Answer: "closed"})
		tw.close()
		return AskAnswer{}, ctx.Err()
	case <-time.After(time.Duration(req.TimeoutSeconds+5) * time.Second):
		finish(AskAnswer{Answer: "timeout"})
		return AskAnswer{Answer: "timeout"}, nil
	}
}

// testAskShown lets a test press the question's buttons the way a person would.
var testAskShown func(hwnd uintptr)

// ── Annotations and laser pointer ───────────────────────────────────────────────────────────────

type overlayStroke struct {
	pts   [][2]int32
	color uintptr
	width int
}

type overlayState struct {
	strokes   []overlayStroke
	pointer   *[2]int32
	pointerAt time.Time
	vx, vy    int
}

func (u *winUI) Overlay(sessionID string, op OverlayOp) error {
	if err := op.Validate(); err != nil {
		return err
	}
	t := &u.tools
	t.mu.Lock()
	if t.overlaySession != sessionID && t.overlay != nil {
		old := t.overlay
		t.overlay, t.ov = nil, overlayState{}
		t.mu.Unlock()
		old.close()
		t.mu.Lock()
	}
	toLocal := func(nx, ny float64) [2]int32 {
		return [2]int32{int32(op.Display.X - t.ov.vx + int(nx*float64(op.Display.W))), int32(op.Display.Y - t.ov.vy + int(ny*float64(op.Display.H)))}
	}
	if t.overlay == nil {
		t.ov = overlayState{vx: metric(smXVirtual), vy: metric(smYVirtual)}
	}
	switch op.Op {
	case "stroke":
		if len(t.ov.strokes) >= MaxStrokes {
			t.ov.strokes = t.ov.strokes[1:]
		}
		st := overlayStroke{color: rgb(op.RGB()), width: op.Width}
		for _, p := range op.Points {
			st.pts = append(st.pts, toLocal(p[0], p[1]))
		}
		t.ov.strokes = append(t.ov.strokes, st)
	case "pointer":
		p := toLocal(op.X, op.Y)
		t.ov.pointer, t.ov.pointerAt = &p, time.Now()
	case "pointer_hide":
		t.ov.pointer = nil
	case "clear":
		t.ov.strokes, t.ov.pointer = nil, nil
	}
	existing := t.overlay
	t.overlaySession = sessionID
	t.mu.Unlock()
	if existing != nil {
		_, _, _ = pPostMessageW.Call(existing.hwnd, wmAppWake, 0, 0)
		return nil
	}
	if op.Op == "clear" || op.Op == "pointer_hide" {
		return nil
	}
	w := &window{onClose: func() bool { return false }}
	w.onWake = func() {}
	var self uintptr
	w.onWake = func() { _, _, _ = pInvalidateRect.Call(self, 0, 1) }
	w.onTimer = func() {
		t.mu.Lock()
		stale := t.ov.pointer != nil && time.Since(t.ov.pointerAt) > 2*time.Second
		if stale {
			t.ov.pointer = nil
		}
		t.mu.Unlock()
		if stale {
			_, _, _ = pInvalidateRect.Call(self, 0, 1)
		}
	}
	w.onPaint = func(hwnd, hdc uintptr) {
		var rc [4]int32
		_, _, _ = pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
		key, _, _ := pCreateSolidBrush.Call(overlayKey)
		_, _, _ = pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), key)
		_, _, _ = pDeleteObject.Call(key)
		t.mu.Lock()
		strokes := t.ov.strokes
		ptr := t.ov.pointer
		t.mu.Unlock()
		for _, st := range strokes {
			pen, _, _ := pCreatePen.Call(psSolid, uintptr(st.width), st.color)
			old, _, _ := pSelectObject.Call(hdc, pen)
			for i, p := range st.pts {
				if i == 0 {
					_, _, _ = pMoveToEx.Call(hdc, uintptr(p[0]), uintptr(p[1]), 0)
					if len(st.pts) == 1 {
						_, _, _ = pLineTo.Call(hdc, uintptr(p[0]+1), uintptr(p[1]))
					}
					continue
				}
				_, _, _ = pLineTo.Call(hdc, uintptr(p[0]), uintptr(p[1]))
			}
			_, _, _ = pSelectObject.Call(hdc, old)
			_, _, _ = pDeleteObject.Call(pen)
		}
		if ptr != nil {
			brush, _, _ := pCreateSolidBrush.Call(rgb(255, 32, 32))
			oldB, _, _ := pSelectObject.Call(hdc, brush)
			np, _, _ := pGetStockObjectForBrush.Call(nullPen)
			oldP, _, _ := pSelectObject.Call(hdc, np)
			_, _, _ = pEllipse.Call(hdc, uintptr(ptr[0]-9), uintptr(ptr[1]-9), uintptr(ptr[0]+9), uintptr(ptr[1]+9))
			_, _, _ = pSelectObject.Call(hdc, oldP)
			_, _, _ = pSelectObject.Call(hdc, oldB)
			_, _, _ = pDeleteObject.Call(brush)
		}
	}
	vx, vy, vw, vh := metric(smXVirtual), metric(smYVirtual), metric(smCxVirtual), metric(smCyVirtual)
	s := spec{exStyle: wsExTopmost | wsExToolWindow | wsExLayered | wsExTransparent | wsExNoActivate, style: wsPopup | wsVisible,
		rect: &[4]int{vx, vy, vw, vh}, noActivate: true,
		custom: func(hwnd uintptr) {
			self = hwnd
			_, _, _ = pSetLayeredWindowAttrs.Call(hwnd, overlayKey, 0, lwaColorKey)
			// The operator draws the same marks in the viewer; the stream does not echo them back.
			_, _, _ = pSetWindowDisplayAffin.Call(hwnd, wdaExcludeCapture)
		}}
	tw, err := openWindow(s, w)
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.overlay = tw
	t.mu.Unlock()
	return nil
}

func (u *winUI) CloseOverlay(sessionID string) {
	t := &u.tools
	t.mu.Lock()
	if sessionID != "" && t.overlaySession != sessionID {
		t.mu.Unlock()
		return
	}
	o := t.overlay
	t.overlay, t.ov, t.overlaySession = nil, overlayState{}, ""
	t.mu.Unlock()
	o.close()
}

var _ ToolUI = (*winUI)(nil)
