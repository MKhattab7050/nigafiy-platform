//go:build windows

package remotedesktop

import (
	"testing"
	"unsafe"
)

func TestMapKeyToVKPunctuation(t *testing.T) {
	want := map[string]byte{
		"-":  0xBD,
		"=":  0xBB,
		"[":  0xDB,
		"]":  0xDD,
		";":  0xBA,
		"'":  0xDE,
		",":  0xBC,
		".":  0xBE,
		"/":  0xBF,
		`\`:  0xDC,
		"`":  0xC0,
		"a":  'A',
		"0":  '0',
		"F5": 0x74,
	}
	for k, expected := range want {
		if got := mapKeyToVK(k); got != expected {
			t.Errorf("mapKeyToVK(%q) = 0x%02X, want 0x%02X", k, got, expected)
		}
	}
}

func TestWinInputLayoutAndUnicodeEvents(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		if got := unsafe.Sizeof(winInput{}); got != 40 {
			t.Fatalf("64-bit winInput size = %d, want 40", got)
		}
		if got := unsafe.Offsetof(winInput{}.ki); got != 8 {
			t.Fatalf("64-bit winInput.ki offset = %d, want 8", got)
		}
	} else {
		if got := unsafe.Sizeof(winInput{}); got != 28 {
			t.Fatalf("32-bit winInput size = %d, want 28", got)
		}
		if got := unsafe.Offsetof(winInput{}.ki); got != 4 {
			t.Fatalf("32-bit winInput.ki offset = %d, want 4", got)
		}
	}

	// BMP character (Arabic letter 'ع', U+0639) produces 2 events (down + up).
	bmp := buildUnicodeInputs('ع')
	if len(bmp) != 2 {
		t.Fatalf("expected 2 inputs for BMP rune, got %d", len(bmp))
	}
	if bmp[0].typ != inputKeyboard || bmp[0].ki.wVk != 0 || bmp[0].ki.wScan != 0x0639 || bmp[0].ki.dwFlags != keyeventfUnicode {
		t.Fatalf("unexpected keydown input: %+v", bmp[0])
	}
	if bmp[1].ki.dwFlags != keyeventfUnicode|keyeventfKeyUp || bmp[1].ki.wScan != 0x0639 {
		t.Fatalf("unexpected keyup input: %+v", bmp[1])
	}

	// Non-BMP surrogate pair (U+1F600) produces 4 events (2 UTF-16 code units).
	surr := buildUnicodeInputs('😀')
	if len(surr) != 4 || surr[0].ki.wScan != 0xD83D || surr[2].ki.wScan != 0xDE00 {
		t.Fatalf("unexpected surrogate inputs: %+v", surr)
	}
}
