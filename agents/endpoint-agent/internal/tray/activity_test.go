package tray

import (
	"strings"
	"testing"
	"time"
)

func TestActivityTextListsSessionsShellsAndScripts(t *testing.T) {
	reason := "Printer queue"
	ended := "2026-11-24T10:30:00.000Z"
	items := []ActivityItem{
		{Kind: "shell", By: "admin@corp.example", What: "Remote shell", Reason: &reason, At: "2026-11-24T10:00:00.000Z"},
		{Kind: "session", By: "tech@corp.example", What: "Remote support session", At: "2026-11-23T09:00:00.000Z", EndedAt: &ended},
		{Kind: "job", By: "admin@corp.example", What: "Script: Clear temp", Reason: &reason, At: "2026-11-22T08:00:00.000Z"},
	}
	text := ActivityText(items, time.UTC)
	for _, want := range []string{
		"2026-11-24 10:00 · Remote shell / سطر أوامر عن بُعد · admin@corp.example · Printer queue · open now",
		"2026-11-23 09:00 · Remote support session / جلسة دعم عن بُعد · tech@corp.example",
		"2026-11-22 08:00 · Script / برنامج نصي · admin@corp.example · Clear temp · Printer queue",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("lacks %q:\n%s", want, text)
		}
	}
	if !strings.Contains(ActivityText(nil, time.UTC), "Nothing.") {
		t.Fatal("empty list")
	}
	if MenuLabels("123456789")[ItemITActivity] != "IT activity… · نشاط تقنية المعلومات…" {
		t.Fatal("menu label")
	}
}
