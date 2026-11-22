package clipboard

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
)

func look(names ...string) func(string) (string, error) {
	return func(n string) (string, error) {
		for _, x := range names {
			if x == n {
				return "/usr/bin/" + n, nil
			}
		}
		return "", errors.New("missing")
	}
}

func TestCheckLimits(t *testing.T) {
	if err := Check(strings.Repeat("ب", MaxChars)); err != nil {
		t.Fatalf("16000 Arabic characters must be allowed: %v", err)
	}
	if err := Check(strings.Repeat("a", MaxChars+1)); !errors.Is(err, ErrTooLong) {
		t.Fatalf("too long accepted: %v", err)
	}
	if Check("a\x00b") == nil || Check(string([]byte{0xff})) == nil {
		t.Fatal("NUL / invalid UTF-8 accepted")
	}
}

func TestToolCommands(t *testing.T) {
	if n, a, _ := ReadCommand("linux", true, look("wl-paste", "xclip")); n != "/usr/bin/wl-paste" || a[0] != "--no-newline" {
		t.Fatalf("wayland read: %s %v", n, a)
	}
	if n, _, _ := ReadCommand("linux", false, look("wl-paste", "xclip")); n != "/usr/bin/xclip" {
		t.Fatalf("x11 read: %s", n)
	}
	if n, _, _ := WriteCommand("linux", false, look("xsel")); n != "/usr/bin/xsel" {
		t.Fatalf("xsel write: %s", n)
	}
	if _, _, err := WriteCommand("linux", true, look()); err == nil {
		t.Fatal("no tool must be an error")
	}
	if n, _, _ := ReadCommand("darwin", false, look()); n != "/usr/bin/pbpaste" {
		t.Fatalf("mac read %s", n)
	}
	if n, _, _ := WriteCommand("darwin", false, look()); n != "/usr/bin/pbcopy" {
		t.Fatalf("mac write %s", n)
	}
}

// Real clipboard of this desktop (Windows): writes a marker, reads it back, then restores what was
// there. Opt in with NIGAFIY_UI_TEST=1 (it touches the user's clipboard for a moment).
func TestRealClipboardRoundTrip(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("NIGAFIY_UI_TEST") != "1" {
		t.Skip("set NIGAFIY_UI_TEST=1 on Windows to use the real clipboard")
	}
	before, beforeErr := ReadText()
	defer func() {
		if beforeErr == nil {
			_ = WriteText(before)
		}
	}()
	marker := "Nigafiy clipboard test — اختبار الحافظة 123"
	if err := WriteText(marker); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText()
	if err != nil || got != marker {
		t.Fatalf("read back %q %v", got, err)
	}
}
