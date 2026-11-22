// Package userui shows the two windows a remote support session puts in front of the person at the
// computer: the consent dialog ("<operator> asks to view and control this screen — Allow /
// Decline", declined automatically when nobody answers) and the session banner that stays on the
// screen for the whole session (operator, reason, "End session"). Nothing here is optional: no
// policy, flag or role can hide the banner.
//
// Windows: native Win32 windows (pure Go syscalls) in the interactive desktop of the process that
// calls it — the agent itself when it runs in the user's session, or the session helper the agent
// service starts there. Linux: zenity or kdialog. macOS: osascript dialogs.
package userui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

type ConsentAnswer string

const (
	Accepted ConsentAnswer = "accepted"
	Denied   ConsentAnswer = "denied"
	TimedOut ConsentAnswer = "timeout"
)

// ConsentRequest: who asks, why, and how long the person has to answer.
type ConsentRequest struct {
	SessionID      string `json:"session_id"`
	Operator       string `json:"operator"`
	Reason         string `json:"reason"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

// BannerInfo is what the banner shows for the whole session.
type BannerInfo struct {
	SessionID string `json:"session_id"`
	Operator  string `json:"operator"`
	Reason    string `json:"reason"`
	// Control: the operator may use mouse and keyboard (otherwise "view only").
	Control bool `json:"control"`
}

// ErrUnavailable: there is no way to show a window here (no interactive desktop, no dialog tool).
var ErrUnavailable = errors.New("no interactive desktop is available to show the window")

const (
	MinConsentTimeout     = 10
	MaxConsentTimeout     = 300
	DefaultConsentTimeout = 60
	maxField              = 200
)

// Clean prepares text for a dialog: control characters become spaces and long text is cut.
func Clean(s string, max int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n >= max {
			b.WriteString("…")
			break
		}
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 || r == utf8.RuneError {
			r = ' '
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

// Normalize bounds the timeout and cleans the text fields.
func (r ConsentRequest) Normalize() ConsentRequest {
	if r.TimeoutSeconds <= 0 {
		r.TimeoutSeconds = DefaultConsentTimeout
	}
	r.TimeoutSeconds = max(MinConsentTimeout, min(MaxConsentTimeout, r.TimeoutSeconds))
	r.Operator = Clean(r.Operator, maxField)
	if r.Operator == "" {
		r.Operator = "An IT operator"
	}
	r.Reason = Clean(r.Reason, maxField)
	return r
}

func (b BannerInfo) Normalize() BannerInfo {
	b.Operator = Clean(b.Operator, maxField)
	if b.Operator == "" {
		b.Operator = "An IT operator"
	}
	b.Reason = Clean(b.Reason, maxField)
	return b
}

// Titles and texts: English and Arabic together (the agent does not know the user's language).
const (
	ConsentTitle = "Nigafiy remote support request / طلب دعم عن بُعد"
	BannerTitle  = "Nigafiy remote support session / جلسة دعم عن بُعد"
	AllowLabel   = "Allow / سماح"
	DeclineLabel = "Decline / رفض"
	EndLabel     = "End session / إنهاء الجلسة"
)

// ConsentText is the dialog body. secondsLeft < 0 leaves the countdown out (tools with their own).
func ConsentText(r ConsentRequest, secondsLeft int) string {
	r = r.Normalize()
	var b strings.Builder
	fmt.Fprintf(&b, "%s asks to view and control this screen.", r.Operator)
	if r.Reason != "" {
		fmt.Fprintf(&b, "\nReason: %s", r.Reason)
	}
	b.WriteString("\nThe session is logged. You can end it at any time with the End session button.")
	if secondsLeft >= 0 {
		fmt.Fprintf(&b, "\nDeclined automatically in %d s if you do not answer.", secondsLeft)
	}
	fmt.Fprintf(&b, "\n\n%s يطلب مشاهدة هذه الشاشة والتحكم بها.", r.Operator)
	if r.Reason != "" {
		fmt.Fprintf(&b, "\nالسبب: %s", r.Reason)
	}
	b.WriteString("\nتُسجَّل الجلسة، ويمكنك إنهاؤها في أي وقت بزر إنهاء الجلسة.")
	if secondsLeft >= 0 {
		fmt.Fprintf(&b, "\nيُرفض الطلب تلقائياً بعد %d ثانية إن لم تُجب.", secondsLeft)
	}
	return b.String()
}

// BannerText is the banner body.
func BannerText(i BannerInfo) string {
	i = i.Normalize()
	mode, modeAr := "can see and control this screen", "يشاهد هذه الشاشة ويتحكم بها"
	if !i.Control {
		mode, modeAr = "can see this screen (view only)", "يشاهد هذه الشاشة (مشاهدة فقط)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s.", i.Operator, mode)
	if i.Reason != "" {
		fmt.Fprintf(&b, " Reason: %s", i.Reason)
	}
	fmt.Fprintf(&b, "\n%s %s.", i.Operator, modeAr)
	if i.Reason != "" {
		fmt.Fprintf(&b, " السبب: %s", i.Reason)
	}
	return b.String()
}

// UI is implemented per platform (ui_windows.go, ui_unix.go).
type UI interface {
	// Consent asks the person at the screen. A timeout is TimedOut, closing the dialog is Denied.
	Consent(ctx context.Context, req ConsentRequest) (ConsentAnswer, error)
	// ShowBanner shows (or replaces) the session banner; onEnd runs once when the person presses
	// "End session". The banner stays until HideBanner.
	ShowBanner(info BannerInfo, onEnd func()) error
	// HideBanner removes the banner of that session (no-op for another session).
	HideBanner(sessionID string)
}

// New returns this platform's UI.
func New() UI { return newPlatformUI() }
