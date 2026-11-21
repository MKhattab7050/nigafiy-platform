package smart

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/dhcp"
)

func clientMsg(mac string, typ byte, prl, host, vendor, server string) dhcp.ClientMessage {
	m := dhcp.ClientMessage{PRL: prl, ServerID: server, Type: typ}
	m.MAC, m.Hostname, m.VendorClass = mac, host, vendor
	return m
}

func TestFingerprintTableKeepsOrderAndDedupes(t *testing.T) {
	tab := NewFingerprintTable()
	t0 := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:01", 3, "1,3,6,15,119,252", "Galaxy-A52", "android-dhcp-14", "192.168.1.2"), t0)
	// The renewal carries no hostname; what was learned stays.
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:01", 3, "1,3,6,15,119,252", "", "", "192.168.1.2"), t0.Add(time.Minute))
	got := tab.Drain(time.Time{})
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	want := Fingerprint{MAC: "aa:bb:cc:00:00:01", PRL: "1,3,6,15,119,252", VendorClass: "android-dhcp-14", Hostname: "Galaxy-A52",
		ServerID: "192.168.1.2", SeenAt: t0.Add(time.Minute)}
	if got[0] != want {
		t.Fatalf("got %+v\nwant %+v", got[0], want)
	}
	if tab.Len() != 0 {
		t.Error("Drain must empty the table")
	}
}

func TestFingerprintTableRules(t *testing.T) {
	tab := NewFingerprintTable()
	t0 := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	// Option 54 in a DISCOVER is not a choice of server.
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:02", 1, "1,121,3", "", "MSFT 5.0", "192.168.1.66"), t0)
	// No option list: no fingerprint.
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:03", 3, "", "x", "", ""), t0)
	// Old entries are left out by since.
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:04", 3, "1,3", "", "", "bad"), t0.Add(-time.Hour))
	got := tab.Drain(t0)
	if len(got) != 1 || got[0].MAC != "aa:bb:cc:00:00:02" || got[0].ServerID != "" || got[0].PRL != "1,121,3" {
		t.Fatalf("got %+v", got)
	}

	// A huge option list is cut on a code boundary within 400 characters.
	codes := make([]string, 255)
	for i := range codes {
		codes[i] = fmt.Sprint(i + 1)
	}
	tab.ObserveAt(clientMsg("aa:bb:cc:00:00:05", 3, strings.Join(codes, ","), "", "", ""), t0)
	got = tab.Drain(time.Time{})
	if p := got[0].PRL; len(p) > 400 || strings.HasSuffix(p, ",") || !strings.HasPrefix(p, "1,2,3,") {
		t.Fatalf("prl %d chars: %q", len(p), p)
	}
}

func TestFingerprintTableIsBounded(t *testing.T) {
	tab := NewFingerprintTable()
	t0 := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	for i := 0; i < MaxFingerprints+10; i++ {
		mac := fmt.Sprintf("02:00:00:00:%02x:%02x", i>>8, i&0xff)
		tab.ObserveAt(clientMsg(mac, 3, "1,3,6", "", "", ""), t0.Add(time.Duration(i)*time.Second))
	}
	if tab.Len() != MaxFingerprints {
		t.Fatalf("len %d", tab.Len())
	}
	got := tab.Drain(time.Time{})
	if len(got) != MaxFingerprints || got[0].MAC == "02:00:00:00:00:00" {
		t.Fatalf("the oldest clients must be the ones dropped: first %s", got[0].MAC)
	}
}
