package userui

import (
	"strings"
	"testing"
)

func TestBannerListsPermissionsInBothLanguages(t *testing.T) {
	p := &Permissions{View: true, Control: true, ClipboardOut: true, Shell: true}
	b := BannerText(BannerInfo{Operator: "ali", Reason: "VPN", Control: true, Permissions: p, Profile: "Support"})
	for _, want := range []string{"ali can see and control this screen", "Reason: VPN", "Allowed (Support): see the screen, mouse and keyboard, clipboard from this computer, remote shell.",
		"المسموح (Support): رؤية الشاشة، الفأرة ولوحة المفاتيح، الحافظة من هذا الحاسوب، سطر الأوامر عن بُعد."} {
		if !strings.Contains(b, want) {
			t.Fatalf("banner misses %q:\n%s", want, b)
		}
	}
	if strings.Contains(b, "clipboard to this computer") || strings.Contains(b, "file transfer") {
		t.Fatalf("banner lists permissions that were not granted:\n%s", b)
	}
	// A view-only profile turns "control" off even when the server's control flag is on.
	v := BannerText(BannerInfo{Operator: "ali", Control: true, Permissions: &Permissions{View: true}})
	if !strings.Contains(v, "view only") || strings.Contains(v, "mouse and keyboard") {
		t.Fatalf("view-only banner: %s", v)
	}
	// No profile (older server): the banner is as before, without a permissions line.
	if old := BannerText(BannerInfo{Operator: "ali", Control: true}); strings.Contains(old, "Allowed") {
		t.Fatalf("banner without profile: %s", old)
	}
}

func TestRefuseWindowDialog(t *testing.T) {
	r := ConsentRequest{Operator: "ops@corp", Reason: "patch night", TimeoutSeconds: 20, Mode: ModeRefuse, Permissions: &Permissions{View: true, Restart: true}}
	text := ConsentText(r, 12)
	for _, want := range []string{"ops@corp will connect to this computer", "Reason: patch night", "Allowed: see the screen, restart.", "Press Refuse", "starts in 12 s unless you refuse", "اضغط رفض", "تبدأ الجلسة بعد 12 ثانية"} {
		if !strings.Contains(text, want) {
			t.Fatalf("refuse text misses %q:\n%s", want, text)
		}
	}
	title, accept, refuse := r.Labels()
	if title != RefuseTitle || accept != StartNowLabel || refuse != RefuseLabel {
		t.Fatalf("labels %q %q %q", title, accept, refuse)
	}
	if !strings.Contains(r.Normalize().TimeoutNote(), "starts in 20 s unless you refuse") {
		t.Fatalf("note %q", r.TimeoutNote())
	}
	// Consent mode is unchanged.
	if _, a, d := (ConsentRequest{}).Labels(); a != AllowLabel || d != DeclineLabel {
		t.Fatal("consent labels changed")
	}
	if (ConsentRequest{Mode: "anything"}).Normalize().Mode != "" {
		t.Fatal("unknown modes must fall back to consent (the stricter one)")
	}

	tool, args, err := ConsentCommand("linux", r, has("zenity"))
	if err != nil || !contains(args, "--ok-label="+StartNowLabel) || !contains(args, "--cancel-label="+RefuseLabel) || !contains(args, "--timeout=20") || !contains(args, "--default-cancel") {
		t.Fatalf("zenity refuse: %s %v %v", tool, args, err)
	}
	// zenity: timeout (5) is "not refused" for the caller, Refuse (1) is a refusal.
	if InterpretConsent(tool, "", 5, false) != TimedOut || InterpretConsent(tool, "", 1, false) != Denied {
		t.Fatal("zenity answers")
	}
	_, mac, _ := ConsentCommand("darwin", r, has())
	if !strings.Contains(mac[1], StartNowLabel) || !strings.Contains(mac[1], "giving up after 20") {
		t.Fatalf("osascript refuse: %v", mac)
	}
	if InterpretConsent("/usr/bin/osascript", "button returned:"+StartNowLabel+", gave up:false", 0, false) != Accepted {
		t.Fatal("osascript Start now")
	}
	if InterpretConsent("/usr/bin/osascript", "button returned:, gave up:true", 0, false) != TimedOut {
		t.Fatal("osascript gave up")
	}
}
