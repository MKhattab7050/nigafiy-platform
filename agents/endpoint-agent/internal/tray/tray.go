// Package tray is the Nigafiy icon in the notification area of the signed-in user's desktop:
// "Request help…" (the person writes a note for IT), the computer's Nigafiy ID, and "About
// Nigafiy" with what IT can and cannot do here. It runs where the desktop work runs: in the agent
// itself, or in the session helper when the agent is the Windows service. A minimal tray: builder
// work on the user's side ("IT activity", past recordings) extends it.
package tray

import (
	"errors"
	"fmt"
	"strings"
)

// ErrUnsupported: no tray on this platform (Linux and macOS have no tray here yet).
var ErrUnsupported = errors.New("the Nigafiy tray icon is available on Windows only")

type Options struct {
	// OnRequestHelp runs when the person picks "Request help…" (it asks for the note itself).
	OnRequestHelp func()
}

// Menu item ids.
const (
	ItemRequestHelp = 1 + iota
	ItemID
	ItemAbout
)

// MenuLabels: the tray menu, English then Arabic on each line (the user's language is unknown here).
func MenuLabels(nigafiyID string) map[int]string {
	return map[int]string{
		ItemRequestHelp: "Request help… · طلب مساعدة…",
		ItemID:          "Nigafiy ID: " + FormatID(nigafiyID),
		ItemAbout:       "About Nigafiy · حول Nigafiy",
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
