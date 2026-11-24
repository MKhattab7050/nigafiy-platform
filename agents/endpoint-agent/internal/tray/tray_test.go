package tray

import (
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTextsSayWhoCanSeeThisComputer(t *testing.T) {
	if FormatID("123456789") != "123 456 789" || FormatID("") != "—" {
		t.Fatal("ID grouping")
	}
	about := AboutText("123456789", "https://it.example")
	for _, want := range []string{"123 456 789", "https://it.example", "End session", "Ctrl+Alt+Shift+E", "Nigafiy", "إنهاء الجلسة"} {
		if !strings.Contains(about, want) {
			t.Fatalf("about text lacks %q", want)
		}
	}
	labels := MenuLabels("987654321")
	if !strings.Contains(labels[ItemRequestHelp], "Request help") || !strings.Contains(labels[ItemRequestHelp], "طلب مساعدة") || labels[ItemID] != "Nigafiy ID: 987 654 321" {
		t.Fatalf("labels %v", labels)
	}
	if Tooltip("") != "Nigafiy" || !strings.Contains(HelpPrompt, "Nigafiy") {
		t.Fatal("tooltip / prompt")
	}
}

// Opt-in (NIGAFIY_UI_TEST=1, Windows): the real icon appears in the notification area for a
// moment, shows a balloon, and is removed again.
func TestWindowsTrayIconAppearsAndGoes(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("NIGAFIY_UI_TEST") != "1" {
		t.Skip("set NIGAFIY_UI_TEST=1 on Windows to show the real tray icon")
	}
	icon, err := Start(Options{})
	if err != nil {
		t.Fatal(err)
	}
	icon.SetInfo("123456789", "https://it.example")
	icon.Notify("Nigafiy", "Tray test: this icon goes away in 2 seconds")
	time.Sleep(2 * time.Second)
	done := make(chan struct{})
	go func() { icon.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not end the message loop")
	}
}
