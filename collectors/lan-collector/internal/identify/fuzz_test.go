package identify

import (
	"encoding/binary"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/dns/dnsmessage"
)

// Every parser here reads packets that any device on the LAN can send (mDNS, SSDP, NetBIOS) or a
// UPnP description it serves. The fuzz targets check: no panic, and what is kept is bounded and
// safe to store and show (Clean's contract).

func cleanOK(s string) bool {
	if !utf8.ValidString(s) || len(s) > maxText || s != strings.TrimSpace(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func checkInfo(t *testing.T, c *collector) {
	t.Helper()
	for ip, info := range c.byIP {
		if ip != "192.168.1.7" {
			t.Fatalf("stored an out-of-scope or foreign responder %q", ip)
		}
		if len(info.Names) > maxNames || len(info.Services) > maxServices || len(info.Hints) > maxHints {
			t.Fatalf("limits exceeded: %d names, %d services, %d hints", len(info.Names), len(info.Services), len(info.Hints))
		}
		for _, n := range info.Names {
			if n.Name == "" || !cleanOK(n.Name) {
				t.Fatalf("unsafe name %q", n.Name)
			}
		}
		for _, s := range info.Services {
			if !strings.HasPrefix(s, "_") || !cleanOK(s) {
				t.Fatalf("unsafe service %q", s)
			}
		}
		for k, v := range info.Hints {
			if k == "" || v == "" || !cleanOK(k) || !cleanOK(v) {
				t.Fatalf("unsafe hint %q=%q", k, v)
			}
		}
	}
}

func seedMDNS() []byte {
	hdr := func(n string, typ dnsmessage.Type) dnsmessage.ResourceHeader {
		return dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(n), Type: typ, Class: dnsmessage.ClassINET, TTL: 120}
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{Response: true, Authoritative: true})
	b.EnableCompression()
	_ = b.StartAnswers()
	_ = b.PTRResource(hdr(serviceEnumeration, dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: dnsmessage.MustNewName("_ipp._tcp.local.")})
	_ = b.PTRResource(hdr("_ipp._tcp.local.", dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: dnsmessage.MustNewName("Office\\032Printer._ipp._tcp.local.")})
	_ = b.PTRResource(hdr("7.1.168.192.in-addr.arpa.", dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: dnsmessage.MustNewName("printer-7.local.")})
	_ = b.SRVResource(hdr("Office\\032Printer._ipp._tcp.local.", dnsmessage.TypeSRV), dnsmessage.SRVResource{Port: 631, Target: dnsmessage.MustNewName("printer-7.local.")})
	_ = b.TXTResource(hdr("Office\\032Printer._ipp._tcp.local.", dnsmessage.TypeTXT), dnsmessage.TXTResource{TXT: []string{"ty=HP LaserJet M404", "usb_MFG=HP", "fn=\x01\x7f", "md="}})
	_ = b.AResource(hdr("printer-7.local.", dnsmessage.TypeA), dnsmessage.AResource{A: [4]byte{192, 168, 1, 7}})
	msg, _ := b.Finish()
	return msg
}

func FuzzParseMDNS(f *testing.F) {
	f.Add(seedMDNS())
	f.Add([]byte{})
	f.Add([]byte{1, 2, 3})
	f.Add(make([]byte, 12))
	f.Fuzz(func(t *testing.T, msg []byte) {
		c := newCollector()
		parseMDNS(c, "192.168.1.7", msg)
		parseMDNS(c, "10.9.9.9", msg) // out of scope: must be ignored
		checkInfo(t, c)
	})
}

func FuzzParseSSDP(f *testing.F) {
	f.Add([]byte("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nSERVER: Linux/4.4 UPnP/1.0 SmartTV/1.0\r\nLOCATION: http://192.168.1.50:9197/dmr\r\n\r\n"))
	f.Add([]byte("NOTIFY * HTTP/1.1\r\n\r\n"))
	f.Add([]byte("HTTP/1.1 200 OK\r\nST: device:\r\n"))
	f.Fuzz(func(t *testing.T, msg []byte) {
		r, ok := parseSSDP(msg)
		if !ok && r != (ssdpReply{}) {
			t.Fatalf("rejected reply carries data: %+v", r)
		}
		if dt := deviceTypeOf(r.ST); dt != "" && !strings.Contains(r.ST, "device:"+dt) {
			t.Fatalf("deviceTypeOf(%q) = %q is not from the ST", r.ST, dt)
		}
	})
}

func FuzzParseDescription(f *testing.F) {
	f.Add([]byte(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Living Room TV</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>UE55</modelName></device></root>`))
	f.Add([]byte("<html>not upnp</html>"))
	f.Add([]byte("<root><device><friendlyName>&#0;</friendlyName></device></root>"))
	f.Fuzz(func(t *testing.T, body []byte) {
		d, ok := parseDescription(body)
		if ok && d.Device.FriendlyName == "" && d.Device.ModelName == "" && d.Device.Manufacturer == "" {
			t.Fatal("accepted an empty description")
		}
	})
}

func FuzzParseNBStat(f *testing.F) {
	entry := func(n string, suffix byte, flags uint16) []byte {
		e := []byte(n + strings.Repeat(" ", 15-len(n)))
		e = append(e, suffix)
		return binary.BigEndian.AppendUint16(e, flags)
	}
	withQuestion := make([]byte, 12)
	binary.BigEndian.PutUint16(withQuestion[2:4], 0x8400)
	binary.BigEndian.PutUint16(withQuestion[4:6], 1)
	binary.BigEndian.PutUint16(withQuestion[6:8], 1)
	withQuestion = append(withQuestion, 0x20)
	withQuestion = append(withQuestion, "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"...)
	withQuestion = append(withQuestion, 0x00, 0x00, 0x21, 0x00, 0x01, 0xc0, 0x0c)
	withQuestion = append(withQuestion, 0x00, 0x21, 0x00, 0x01, 0, 0, 0, 0, 0, 37, 2)
	withQuestion = append(withQuestion, entry("WORKGROUP", 0x00, 0x8400)...)
	withQuestion = append(withQuestion, entry("LAPTOP-9", 0x00, 0x0400)...)
	f.Add(withQuestion)
	f.Add(nbstatQuery(7))
	f.Add(append(make([]byte, 12), 0xc0))
	f.Add([]byte{0, 0, 0, 0, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, msg []byte) {
		if n := parseNBStat(msg); !cleanOK(n) || len(n) > 15 {
			t.Fatalf("unsafe NetBIOS name %q", n)
		}
	})
}

func FuzzClean(f *testing.F) {
	f.Add("  Living Room TV\x00\n")
	f.Add(strings.Repeat("é", 80))
	f.Add("\xff\xfe" + strings.Repeat("x", 200))
	f.Fuzz(func(t *testing.T, s string) {
		if out := Clean(s); !cleanOK(out) {
			t.Fatalf("Clean(%q) = %q is not clean", s, out)
		}
	})
}
