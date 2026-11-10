package dhcp

import (
	"context"
	"net"
	"testing"
	"time"
)

var phone = net.HardwareAddr{0xda, 0xa1, 0x19, 0x00, 0x00, 0x50}

func TestParse(t *testing.T) {
	req, ok := Parse(buildRequest(phone, 3, "Galaxy-A52", "android-dhcp-14", net.IPv4(192, 168, 1, 64)))
	if !ok || req.MAC != "da:a1:19:00:00:50" || req.Hostname != "Galaxy-A52" || req.VendorClass != "android-dhcp-14" || req.RequestedIP != "192.168.1.64" {
		t.Fatalf("parsed wrong: %+v ok=%v", req, ok)
	}
	// DISCOVER with only a vendor class is still useful.
	if req, ok := Parse(buildRequest(phone, 1, "", "MSFT 5.0", nil)); !ok || req.VendorClass != "MSFT 5.0" {
		t.Errorf("vendor-only request rejected: %+v", req)
	}

	rejected := map[string][]byte{
		"empty":             nil,
		"too short":         make([]byte, 100),
		"nothing announced": buildRequest(phone, 3, "", "", nil),
		"release (type 7)":  buildRequest(phone, 7, "Galaxy-A52", "", nil),
		"broadcast MAC":     buildRequest(net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, 3, "x", "", nil),
	}
	reply := buildRequest(phone, 3, "Galaxy-A52", "", nil)
	reply[0] = 2 // BOOTREPLY: sent by a server, says nothing about the client's own name
	rejected["server reply"] = reply
	noCookie := buildRequest(phone, 3, "Galaxy-A52", "", nil)
	noCookie[236] = 0
	rejected["bad magic cookie"] = noCookie
	for name, msg := range rejected {
		if _, ok := Parse(msg); ok {
			t.Errorf("%s: must be rejected", name)
		}
	}

	// A truncated option must not panic and must not invent data.
	trunc := buildRequest(phone, 3, "Galaxy-A52", "", nil)
	trunc = append(trunc[:len(trunc)-1], 60, 200, 'x')
	if req, ok := Parse(trunc); !ok || req.Hostname != "Galaxy-A52" || req.VendorClass != "" {
		t.Errorf("truncated option handled wrong: %+v ok=%v", req, ok)
	}
	// Control characters in a hostname are stripped.
	if req, _ := Parse(buildRequest(phone, 3, "evil\x00\x07name", "", nil)); req.Hostname != "evilname" {
		t.Errorf("hostname not cleaned: %q", req.Hostname)
	}
}

func TestTable(t *testing.T) {
	table := NewTable()
	now := time.Now()
	if !table.Record(Request{MAC: "aa", Lease: Lease{Hostname: "iPhone"}}, now) {
		t.Fatal("first sighting should count as learned")
	}
	if table.Record(Request{MAC: "aa", Lease: Lease{Hostname: "iPhone"}}, now) {
		t.Error("an identical repeat is not news")
	}
	// A renewal that carries only the vendor class keeps the earlier name.
	table.Record(Request{MAC: "aa", Lease: Lease{VendorClass: "x"}}, now)
	if l, ok := table.Lookup("aa"); !ok || l.Hostname != "iPhone" || l.VendorClass != "x" {
		t.Errorf("merge wrong: %+v", l)
	}
	if _, ok := table.Lookup("unknown"); ok {
		t.Error("unknown MAC must not be found")
	}
	// Bounded: the table never grows past its limit and drops the oldest entry first.
	old := NewTable()
	for i := 0; i < maxEntries+10; i++ {
		old.Record(Request{MAC: string(rune(i + 1000)), Lease: Lease{Hostname: "h"}}, now.Add(time.Duration(i)*time.Second))
	}
	if old.Len() != maxEntries {
		t.Errorf("table size = %d, want %d", old.Len(), maxEntries)
	}
	if _, ok := old.Lookup(string(rune(1000))); ok {
		t.Error("oldest entry should have been evicted")
	}
}

func TestListenLearnsFromTheWire(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A free port stands in for 67 so the test needs no privileges.
	probe, _ := net.ListenPacket("udp4", "127.0.0.1:0")
	addr := probe.LocalAddr().String()
	_ = probe.Close()

	table := NewTable()
	learned := make(chan Request, 4)
	if err := Listen(ctx, addr, table, func(r Request) { learned <- r }); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("udp4", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("not dhcp at all"))
	_, _ = conn.Write(buildRequest(phone, 3, "Monas-iPhone", "", net.IPv4(192, 168, 1, 86)))
	select {
	case r := <-learned:
		if r.Hostname != "Monas-iPhone" || r.MAC != "da:a1:19:00:00:50" {
			t.Fatalf("learned wrong: %+v", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("nothing learned from the wire")
	}
	if l, ok := table.Lookup("da:a1:19:00:00:50"); !ok || l.Hostname != "Monas-iPhone" {
		t.Errorf("table not updated: %+v", l)
	}
	// Port already taken → a clear error, not a crash.
	if err := Listen(ctx, addr, NewTable(), nil); err == nil {
		t.Error("binding a port that is in use must fail")
	}
}
