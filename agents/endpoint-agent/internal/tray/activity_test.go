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

// The tray can never be hidden and its transparency items are always there: Request help, IT
// activity, End current session (grayed while nothing is open), the Nigafiy ID and About. Only
// "Past recordings…" depends on the group's policy.
func TestTrayMenuKeepsTheTransparencyItems(t *testing.T) {
	for _, rec := range []bool{false, true} {
		for _, open := range []bool{false, true} {
			ids := map[int]MenuEntry{}
			for _, e := range MenuEntries(rec, open) {
				ids[e.ID] = e
			}
			for _, must := range []int{ItemRequestHelp, ItemITActivity, ItemEndSession, ItemID, ItemAbout} {
				if _, ok := ids[must]; !ok {
					t.Fatalf("recordings=%v open=%v: item %d missing", rec, open, must)
				}
			}
			if ids[ItemITActivity].Grayed || ids[ItemRequestHelp].Grayed {
				t.Fatal("IT activity and Request help are never grayed")
			}
			if ids[ItemEndSession].Grayed == open {
				t.Fatalf("End current session grayed=%v while open=%v", ids[ItemEndSession].Grayed, open)
			}
			if _, ok := ids[ItemRecordings]; ok != rec {
				t.Fatalf("Past recordings shown=%v, allowed=%v", ok, rec)
			}
		}
	}
	l := MenuLabels("")
	if !strings.Contains(l[ItemEndSession], "End current session") || !strings.Contains(l[ItemEndSession], "إنهاء الجلسة الحالية") || !strings.Contains(l[ItemRecordings], "التسجيلات السابقة") {
		t.Fatalf("labels %v", l)
	}
}

func TestActivityTextListsFileTransfersAndUpdates(t *testing.T) {
	win := "Maintenance window: Saturday"
	ended := "2026-11-24T03:10:00.000Z"
	text := ActivityText([]ActivityItem{
		{Kind: "file_transfer", By: "tech@corp.example", What: `File sent to this computer: C:\Users\sami\fix.reg`, At: "2026-11-24T09:00:00.000Z", EndedAt: &ended},
		{Kind: "patch", By: "Nigafiy patching", What: "Updates: KB5050001, KB2267602", Reason: &win, At: "2026-11-24T03:00:00.000Z"},
	}, time.UTC)
	for _, want := range []string{
		`2026-11-24 09:00 · File transfer / نقل ملف · tech@corp.example · File sent to this computer: C:\Users\sami\fix.reg`,
		"2026-11-24 03:00 · Updates installed / تثبيت تحديثات · Nigafiy patching · Updates: KB5050001, KB2267602 · Maintenance window: Saturday",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "open now") {
		t.Fatal("transfers and installs are never 'open now'")
	}
}
