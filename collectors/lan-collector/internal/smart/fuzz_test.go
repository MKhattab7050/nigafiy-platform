package smart

import (
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// Fuzz targets for what answers on the LAN: DHCP offers, SSDP replies, UPnP gateway descriptions
// and SOAP answers, and Wi-Fi beacon IEs. Invariants: no panic, and kept text is bounded and safe.

func seedFile(f *testing.F, name string) []byte {
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		f.Fatal(err)
	}
	if !strings.HasSuffix(name, ".hex") {
		return raw
	}
	var b strings.Builder
	for _, line := range strings.Split(string(raw), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			b.WriteString(line)
		}
	}
	out, err := hex.DecodeString(b.String())
	if err != nil {
		f.Fatal(err)
	}
	return out
}

func safeText(s string, max int) bool {
	return utf8.ValidString(s) && len(s) <= max && s == strings.TrimSpace(s) && strings.IndexFunc(s, unicode.IsControl) < 0
}

func FuzzParseOffer(f *testing.F) {
	f.Add(seedFile(f, "dhcp_offer.hex"))
	f.Add(buildOffer(7, 2, "192.168.1.50", dhcpOpt{3, ip4("192.168.1.1")}, dhcpOpt{15, []byte(" home\x00\x01 ")}))
	f.Add(make([]byte, 240))
	f.Fuzz(func(t *testing.T, msg []byte) {
		var xid uint32
		if len(msg) >= 8 {
			xid = binary.BigEndian.Uint32(msg[4:8])
		}
		o, ok := ParseOffer(msg, xid, netip.MustParseAddr("192.168.1.1"))
		if !ok {
			return
		}
		if o.ServerID == "" || !safeText(o.Domain, 120) {
			t.Fatalf("bad offer: %+v", o)
		}
	})
}

func FuzzParseSSDPLocation(f *testing.F) {
	f.Add(seedFile(f, "ssdp_igd_response.txt"))
	f.Add(seedFile(f, "ssdp_other_response.txt"))
	f.Fuzz(func(t *testing.T, msg []byte) {
		if loc, ok := ParseSSDPLocation(msg); ok && loc == "" {
			t.Fatal("accepted a reply without a location")
		}
	})
}

func FuzzParseIGDDescription(f *testing.F) {
	f.Add(seedFile(f, "igd_description.xml"), "http://192.168.1.1:5000/rootDesc.xml")
	f.Add([]byte("<root><URLBase>%zz</URLBase></root>"), "")
	f.Fuzz(func(t *testing.T, body []byte, location string) {
		d, err := ParseIGDDescription(body, location)
		if !safeText(d.FriendlyName, 120) || !safeText(d.Manufacturer, 120) || !safeText(d.Model, 120) {
			t.Fatalf("unsafe text: %+v", d)
		}
		if err == nil && (d.ServiceType == "" || d.ControlURL == "") {
			t.Fatalf("accepted without a WAN service: %+v", d)
		}
	})
}

func FuzzParseSOAPFields(f *testing.F) {
	f.Add(seedFile(f, "soap_mapping_entry.xml"))
	f.Add(seedFile(f, "soap_fault_713.xml"))
	f.Fuzz(func(t *testing.T, raw []byte) {
		_ = ParseSOAPFields(raw)
	})
}

func FuzzSecurityFromIEs(f *testing.F) {
	f.Add(seedFile(f, "beacon_ies_wpa2_wpa3.hex"), true)
	f.Add(seedFile(f, "beacon_ies_wpa_tkip.hex"), true)
	f.Add([]byte{48, 2, 1, 0}, false)
	f.Fuzz(func(t *testing.T, ies []byte, privacy bool) {
		_, _, _ = SecurityFromIEs(ies, privacy)
	})
}
