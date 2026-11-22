//go:build linux || windows || darwin

package remotedesktop

import (
	"strings"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestPortalResponses(t *testing.T) {
	if portalResponseError(0) != nil {
		t.Fatal("0 is success")
	}
	if err := portalResponseError(1); err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("1 = the user said no: %v", err)
	}
	if portalResponseError(2) == nil {
		t.Fatal("2 = ended")
	}
}

func TestScreenshotPortalURI(t *testing.T) {
	p, err := fileURIPath("file:///home/alice/Pictures/Screenshot%20from%202026.png")
	if err != nil || p != "/home/alice/Pictures/Screenshot from 2026.png" {
		t.Fatalf("%q %v", p, err)
	}
	for _, bad := range []string{"", "https://example.com/x.png", "file://server/share/x.png", "file:"} {
		if _, err := fileURIPath(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPortalStreamsAreParsed(t *testing.T) {
	// What RemoteDesktop.Start returns: a(ua{sv}) with "size" (ii).
	v := dbus.MakeVariant([][]any{
		{uint32(57), map[string]dbus.Variant{"size": dbus.MakeVariant([]any{int32(2560), int32(1440)}), "source_type": dbus.MakeVariant(uint32(1))}},
	})
	s, err := parsePortalStreams(v)
	if err != nil || len(s) != 1 || s[0].Node != 57 || s[0].Width != 2560 || s[0].Height != 1440 {
		t.Fatalf("%+v %v", s, err)
	}
	if _, err := parsePortalStreams(dbus.MakeVariant([][]any{})); err == nil {
		t.Fatal("a session without a stream cannot place the pointer")
	}
}

func TestKeysyms(t *testing.T) {
	for k, want := range map[string]int32{"Enter": 0xff0d, "arrowleft": 0xff51, "F12": 0xffc9, "a": 'a', "A": 'a', " ": 0x20, "é": 0xe9} {
		if got, ok := keyKeysym(k); !ok || got != want {
			t.Errorf("%q = %#x %v, want %#x", k, got, ok, want)
		}
	}
	if _, ok := keyKeysym("NoSuchKey"); ok {
		t.Error("unknown key accepted")
	}
	for r, want := range map[rune]int32{'x': 'x', 'ü': 0xfc, 'ع': 0x01000639, '€': 0x010020ac, '\n': 0xff0d} {
		if got, ok := runeKeysym(r); !ok || got != want {
			t.Errorf("%q = %#x, want %#x", r, got, want)
		}
	}
	if _, ok := runeKeysym(0x07); ok {
		t.Error("control characters are not typed")
	}
	if evdevButton("right") != btnRight || evdevButton("middle") != btnMiddle || evdevButton("") != btnLeft {
		t.Error("evdev buttons")
	}
	if wheelSteps(240) != -2 || wheelSteps(-120) != 1 || wheelSteps(30) != -1 || wheelSteps(0) != 0 {
		t.Error("wheel steps: console positive = up, portal positive = down")
	}
}
