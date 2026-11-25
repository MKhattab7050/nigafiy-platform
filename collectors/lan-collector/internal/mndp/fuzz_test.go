package mndp

import (
	"encoding/hex"
	"strings"
	"testing"
	"unicode/utf8"
)

// FuzzParse: MNDP announcements are UDP broadcasts any device can forge. Invariants: no panic;
// an accepted announcement has a MAC and only bounded, printable, trimmed text.
func FuzzParse(f *testing.F) {
	seed, _ := hex.DecodeString(routerOSAnnouncement)
	f.Add(seed)
	f.Add([]byte{0, 0, 0, 1, 0, 1, 0, 6, 1, 2, 3, 4, 5, 6})
	f.Add([]byte{0, 0, 0, 1, 0, 5, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, pkt []byte) {
		a, err := Parse(pkt)
		if err != nil {
			return
		}
		if a.MAC == "" || a.MAC == "00:00:00:00:00:00" {
			t.Fatalf("accepted without a MAC: %+v", a)
		}
		for _, s := range []string{a.Identity, a.Version, a.Platform, a.Board, a.InterfaceName} {
			if !utf8.ValidString(s) || len(s) > 120 || s != strings.TrimSpace(s) ||
				strings.IndexFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
				t.Fatalf("unsafe text %q", s)
			}
		}
	})
}
