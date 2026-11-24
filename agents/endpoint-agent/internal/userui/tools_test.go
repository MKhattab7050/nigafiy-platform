package userui

import (
	"errors"
	"strings"
	"testing"
)

// Transparency pins: no field of BannerInfo can remove the operator, the recording mark or the
// privacy-screen text.

func TestBannerNamesEveryOperatorAndTheRecordingMark(t *testing.T) {
	text := BannerText(BannerInfo{Operator: "a@corp.example", Operators: []string{"a@corp.example", "b@corp.example"}, Reason: "printer", Recording: true, EndHotkey: true})
	for _, want := range []string{"a@corp.example", "b@corp.example", RecordingMark, EndHotkeyText, "printer"} {
		if !strings.Contains(text, want) {
			t.Fatalf("banner lacks %q:\n%s", want, text)
		}
	}
	if !strings.HasPrefix(BannerInfo{Recording: true}.Title(), "● REC") {
		t.Fatal("recording mark missing from the banner title")
	}
	if strings.Contains(BannerText(BannerInfo{Operator: "a"}), RecordingMark) {
		t.Fatal("recording mark shown without a recording")
	}
}

func TestBannerShowsPrivacyAndBlockedInput(t *testing.T) {
	text := BannerText(BannerInfo{Operator: "a", PrivacyScreen: true, InputBlocked: true})
	if !strings.Contains(text, "privacy screen") || !strings.Contains(text, "paused") {
		t.Fatalf("banner does not say what is on:\n%s", text)
	}
}

func TestPrivacyTextNeverEmptyAndSaysHowToEnd(t *testing.T) {
	for _, info := range []BannerInfo{{}, {Operator: "  "}, {Operator: "tech@corp.example", Reason: "update"}, {Operators: []string{"x", "y"}}} {
		text := PrivacyText(info)
		if !strings.Contains(text, "IT support session in progress") || !strings.Contains(text, "جلسة دعم فني جارية") || !strings.Contains(text, EndHotkeyText) {
			t.Fatalf("privacy text incomplete for %+v:\n%s", info, text)
		}
	}
	text := PrivacyText(BannerInfo{Operator: "tech@corp.example", Reason: "update drivers"})
	if !strings.Contains(text, "tech@corp.example") || !strings.Contains(text, "reason: update drivers") {
		t.Fatalf("operator / reason missing:\n%s", text)
	}
}

func TestOverlayValidate(t *testing.T) {
	disp := DisplayRect{W: 1920, H: 1080}
	ok := OverlayOp{Op: "stroke", Display: disp, Points: [][2]float64{{0.1, 0.1}, {0.2, 0.3}}}
	if err := ok.Validate(); err != nil || ok.Color != "#ff2d55" || ok.Width != 4 {
		t.Fatalf("%v %+v", err, ok)
	}
	if r, g, b := ok.RGB(); r != 0xff || g != 0x2d || b != 0x55 {
		t.Fatalf("rgb %d %d %d", r, g, b)
	}
	for _, bad := range []OverlayOp{
		{Op: "stroke", Display: disp},
		{Op: "stroke", Display: disp, Points: [][2]float64{{1.5, 0}}},
		{Op: "pointer", Display: disp, X: -1},
		{Op: "pointer", Display: disp, X: 0.5, Y: 0.5, Color: "red"},
		{Op: "erase", Display: disp},
		{Op: "clear"},
	} {
		if bad.Validate() == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}

func TestAskNormalizeAndCommands(t *testing.T) {
	r := AskRequest{Operator: "", Text: "Save your work?\r\nThen press Yes.", Kind: "weird", TimeoutSeconds: 9999}.Normalize()
	if r.Kind != "ok" || r.TimeoutSeconds != 600 || r.Operator == "" || !strings.Contains(r.Text, "\n") {
		t.Fatalf("%+v", r)
	}
	has := func(name string) func(string) (string, error) {
		return func(n string) (string, error) {
			if n == name {
				return "/usr/bin/" + n, nil
			}
			return "", errors.New("missing")
		}
	}
	tool, args, err := AskCommand("linux", AskRequest{Operator: "op", Text: "Yes?", Kind: "yes_no"}, false, has("zenity"))
	if err != nil || !strings.HasSuffix(tool, "zenity") || !contains(args, "--question") {
		t.Fatalf("%s %v %v", tool, args, err)
	}
	if a := InterpretAsk(tool, "yes_no", "", 1, false); a.Answer != "no" {
		t.Fatalf("%+v", a)
	}
	if a := InterpretAsk(tool, "text", "fine thanks\n", 0, false); a.Answer != "text" || a.Text != "fine thanks" {
		t.Fatalf("%+v", a)
	}
	tool, args, _ = AskCommand("darwin", AskRequest{Operator: "op", Text: `say "hi"`}, true, has("none"))
	if !strings.HasSuffix(tool, "osascript") || !strings.Contains(args[1], `default answer ""`) || !strings.Contains(args[1], `\"hi\"`) {
		t.Fatalf("%s %v", tool, args)
	}
	if a := InterpretAsk(tool, "text", "button returned:Send / إرسال, text returned:ok then, gave up:false", 0, false); a.Text != "ok then" {
		t.Fatalf("%+v", a)
	}
	if _, _, err := AskCommand("linux", AskRequest{}, false, has("none")); err == nil {
		t.Fatal("no dialog tool and no error")
	}
}

func TestChatTranscript(t *testing.T) {
	got := ChatTranscript([]ChatLine{{From: "op", Text: "hello\nthere"}, {From: YouLabel, Text: "hi"}})
	if got != "op: hello\r\n  there\r\n"+YouLabel+": hi" {
		t.Fatalf("%q", got)
	}
}
