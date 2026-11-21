package dhcp

import (
	"net"
	"testing"
)

// withOptions inserts raw options before the end option of a crafted client message.
func withOptions(msg []byte, opts ...byte) []byte {
	out := append([]byte{}, msg[:len(msg)-1]...)
	return append(append(out, opts...), 255)
}

func TestParseClientFingerprint(t *testing.T) {
	msg := withOptions(buildRequest(phone, 3, "OFFICE-PC", "MSFT 5.0", nil), 55, 4, 1, 3, 6, 252, 54, 4, 192, 168, 1, 1)
	m, ok := ParseClient(msg)
	if !ok || m.PRL != "1,3,6,252" || m.ServerID != "192.168.1.1" || m.Type != 3 || m.Hostname != "OFFICE-PC" {
		t.Fatalf("parsed wrong: %+v ok=%v", m, ok)
	}
	// A message that names nothing is still a fingerprint, but not a name to learn.
	bare := withOptions(buildRequest(phone, 1, "", "", nil), 55, 3, 1, 121, 3)
	if m, ok := ParseClient(bare); !ok || m.PRL != "1,121,3" || m.Type != 1 {
		t.Errorf("bare DISCOVER: %+v ok=%v", m, ok)
	}
	if _, ok := Parse(bare); ok {
		t.Error("Parse must still reject a message without a name or vendor class")
	}
	// A malformed server identifier is ignored, not invented.
	odd := withOptions(buildRequest(phone, 3, "x", "", nil), 54, 2, 10, 0)
	if m, _ := ParseClient(odd); m.ServerID != "" {
		t.Errorf("short option 54 accepted: %q", m.ServerID)
	}
	reply := buildRequest(net.HardwareAddr{0, 1, 2, 3, 4, 5}, 3, "x", "", nil)
	reply[0] = 2
	if _, ok := ParseClient(reply); ok {
		t.Error("server replies are not client messages")
	}
}
