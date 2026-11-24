// Package tray is the Nigafiy icon in the notification area of the signed-in user's desktop:
// "Request help…" (the person writes a note for IT), the computer's Nigafiy ID, and "About
// Nigafiy" with what IT can and cannot do here, "IT activity…" (the sessions, shells, scripts,
// file transfers and update installs of the last 30 days), "End current session" (the remote
// session and every remote shell, as the banner's End button) and, when the computer's group
// allows it, "Past recordings…". It runs where the desktop work runs: in the agent itself, or in
// the session helper when the agent is the Windows service. No policy can hide it.
package tray

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrUnsupported: no tray on this platform (Linux and macOS have no tray here yet).
var ErrUnsupported = errors.New("the Nigafiy tray icon is available on Windows only")

type Options struct {
	// OnRequestHelp runs when the person picks "Request help…" (it asks for the note itself).
	OnRequestHelp func()
	// OnITActivity runs when the person picks "IT activity…" (what IT did on this computer).
	OnITActivity func()
	// OnRecordings runs on "Past recordings…" (shown only when the group allows it).
	OnRecordings func()
	// OnEndSession runs on "End current session" (enabled while a session or shell is open).
	OnEndSession func()
}

// Menu item ids.
const (
	ItemRequestHelp = 1 + iota
	ItemID
	ItemAbout
	ItemITActivity
	ItemRecordings
	ItemEndSession
)

// MenuEntry is one line of the tray menu.
type MenuEntry struct {
	ID     int
	Grayed bool
	// Separator before this entry.
	Separator bool
}

// MenuEntries is the tray menu. Request help, IT activity, End current session, the Nigafiy ID and
// About are always there (End current session is grayed when nothing is open); Past recordings
// only when the computer's group lets the person watch them.
func MenuEntries(recordings, sessionOpen bool) []MenuEntry {
	m := []MenuEntry{{ID: ItemRequestHelp}, {ID: ItemITActivity}}
	if recordings {
		m = append(m, MenuEntry{ID: ItemRecordings})
	}
	m = append(m, MenuEntry{ID: ItemEndSession, Grayed: !sessionOpen, Separator: true})
	m = append(m, MenuEntry{ID: ItemID, Grayed: true, Separator: true}, MenuEntry{ID: ItemAbout})
	return m
}

// MenuLabels: the tray menu, English then Arabic on each line (the user's language is unknown here).
func MenuLabels(nigafiyID string) map[int]string {
	return map[int]string{
		ItemRequestHelp: "Request help… · طلب مساعدة…",
		ItemID:          "Nigafiy ID: " + FormatID(nigafiyID),
		ItemAbout:       "About Nigafiy · حول Nigafiy",
		ItemITActivity:  "IT activity… · نشاط تقنية المعلومات…",
		ItemRecordings:  "Past recordings… · التسجيلات السابقة…",
		ItemEndSession:  "End current session · إنهاء الجلسة الحالية",
	}
}

// Tooltip: what hovering the icon shows.
func Tooltip(nigafiyID string) string {
	if nigafiyID == "" {
		return "Nigafiy"
	}
	return "Nigafiy · ID " + FormatID(nigafiyID)
}

// FormatID shows a 9-digit ID in groups of three, the way it is read out ("123 456 789").
func FormatID(id string) string {
	if len(id) != 9 {
		if id == "" {
			return "—"
		}
		return id
	}
	return id[:3] + " " + id[3:6] + " " + id[6:]
}

// AboutText: the About box. Always says that remote sessions are visible here.
func AboutText(nigafiyID, server string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "This computer is managed with Nigafiy.\nNigafiy ID: %s\n", FormatID(nigafiyID))
	if server != "" {
		fmt.Fprintf(&b, "Server: %s\n", server)
	}
	b.WriteString("\nWhen IT connects, a bar on the screen shows who is connected and why, with an End session button.\n" +
		"Ctrl+Alt+Shift+E also ends a session. Typed text and file contents are never logged.\n\n")
	b.WriteString("هذا الحاسوب مُدار بواسطة Nigafiy.\n")
	fmt.Fprintf(&b, "معرّف Nigafiy: %s\n", FormatID(nigafiyID))
	b.WriteString("عند اتصال فريق تقنية المعلومات يظهر شريط على الشاشة يبيّن من المتصل وسبب الاتصال مع زر إنهاء الجلسة.\n" +
		"يمكن أيضًا إنهاء الجلسة بالضغط على Ctrl+Alt+Shift+E. لا يُسجَّل النص المكتوب ولا محتوى الملفات.")
	return b.String()
}

// HelpPrompt: the question the "Request help" dialog asks.
const HelpPrompt = "Describe what you need help with. Your IT team sees this note in Nigafiy and can start a support session that you accept.\n\n" +
	"صف ما تحتاج المساعدة فيه. يرى فريق تقنية المعلومات هذه الملاحظة في Nigafiy ويمكنه بدء جلسة دعم توافق عليها."

// ActivityItem is one row of the "IT activity" list (POST /agent/it-activity).
type ActivityItem struct {
	Kind    string  `json:"kind"` // session | shell | job | file_transfer | patch
	By      string  `json:"by"`
	What    string  `json:"what"`
	Reason  *string `json:"reason"`
	At      string  `json:"at"`
	EndedAt *string `json:"ended_at"`
}

// ActivityText is the "IT activity" window: what IT did on this computer in the last 30 days
// (remote sessions, remote shells, scripts), newest first, in local time.
func ActivityText(items []ActivityItem, loc *time.Location) string {
	var b strings.Builder
	b.WriteString("What IT did on this computer in the last 30 days. / ما قام به فريق تقنية المعلومات على هذا الحاسوب خلال آخر 30 يومًا.\n")
	if len(items) == 0 {
		b.WriteString("\nNothing. / لا شيء.")
		return b.String()
	}
	for _, it := range items {
		when := it.At
		if t, err := time.Parse(time.RFC3339Nano, it.At); err == nil {
			when = t.In(loc).Format("2006-01-02 15:04")
		}
		kind := map[string]string{
			"session":       "Remote support session / جلسة دعم عن بُعد",
			"shell":         "Remote shell / سطر أوامر عن بُعد",
			"job":           "Script / برنامج نصي",
			"file_transfer": "File transfer / نقل ملف",
			"patch":         "Updates installed / تثبيت تحديثات",
		}[it.Kind]
		if kind == "" {
			kind = it.Kind
		}
		fmt.Fprintf(&b, "\n%s · %s · %s", when, kind, it.By)
		if (it.Kind == "job" || it.Kind == "file_transfer" || it.Kind == "patch") && it.What != "" {
			fmt.Fprintf(&b, " · %s", strings.TrimPrefix(it.What, "Script: "))
		}
		if it.Reason != nil && *it.Reason != "" {
			fmt.Fprintf(&b, " · %s", *it.Reason)
		}
		if it.EndedAt == nil && (it.Kind == "session" || it.Kind == "shell") {
			b.WriteString(" · open now / مفتوح الآن")
		}
	}
	return b.String()
}
