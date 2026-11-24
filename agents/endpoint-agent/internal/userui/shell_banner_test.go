package userui

import (
	"strings"
	"testing"
)

// The shell lines are always on the banner: with a remote desktop session, alone, and whatever
// the session's profile allows. Names and reasons are cleaned like the operator's.
func TestBannerNamesEveryOpenShell(t *testing.T) {
	perms := Permissions{View: true}
	rd := BannerInfo{SessionID: "rd", Operator: "tech@corp.example", Reason: "help", Permissions: &perms,
		Shells: []ShellLine{{Operator: "admin@corp.example\x07", Reason: "logs\r\nrm -rf"}}}
	text := BannerText(rd)
	for _, want := range []string{"tech@corp.example can see this screen", "Shell open by admin@corp.example.", "Reason: logs  rm -rf.", "recorded in a transcript", "سطر أوامر مفتوح من admin@corp.example."} {
		if !strings.Contains(text, want) {
			t.Fatalf("lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "\x07") || strings.Contains(text, "logs\r") {
		t.Fatal("not cleaned")
	}

	only := BannerInfo{SessionID: "nigafiy-shell", ShellOnly: true, EndHotkey: true, Shells: []ShellLine{{Operator: "", Reason: "x"}, {Operator: "b@c.d"}}}
	text = BannerText(only)
	if strings.Contains(text, "can see") || !strings.Contains(text, "Shell open by An IT operator.") || !strings.Contains(text, "Shell open by b@c.d.") || !strings.Contains(text, "Ctrl+Alt+Shift+E ends the shell") {
		t.Fatalf("shell-only:\n%s", text)
	}
	if only.Normalize().Title() != ShellBannerTitle {
		t.Fatal("title")
	}
	// ShellOnly without shells is a normal session banner (nothing hides the session lines).
	if txt := BannerText(BannerInfo{Operator: "x@y.z", ShellOnly: true}); !strings.Contains(txt, "x@y.z can see") {
		t.Fatalf("%s", txt)
	}
	many := BannerInfo{ShellOnly: true}
	for range 10 {
		many.Shells = append(many.Shells, ShellLine{Operator: "o@p.q"})
	}
	if n := strings.Count(BannerText(many), "Shell open by"); n != MaxShellLines {
		t.Fatalf("%d lines", n)
	}
}
