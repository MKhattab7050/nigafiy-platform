package userui

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func has(names ...string) func(string) (string, error) {
	return func(n string) (string, error) {
		for _, x := range names {
			if x == n {
				return "/usr/bin/" + n, nil
			}
		}
		return "", errors.New("not found")
	}
}

func TestConsentNormalizeAndTexts(t *testing.T) {
	r := ConsentRequest{Operator: "ali@corp.example\n\x07", Reason: "printer\r\ndriver", TimeoutSeconds: 2}.Normalize()
	if r.TimeoutSeconds != MinConsentTimeout || strings.ContainsAny(r.Operator+r.Reason, "\r\n\x07") {
		t.Fatalf("normalize: %+v", r)
	}
	if r2 := (ConsentRequest{TimeoutSeconds: 10_000}).Normalize(); r2.TimeoutSeconds != MaxConsentTimeout || r2.Operator == "" {
		t.Fatalf("normalize upper bound / operator default: %+v", r2)
	}
	text := ConsentText(r, 42)
	for _, want := range []string{"ali@corp.example", "asks to view and control", "Reason: printer", "42 s", "يطلب مشاهدة", "42 ثانية"} {
		if !strings.Contains(text, want) {
			t.Fatalf("consent text lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(ConsentText(r, -1), "automatically") {
		t.Fatal("countdown must be left out when the tool counts itself")
	}
	b := BannerText(BannerInfo{Operator: "ali", Reason: "printer", Control: true})
	if !strings.Contains(b, "ali can see and control this screen. Reason: printer") || !strings.Contains(b, "يتحكم") {
		t.Fatalf("banner text: %s", b)
	}
	if !strings.Contains(BannerText(BannerInfo{Operator: "ali"}), "view only") {
		t.Fatal("view-only banner must say so")
	}
}

func TestDialogCommandsPerTool(t *testing.T) {
	r := ConsentRequest{Operator: `x" & do shell script "rm -rf ~`, TimeoutSeconds: 30}
	tool, args, err := ConsentCommand("linux", r, has("zenity", "kdialog"))
	if err != nil || tool != "/usr/bin/zenity" || !contains(args, "--timeout=30") || !contains(args, "--question") || !contains(args, "--default-cancel") {
		t.Fatalf("zenity consent: %s %v %v", tool, args, err)
	}
	tool, args, err = ConsentCommand("linux", r, has("kdialog"))
	if err != nil || tool != "/usr/bin/kdialog" || !contains(args, "--warningyesno") {
		t.Fatalf("kdialog consent: %s %v %v", tool, args, err)
	}
	if _, _, err := ConsentCommand("linux", r, has()); err == nil {
		t.Fatal("no tool must be an error, never a silent accept")
	}
	tool, args, err = ConsentCommand("darwin", r, has())
	if err != nil || tool != "/usr/bin/osascript" || len(args) != 2 || !strings.Contains(args[1], "giving up after 30") {
		t.Fatalf("osascript consent: %v %v", args, err)
	}
	// The operator text is one AppleScript string literal: the quote is escaped.
	if !strings.Contains(args[1], `x\" & do shell script \"rm -rf ~`) {
		t.Fatalf("AppleScript quoting failed: %s", args[1])
	}
	tool, args, err = BannerCommand("linux", BannerInfo{Operator: "ali"}, has("zenity"))
	if err != nil || !contains(args, "--info") || !contains(args, "--ok-label="+EndLabel) {
		t.Fatalf("zenity banner: %s %v %v", tool, args, err)
	}
	if _, args, _ := BannerCommand("darwin", BannerInfo{Operator: "ali"}, has()); !strings.Contains(args[1], EndLabel) {
		t.Fatalf("osascript banner: %v", args)
	}
	if _, _, err := BannerCommand("linux", BannerInfo{}, has()); err == nil {
		t.Fatal("no banner tool must be an error")
	}
}

func TestInterpretConsent(t *testing.T) {
	cases := []struct {
		tool, out string
		code      int
		killed    bool
		want      ConsentAnswer
	}{
		{"/usr/bin/zenity", "", 0, false, Accepted},
		{"/usr/bin/zenity", "", 1, false, Denied},
		{"/usr/bin/zenity", "", 5, false, TimedOut},
		{"/usr/bin/kdialog", "", 0, false, Accepted},
		{"/usr/bin/kdialog", "", 1, false, Denied},
		{"/usr/bin/kdialog", "", 0, true, TimedOut},
		{"/usr/bin/osascript", "button returned:" + AllowLabel + ", gave up:false", 0, false, Accepted},
		{"/usr/bin/osascript", "button returned:, gave up:true", 0, false, TimedOut},
		{"/usr/bin/osascript", "", 1, false, Denied},
	}
	for _, c := range cases {
		if got := InterpretConsent(c.tool, c.out, c.code, c.killed); got != c.want {
			t.Errorf("%s %q %d %v = %s, want %s", c.tool, c.out, c.code, c.killed, got, c.want)
		}
	}
	if !BannerEndedByUser(nil) || BannerEndedByUser(errors.New("x")) {
		t.Fatal("BannerEndedByUser")
	}
	_ = exec.ErrNotFound
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
