package userui

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// In-session tools the person at the computer sees (Fleet Pro): the privacy screen, the chat
// window, a question they can answer, and the annotations / laser pointer overlay. None of them can
// hide the banner; the privacy screen itself always names the operator and the reason and says how
// to end the session, and is never a plain black screen.

// ErrToolUnsupported: this platform cannot show that tool (the reason is in the message).
var ErrToolUnsupported = errors.New("not available on this platform")

// EndHotkeyText is the combination that always ends the session (Windows), shown wherever the
// person might need it: the banner and the privacy screen.
const EndHotkeyText = "Ctrl+Alt+Shift+E"

// ChatLine is one message of the session chat.
type ChatLine struct {
	From string `json:"from"`
	Text string `json:"text"`
}

// MaxChatText bounds one chat message or question (the API enforces the same).
const MaxChatText = 2000

// AskRequest is a question the operator asks; the person answers in a window.
type AskRequest struct {
	SessionID string `json:"session_id"`
	ID        string `json:"id"`
	Operator  string `json:"operator"`
	Text      string `json:"text"`
	// Kind: "ok" (a message to acknowledge), "yes_no", or "text" (a typed answer).
	Kind string `json:"kind"`
	// TimeoutSeconds closes the question unanswered (10..600, default 300).
	TimeoutSeconds int `json:"timeout_s"`
}

// AskAnswer: ok | yes | no | text (Text holds it) | closed (window closed) | timeout.
type AskAnswer struct {
	Answer string `json:"answer"`
	Text   string `json:"text,omitempty"`
}

func (r AskRequest) Normalize() AskRequest {
	r.Operator = Clean(r.Operator, maxField)
	if r.Operator == "" {
		r.Operator = "An IT operator"
	}
	r.Text = CleanMultiline(r.Text, MaxChatText)
	switch r.Kind {
	case "yes_no", "text":
	default:
		r.Kind = "ok"
	}
	if r.TimeoutSeconds <= 0 {
		r.TimeoutSeconds = 300
	}
	r.TimeoutSeconds = max(10, min(600, r.TimeoutSeconds))
	return r
}

// CleanMultiline is Clean that keeps line breaks.
func CleanMultiline(s string, max int) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	n := 0
	for _, l := range lines {
		c := Clean(l, max)
		n += len([]rune(c))
		out = append(out, c)
		if n >= max {
			break
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// OverlayOp is one annotation action. Coordinates are 0..1 of the session's display.
type OverlayOp struct {
	// stroke (a line through Points) | pointer (laser pointer at X, Y) | pointer_hide | clear
	Op      string       `json:"op"`
	Display DisplayRect  `json:"display"`
	Points  [][2]float64 `json:"points,omitempty"`
	Color   string       `json:"color,omitempty"`
	Width   int          `json:"width,omitempty"`
	X       float64      `json:"x,omitempty"`
	Y       float64      `json:"y,omitempty"`
}

// DisplayRect is where the operator's display is on the virtual screen (physical pixels).
type DisplayRect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Overlay limits: a session cannot flood the person's screen.
const (
	MaxStrokes      = 400
	MaxStrokePoints = 2000
)

var colourRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Validate checks an overlay op and fills defaults.
func (o *OverlayOp) Validate() error {
	switch o.Op {
	case "stroke":
		if len(o.Points) < 1 || len(o.Points) > MaxStrokePoints {
			return fmt.Errorf("a stroke has 1 to %d points", MaxStrokePoints)
		}
		for _, p := range o.Points {
			if p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1 {
				return errors.New("stroke point outside the screen")
			}
		}
	case "pointer":
		if o.X < 0 || o.X > 1 || o.Y < 0 || o.Y > 1 {
			return errors.New("pointer outside the screen")
		}
	case "pointer_hide", "clear":
	default:
		return fmt.Errorf("unknown overlay op %q", o.Op)
	}
	if o.Color == "" {
		o.Color = "#ff2d55"
	}
	if !colourRe.MatchString(o.Color) {
		return errors.New("colour must be #rrggbb")
	}
	if o.Width <= 0 {
		o.Width = 4
	}
	o.Width = min(o.Width, 24)
	if o.Display.W <= 0 || o.Display.H <= 0 {
		return errors.New("unknown display")
	}
	return nil
}

// RGB of a validated #rrggbb colour.
func (o OverlayOp) RGB() (r, g, b uint8) {
	var v uint32
	_, _ = fmt.Sscanf(o.Color[1:], "%06x", &v)
	return uint8(v >> 16), uint8(v >> 8), uint8(v)
}

// ToolUI is implemented by the platform UIs (and by nothing that could hide the banner).
type ToolUI interface {
	// PrivacyScreen covers every monitor with the session notice (on) or removes it. The operator's
	// picture still shows the real desktop (the window is excluded from screen capture).
	PrivacyScreen(sessionID string, on bool, info BannerInfo) (PrivacyResult, error)
	// Chat shows a message from the operator in the chat window; onReply gets each answer typed there.
	Chat(sessionID string, line ChatLine, onReply func(text string)) error
	CloseChat(sessionID string)
	// Ask shows a question and waits for the answer (or ctx / the timeout).
	Ask(ctx context.Context, req AskRequest) (AskAnswer, error)
	// Overlay draws an annotation or moves the laser pointer; CloseOverlay clears everything.
	Overlay(sessionID string, op OverlayOp) error
	CloseOverlay(sessionID string)
	// EndHotkey says whether Ctrl+Alt+Shift+E is active: "registered", "unsupported" or
	// "unavailable: <why>" (another program holds it).
	EndHotkey() string
}

// PrivacyResult reports how the privacy screen was shown.
type PrivacyResult struct {
	Monitors int `json:"monitors"`
	// Excluded: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) succeeded (Windows 10 2004+).
	// When false the picture still shows the desktop on Windows 8+ (GDI capture without
	// CAPTUREBLT leaves layered windows out), which the session verifies with its next frame.
	Excluded bool   `json:"excluded"`
	Note     string `json:"note,omitempty"`
}

// PrivacyText is what the privacy screen says (never empty, never only black).
func PrivacyText(i BannerInfo) string {
	i = i.Normalize()
	ops := i.Operator
	if len(i.Operators) > 0 {
		ops = strings.Join(i.Operators, ", ")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "IT support session in progress: %s", ops)
	if i.Reason != "" {
		fmt.Fprintf(&b, ", reason: %s", i.Reason)
	}
	b.WriteString("\nYour screen is hidden while the operator works. To end the session press " + EndHotkeyText + ".")
	fmt.Fprintf(&b, "\n\nجلسة دعم فني جارية: %s", ops)
	if i.Reason != "" {
		fmt.Fprintf(&b, "، السبب: %s", i.Reason)
	}
	b.WriteString("\nشاشتك مخفية أثناء عمل المشغّل. لإنهاء الجلسة اضغط " + EndHotkeyText + ".")
	return b.String()
}

// Titles of the tool windows (English and Arabic together).
const (
	ChatTitle  = "Nigafiy support chat / محادثة الدعم"
	AskTitle   = "Nigafiy support question / سؤال من الدعم"
	SendLabel  = "Send / إرسال"
	OKLabel    = "OK / موافق"
	YesLabel   = "Yes / نعم"
	NoLabel    = "No / لا"
	YouLabel   = "You / أنت"
	ReplyLabel = "Reply / الرد"
)

// ChatTranscript renders the chat window's history.
func ChatTranscript(lines []ChatLine) string {
	var b strings.Builder
	for i, l := range lines {
		if i > 0 {
			b.WriteString("\r\n")
		}
		fmt.Fprintf(&b, "%s: %s", Clean(l.From, 80), strings.ReplaceAll(CleanMultiline(l.Text, MaxChatText), "\n", "\r\n  "))
	}
	return b.String()
}
