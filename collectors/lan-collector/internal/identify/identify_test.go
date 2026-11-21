package identify

import (
	"context"
	"encoding/binary"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func newCollector() *collector {
	return &collector{prefix: netip.MustParsePrefix("192.168.1.0/24"), byIP: map[string]*Info{}}
}

func name(s string) dnsmessage.Name { return dnsmessage.MustNewName(s) }

func mdnsResponse(t *testing.T, build func(b *dnsmessage.Builder)) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{Response: true, Authoritative: true})
	b.EnableCompression()
	if err := b.StartAnswers(); err != nil {
		t.Fatal(err)
	}
	build(&b)
	msg, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return msg
}

func TestParseMDNS(t *testing.T) {
	c := newCollector()
	hdr := func(n string, typ dnsmessage.Type) dnsmessage.ResourceHeader {
		return dnsmessage.ResourceHeader{Name: name(n), Type: typ, Class: dnsmessage.ClassINET, TTL: 120}
	}
	msg := mdnsResponse(t, func(b *dnsmessage.Builder) {
		_ = b.PTRResource(hdr(serviceEnumeration, dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: name("_ipp._tcp.local.")})
		_ = b.PTRResource(hdr("_ipp._tcp.local.", dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: name("Office\\032Printer._ipp._tcp.local.")})
		_ = b.PTRResource(hdr("7.1.168.192.in-addr.arpa.", dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: name("printer-7.local.")})
		_ = b.SRVResource(hdr("Office\\032Printer._ipp._tcp.local.", dnsmessage.TypeSRV), dnsmessage.SRVResource{Port: 631, Target: name("printer-7.local.")})
		_ = b.TXTResource(hdr("Office\\032Printer._ipp._tcp.local.", dnsmessage.TypeTXT), dnsmessage.TXTResource{TXT: []string{"ty=HP LaserJet M404", "usb_MFG=HP", "rp=ipp/print", "password=secret"}})
		_ = b.AResource(hdr("printer-7.local.", dnsmessage.TypeA), dnsmessage.AResource{A: [4]byte{192, 168, 1, 7}})
	})
	types := parseMDNS(c, "192.168.1.7", msg)
	if len(types) != 1 || types[0] != "_ipp._tcp.local." {
		t.Fatalf("service types = %v", types)
	}
	info := c.byIP["192.168.1.7"]
	if info == nil || len(info.Services) != 1 || info.Services[0] != "_ipp._tcp" {
		t.Fatalf("services wrong: %+v", info)
	}
	if info.Hints["product"] != "HP LaserJet M404" || info.Hints["manufacturer"] != "HP" {
		t.Errorf("hints wrong: %v", info.Hints)
	}
	if _, leaked := info.Hints["password"]; leaked || len(info.Hints) != 2 {
		t.Errorf("only whitelisted TXT keys may be kept: %v", info.Hints)
	}
	names := map[string]bool{}
	for _, n := range info.Names {
		names[n.Name] = true
	}
	if !names["printer-7"] {
		t.Errorf("hostname missing: %+v", info.Names)
	}

	// An answer from outside the authorized scope is ignored entirely.
	parseMDNS(c, "10.9.9.9", msg)
	if _, ok := c.byIP["10.9.9.9"]; ok {
		t.Error("out-of-scope responder must be ignored")
	}
	// Garbage must not panic.
	parseMDNS(c, "192.168.1.8", []byte{1, 2, 3})
	parseMDNS(c, "192.168.1.8", nil)
}

func TestBuildQueriesAndReverseName(t *testing.T) {
	if got := reverseName("192.168.1.138"); got != "138.1.168.192.in-addr.arpa." {
		t.Errorf("reverseName = %q", got)
	}
	names := []string{serviceEnumeration}
	for i := 0; i < 40; i++ {
		names = append(names, reverseName("192.168.1."+string(rune('0'+i%10))))
	}
	msgs := buildQueries(names)
	if len(msgs) != 3 {
		t.Fatalf("41 questions should be split into 3 packets, got %d", len(msgs))
	}
	var p dnsmessage.Parser
	if _, err := p.Start(msgs[0]); err != nil {
		t.Fatal(err)
	}
	q, err := p.Question()
	if err != nil || q.Type != dnsmessage.TypePTR || q.Class != classUnicastINET {
		t.Errorf("question wrong: %+v %v", q, err)
	}
}

func TestParseSSDPAndDescription(t *testing.T) {
	reply, ok := parseSSDP([]byte("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nSERVER: Linux/4.4 UPnP/1.0 SmartTV/1.0\r\nLOCATION: http://192.168.1.50:9197/dmr\r\n\r\n"))
	if !ok || reply.Server != "Linux/4.4 UPnP/1.0 SmartTV/1.0" || reply.Location != "http://192.168.1.50:9197/dmr" {
		t.Fatalf("reply = %+v ok=%v", reply, ok)
	}
	if got := deviceTypeOf(reply.ST); got != "MediaRenderer" {
		t.Errorf("deviceTypeOf = %q", got)
	}
	if _, ok := parseSSDP([]byte("NOTIFY * HTTP/1.1\r\n\r\n")); ok {
		t.Error("a NOTIFY is not a search response")
	}
	xml := `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Living Room TV</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>UE55</modelName></device></root>`
	d, ok := parseDescription([]byte(xml))
	if !ok || d.Device.FriendlyName != "Living Room TV" || d.Device.Manufacturer != "Samsung Electronics" || d.Device.ModelName != "UE55" {
		t.Errorf("description = %+v", d)
	}
	if _, ok := parseDescription([]byte("<html>not upnp</html>")); ok {
		t.Error("non-UPnP XML must be rejected")
	}
}

func TestNetBIOS(t *testing.T) {
	q := nbstatQuery(7)
	if len(q) != 50 || binary.BigEndian.Uint16(q) != 7 || q[len(q)-3] != 0x21 {
		t.Fatalf("query malformed: % x", q)
	}
	entry := func(n string, suffix byte, flags uint16) []byte {
		e := []byte(n + strings.Repeat(" ", 15-len(n)))
		e = append(e, suffix)
		return binary.BigEndian.AppendUint16(e, flags)
	}
	resp := make([]byte, 12+34+10)
	binary.BigEndian.PutUint16(resp[2:4], 0x8400)
	binary.BigEndian.PutUint16(resp[6:8], 1)
	resp[12] = 0x20
	copy(resp[13:45], "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	binary.BigEndian.PutUint16(resp[46:48], 0x0021) // NBSTAT
	binary.BigEndian.PutUint16(resp[48:50], 0x0001) // IN
	binary.BigEndian.PutUint16(resp[54:56], 1+3*18)
	resp = append(resp, 3)
	resp = append(resp, entry("WORKGROUP", 0x00, 0x8400)...) // group name → not the machine
	resp = append(resp, entry("OFFICE-PC", 0x00, 0x0400)...)
	resp = append(resp, entry("OFFICE-PC", 0x20, 0x0400)...)
	if got := parseNBStat(resp); got != "OFFICE-PC" {
		t.Errorf("parseNBStat = %q", got)
	}
	if parseNBStat([]byte{1, 2, 3}) != "" || parseNBStat(resp[:60]) != "" {
		t.Error("truncated responses must yield no name")
	}

	// Compression-pointer Answer RR name (0xc00c) with and without echoed Question section.
	ptrOnly := make([]byte, 12+2+10)
	binary.BigEndian.PutUint16(ptrOnly[2:4], 0x8400)
	binary.BigEndian.PutUint16(ptrOnly[6:8], 1)
	ptrOnly[12], ptrOnly[13] = 0xc0, 0x0c
	binary.BigEndian.PutUint16(ptrOnly[14:16], 0x0021)
	binary.BigEndian.PutUint16(ptrOnly[16:18], 0x0001)
	ptrOnly = append(ptrOnly, 2)
	ptrOnly = append(ptrOnly, entry("WORKGROUP", 0x00, 0x8400)...)
	ptrOnly = append(ptrOnly, entry("NAS-BOX", 0x00, 0x0400)...)
	if got := parseNBStat(ptrOnly); got != "NAS-BOX" {
		t.Errorf("parseNBStat compression pointer = %q, want NAS-BOX", got)
	}

	// Echoed Question (QDCOUNT=1) followed by Answer RR using 0xc00c pointer.
	withQuestion := make([]byte, 12)
	binary.BigEndian.PutUint16(withQuestion[2:4], 0x8400)
	binary.BigEndian.PutUint16(withQuestion[4:6], 1) // QDCOUNT=1
	binary.BigEndian.PutUint16(withQuestion[6:8], 1) // ANCOUNT=1
	withQuestion = append(withQuestion, 0x20)
	withQuestion = append(withQuestion, "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"...)
	withQuestion = append(withQuestion, 0x00, 0x00, 0x21, 0x00, 0x01) // QTYPE=NBSTAT, QCLASS=IN
	withQuestion = append(withQuestion, 0xc0, 0x0c)                   // Answer NAME pointer to offset 12
	withQuestion = append(withQuestion, 0x00, 0x21, 0x00, 0x01, 0, 0, 0, 0, 0, 19)
	withQuestion = append(withQuestion, 1)
	withQuestion = append(withQuestion, entry("LAPTOP-9", 0x00, 0x0400)...)
	if got := parseNBStat(withQuestion); got != "LAPTOP-9" {
		t.Errorf("parseNBStat with echoed question = %q, want LAPTOP-9", got)
	}

	// Label chain ending in compression pointer and malformed names.
	chained := make([]byte, 12)
	chained = append(chained, 0x04, 'h', 'o', 's', 't', 0xc0, 0x0c)
	chained = append(chained, 0x00, 0x21, 0x00, 0x01, 0, 0, 0, 0, 0, 19, 1)
	chained = append(chained, entry("PRINTER-1", 0x00, 0x0400)...)
	if got := parseNBStat(chained); got != "PRINTER-1" {
		t.Errorf("parseNBStat label+pointer = %q, want PRINTER-1", got)
	}
	if parseNBStat(append(make([]byte, 12), 0xc0)) != "" || parseNBStat(append(make([]byte, 12), 0x40, 0x00)) != "" {
		t.Error("malformed DNS RR names must yield no name")
	}

	// Cancelling ctx must unblock probeNetBIOS immediately without waiting for the 1.5s read deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		probeNetBIOS(ctx, newCollector(), []string{"127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("probeNetBIOS did not stop promptly on context cancellation")
	}
}

func TestCleanAndLimits(t *testing.T) {
	if got := Clean("  Ali's\x00 iPhone\r\n"); got != "Ali's iPhone" {
		t.Errorf("Clean = %q", got)
	}
	if got := Clean(strings.Repeat("ع", 200)); len(got) > maxText || got == "" {
		t.Errorf("Clean must bound length without breaking UTF-8, got %d bytes", len(got))
	}
	c := newCollector()
	for i := 0; i < 50; i++ {
		c.addName("192.168.1.5", "mdns", "name-"+string(rune('a'+i%26))+string(rune('a'+i/26)))
		c.addService("192.168.1.5", "_svc"+string(rune('a'+i%26))+string(rune('a'+i/26))+"._tcp.local.")
	}
	info := c.byIP["192.168.1.5"]
	if len(info.Names) != maxNames || len(info.Services) != maxServices {
		t.Errorf("limits not enforced: %d names, %d services", len(info.Names), len(info.Services))
	}
	c.addName("192.168.1.5", "mdns", "NAME-AA") // duplicate, case-insensitive
	if len(info.Names) != maxNames {
		t.Error("duplicate names must be ignored")
	}
}
