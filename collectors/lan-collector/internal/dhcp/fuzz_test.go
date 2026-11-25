package dhcp

import (
	"net"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// FuzzParseClient: DHCP client broadcasts can be forged by any device on the segment. Invariants:
// no panic; an accepted message has a MAC, a client message type, and stored text is clean.
func FuzzParseClient(f *testing.F) {
	f.Add(buildRequest(phone, 3, "Galaxy-A52", "android-dhcp-14", net.IPv4(192, 168, 1, 64)))
	f.Add(buildRequest(phone, 1, "", "MSFT 5.0", nil))
	f.Add(buildRequest(phone, 8, "OFFICE-PC\x00\x00", "", nil))
	f.Add(make([]byte, 240))
	f.Fuzz(func(t *testing.T, msg []byte) {
		m, ok := ParseClient(msg)
		if !ok {
			if m != (ClientMessage{}) {
				t.Fatalf("rejected message carries data: %+v", m)
			}
			return
		}
		if m.MAC == "" || (m.Type != 1 && m.Type != 3 && m.Type != 8) {
			t.Fatalf("accepted without MAC or client type: %+v", m)
		}
		for _, s := range []string{m.Hostname, m.VendorClass} {
			if !utf8.ValidString(s) || len(s) > 100 || strings.IndexFunc(s, unicode.IsControl) >= 0 {
				t.Fatalf("unsafe text %q", s)
			}
		}
		if r, ok := Parse(msg); ok != (m.Hostname != "" || m.VendorClass != "") || (ok && r != m.Request) {
			t.Fatalf("Parse disagrees with ParseClient: %+v %v", r, ok)
		}
	})
}
