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
	// Mode: "" (or "consent") the person must accept, no answer = declined; "refuse": an unattended
	// session the person may refuse within the timeout, no answer = the session starts.
	Mode string `json:"mode,omitempty"`
	// Permissions, when known, are listed in the dialog.
	Permissions *Permissions `json:"permissions,omitempty"`
}

// ModeRefuse is the unattended "user may refuse within N seconds" dialog.
const ModeRefuse = "refuse"

// Permissions are the flags of the session's permission profile (Fleet Pro). The agent enforces
// them and shows them on the banner; none of them can hide the banner or its End button.
type Permissions struct {
	View          bool `json:"view"`
	Control       bool `json:"control"`
	ClipboardIn   bool `json:"clipboard_in"`  // operator → this computer
	ClipboardOut  bool `json:"clipboard_out"` // this computer → operator
	Files         bool `json:"files"`
	Audio         bool `json:"audio"`
	Record        bool `json:"record"`
	Restart       bool `json:"restart"`
	PrivacyScreen bool `json:"privacy_screen"`
	BlockInput    bool `json:"block_input"`
	Shell         bool `json:"shell"`
}

// Labels lists what the permissions allow, in English and in Arabic (same order).
func (p Permissions) Labels() (en, ar []string) {
	add := func(on bool, e, a string) {
		if on {
			en, ar = append(en, e), append(ar, a)
		}
	}
	add(p.View, "see the screen", "رؤية الشاشة")
	add(p.Control, "mouse and keyboard", "الفأرة ولوحة المفاتيح")
	add(p.ClipboardIn, "clipboard to this computer", "الحافظة إلى هذا الحاسوب")
	add(p.ClipboardOut, "clipboard from this computer", "الحافظة من هذا الحاسوب")
	add(p.Files, "file transfer", "نقل الملفات")
	add(p.Audio, "audio", "الصوت")
	add(p.Record, "recording", "التسجيل")
	add(p.Restart, "restart", "إعادة التشغيل")
	add(p.PrivacyScreen, "privacy screen", "شاشة الخصوصية")
	add(p.BlockInput, "block your input", "قفل إدخالك")
	add(p.Shell, "remote shell", "سطر الأوامر عن بُعد")
	return en, ar
}

// BannerInfo is what the banner shows for the whole session.
type BannerInfo struct {
	SessionID string `json:"session_id"`
	Operator  string `json:"operator"`
	Reason    string `json:"reason"`
	// Control: the operator may use mouse and keyboard (otherwise "view only").
	Control bool `json:"control"`
	// Permissions of the session's profile, listed on the banner while the session lasts.
	Permissions *Permissions `json:"permissions,omitempty"`
	// Profile is the profile's name (shown with the permissions).
	Profile string `json:"profile,omitempty"`
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
	if r.Mode != ModeRefuse {
		r.Mode = ""
	}
	return r
}

func (b BannerInfo) Normalize() BannerInfo {
	b.Operator = Clean(b.Operator, maxField)
	if b.Operator == "" {
		b.Operator = "An IT operator"
	}
	b.Reason = Clean(b.Reason, maxField)
	b.Profile = Clean(b.Profile, 60)
	if b.Permissions != nil {
		// Mouse and keyboard only when both say so.
		b.Control = b.Control && b.Permissions.Control
	}
	return b
}

// Titles and texts: English and Arabic together (the agent does not know the user's language).
const (
	ConsentTitle = "Nigafiy remote support request / طلب دعم عن بُعد"
	BannerTitle  = "Nigafiy remote support session / جلسة دعم عن بُعد"
	AllowLabel   = "Allow / سماح"
	DeclineLabel = "Decline / رفض"
	EndLabel     = "End session / إنهاء الجلسة"
	// The unattended refuse window.
	RefuseTitle   = "Nigafiy remote support / دعم عن بُعد"
	StartNowLabel = "Start now / ابدأ الآن"
	RefuseLabel   = "Refuse / رفض"
)

// Labels of the dialog for this request: title, accept button, refuse button.
func (r ConsentRequest) Labels() (title, accept, refuse string) {
	if r.Mode == ModeRefuse {
		return RefuseTitle, StartNowLabel, RefuseLabel
	}
	return ConsentTitle, AllowLabel, DeclineLabel
}

// TimeoutNote is the line about what happens when nobody answers (tools that count down themselves).
func (r ConsentRequest) TimeoutNote() string {
	if r.Mode == ModeRefuse {
		return fmt.Sprintf("The session starts in %d s unless you refuse. / تبدأ الجلسة بعد %d ثانية ما لم ترفض.", r.TimeoutSeconds, r.TimeoutSeconds)
	}
	return fmt.Sprintf("Declined automatically in %d s.", r.TimeoutSeconds)
}

// ConsentText is the dialog body. secondsLeft < 0 leaves the countdown out (tools with their own).
func ConsentText(r ConsentRequest, secondsLeft int) string {
	r = r.Normalize()
	if r.Mode == ModeRefuse {
		return refuseText(r, secondsLeft)
	}
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

// refuseText: an unattended session that starts unless the person refuses in time.
func refuseText(r ConsentRequest, secondsLeft int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s will connect to this computer for IT support.", r.Operator)
	if r.Reason != "" {
		fmt.Fprintf(&b, "\nReason: %s", r.Reason)
	}
	if r.Permissions != nil {
		en, _ := r.Permissions.Labels()
		fmt.Fprintf(&b, "\nAllowed: %s.", strings.Join(en, ", "))
	}
	b.WriteString("\nPress Refuse to stop it. The session is logged and you can end it at any time.")
	if secondsLeft >= 0 {
		fmt.Fprintf(&b, "\nThe session starts in %d s unless you refuse.", secondsLeft)
	}
	fmt.Fprintf(&b, "\n\n%s سيتصل بهذا الحاسوب للدعم الفني.", r.Operator)
	if r.Reason != "" {
		fmt.Fprintf(&b, "\nالسبب: %s", r.Reason)
	}
	if r.Permissions != nil {
		_, ar := r.Permissions.Labels()
		fmt.Fprintf(&b, "\nالمسموح: %s.", strings.Join(ar, "، "))
	}
	b.WriteString("\nاضغط رفض لإيقافها. تُسجَّل الجلسة ويمكنك إنهاؤها في أي وقت.")
	if secondsLeft >= 0 {
		fmt.Fprintf(&b, "\nتبدأ الجلسة بعد %d ثانية ما لم ترفض.", secondsLeft)
	}
	return b.String()
}

// BannerText is the banner body: who, why, and (when the session has a profile) what is allowed.
// It is shown for the whole session whatever the permissions are.
func BannerText(i BannerInfo) string {
	i = i.Normalize()
	mode, modeAr := "can see and control this screen", "يشاهد هذه الشاشة ويتحكم بها"
	if !i.Control {
		mode, modeAr = "can see this screen (view only)", "يشاهد هذه الشاشة (مشاهدة فقط)"
	}
	var en, ar []string
	if i.Permissions != nil {
		en, ar = i.Permissions.Labels()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s.", i.Operator, mode)
	if i.Reason != "" {
		fmt.Fprintf(&b, " Reason: %s", i.Reason)
	}
	if i.Permissions != nil {
		fmt.Fprintf(&b, "\nAllowed%s: %s.", profileSuffix(i.Profile), strings.Join(en, ", "))
	}
	fmt.Fprintf(&b, "\n%s %s.", i.Operator, modeAr)
	if i.Reason != "" {
		fmt.Fprintf(&b, " السبب: %s", i.Reason)
	}
	if i.Permissions != nil {
		fmt.Fprintf(&b, "\nالمسموح%s: %s.", profileSuffix(i.Profile), strings.Join(ar, "، "))
	}
	return b.String()
}

func profileSuffix(profile string) string {
	if profile == "" {
		return ""
	}
	return " (" + profile + ")"
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
