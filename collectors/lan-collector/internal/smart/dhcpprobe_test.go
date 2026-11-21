package smart

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// readHex loads a testdata fixture written as hex lines ('#' lines are comments).
func readHex(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for _, line := range strings.Split(string(raw), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			b.WriteString(line)
		}
	}
	out, err := hex.DecodeString(b.String())
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return out
}

type dhcpOpt struct {
	code byte
	val  []byte
}

func ip4(s string) []byte { return netip.MustParseAddr(s).AsSlice() }

// buildOffer crafts a BOOTREPLY answering xid with the given options (53 is added first).
func buildOffer(xid uint32, msgType byte, yiaddr string, opts ...dhcpOpt) []byte {
	msg := make([]byte, 236)
	msg[0], msg[1], msg[2] = 2, 1, 6
	binary.BigEndian.PutUint32(msg[4:8], xid)
	if yiaddr != "" {
		copy(msg[16:20], ip4(yiaddr))
	}
	msg = append(msg, dhcpCookie...)
	msg = append(msg, 53, 1, msgType)
	for _, o := range opts {
		msg = append(append(msg, o.code, byte(len(o.val))), o.val...)
	}
	return append(msg, 255)
}

func u32(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }

func TestParseOfferReadsServerAndOptions(t *testing.T) {
	msg := buildOffer(0xdeadbeef, 2, "192.168.1.57",
		dhcpOpt{54, ip4("192.168.1.2")},
		dhcpOpt{3, ip4("192.168.1.2")},
		dhcpOpt{6, append(ip4("192.168.1.2"), ip4("1.1.1.1")...)},
		dhcpOpt{51, u32(86400)},
		dhcpOpt{1, ip4("255.255.255.0")},
		dhcpOpt{15, []byte("home.lan\x00")},
	)
	o, ok := ParseOffer(msg, 0xdeadbeef, netip.MustParseAddr("192.168.1.2"))
	if !ok {
		t.Fatal("a valid DHCPOFFER was rejected")
	}
	lease := uint32(86400)
	want := DHCPOffer{ServerID: "192.168.1.2", SourceIP: "192.168.1.2", OfferedIP: "192.168.1.57", SubnetMask: "255.255.255.0",
		Routers: []string{"192.168.1.2"}, DNS: []string{"192.168.1.2", "1.1.1.1"}, LeaseSeconds: &lease, Domain: "home.lan"}
	if !reflect.DeepEqual(o, want) {
		t.Fatalf("got %+v\nwant %+v", o, want)
	}
}

func TestParseOfferFixture(t *testing.T) {
	msg := readHex(t, "dhcp_offer.hex")
	o, ok := ParseOffer(msg, 0x3903f326, netip.MustParseAddr("192.168.1.2"))
	if !ok || o.ServerID != "192.168.1.2" || o.OfferedIP != "192.168.1.57" || *o.LeaseSeconds != 86400 ||
		!reflect.DeepEqual(o.DNS, []string{"192.168.1.2", "1.1.1.1"}) || o.Domain != "home.lan" {
		t.Fatalf("fixture parsed wrong: %+v ok=%v", o, ok)
	}
}

func TestParseOfferRejectsWrongXID(t *testing.T) {
	msg := buildOffer(1, 2, "192.168.1.57", dhcpOpt{54, ip4("192.168.1.2")})
	if _, ok := ParseOffer(msg, 2, netip.MustParseAddr("192.168.1.2")); ok {
		t.Fatal("an offer for another transaction was accepted")
	}
	// Not an offer (DHCPACK), not a reply, bad cookie, truncated.
	if _, ok := ParseOffer(buildOffer(1, 5, ""), 1, netip.MustParseAddr("192.168.1.2")); ok {
		t.Error("a DHCPACK was taken for an offer")
	}
	req := buildOffer(1, 2, "")
	req[0] = 1
	if _, ok := ParseOffer(req, 1, netip.MustParseAddr("192.168.1.2")); ok {
		t.Error("a BOOTREQUEST was taken for an offer")
	}
	bad := buildOffer(1, 2, "")
	bad[236] = 0
	if _, ok := ParseOffer(bad, 1, netip.MustParseAddr("192.168.1.2")); ok {
		t.Error("a message without the DHCP cookie was accepted")
	}
	if _, ok := ParseOffer(buildOffer(1, 2, "")[:200], 1, netip.MustParseAddr("192.168.1.2")); ok {
		t.Error("a truncated message was accepted")
	}
}

func TestParseOfferWithoutServerIDUsesSource(t *testing.T) {
	o, ok := ParseOffer(buildOffer(7, 2, "10.0.0.9", dhcpOpt{6, []byte{1, 2, 3}}), 7, netip.MustParseAddr("10.0.0.1"))
	if !ok || o.ServerID != "10.0.0.1" || len(o.DNS) != 0 || o.LeaseSeconds != nil {
		t.Fatalf("got %+v ok=%v", o, ok)
	}
	// A truncated option ends parsing without inventing values.
	msg := buildOffer(7, 2, "")
	msg = append(msg[:len(msg)-1], 54, 4, 10, 0)
	if o, ok := ParseOffer(msg, 7, netip.MustParseAddr("10.0.0.1")); !ok || o.ServerID != "10.0.0.1" {
		t.Fatalf("truncated option 54: %+v ok=%v", o, ok)
	}
}

func TestBuildDiscover(t *testing.T) {
	mac := net.HardwareAddr{0x02, 0x25, 0x96, 0x0a, 0x1b, 0x2c}
	msg := BuildDiscover(mac, 0x01020304)
	if len(msg) < 300 || msg[0] != 1 || msg[1] != 1 || msg[2] != 6 {
		t.Fatalf("bad header: len %d % x", len(msg), msg[:4])
	}
	if binary.BigEndian.Uint32(msg[4:8]) != 0x01020304 || binary.BigEndian.Uint16(msg[10:12]) != 0x8000 {
		t.Error("transaction id or broadcast flag wrong")
	}
	if !reflect.DeepEqual(net.HardwareAddr(msg[28:34]), mac) || string(msg[236:240]) != string(dhcpCookie) {
		t.Error("chaddr or cookie wrong")
	}
	opts := msg[240:]
	if !strings.HasPrefix(string(opts), string([]byte{53, 1, 1, 55, 6, 1, 3, 6, 15, 51, 54, 57, 2, 0x05, 0xdc, 255})) {
		t.Errorf("options: % x", opts[:16])
	}
	// The end option follows: no requested address, hostname or client id, so no lease is asked for.
	for _, b := range opts[16:] {
		if b != 0 {
			t.Fatalf("data after the end option: % x", opts[16:])
		}
	}
}

// fakeConn answers a DHCPDISCOVER with the offers it is given, then times out.
type fakeConn struct {
	mu      sync.Mutex
	sent    [][]byte
	replies func(xid uint32) [][]byte
	queue   [][]byte
	from    net.Addr
	closed  bool
}

func (c *fakeConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, append([]byte(nil), b...))
	c.queue = c.replies(binary.BigEndian.Uint32(b[4:8]))
	return len(b), nil
}

func (c *fakeConn) ReadFrom(b []byte) (int, net.Addr, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queue) == 0 || c.closed {
		return 0, nil, errors.New("i/o timeout")
	}
	n := copy(b, c.queue[0])
	c.queue = c.queue[1:]
	return n, c.from, nil
}

func (c *fakeConn) SetReadDeadline(time.Time) error { return nil }
func (c *fakeConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}

func TestDHCPProbeCollectsOffersPerInterface(t *testing.T) {
	ok := DHCPInterface{Name: "eth0", Address: netip.MustParseAddr("192.168.1.10"), MAC: net.HardwareAddr{2, 0, 0, 0, 0, 1}}
	busy := DHCPInterface{Name: "eth1", Address: netip.MustParseAddr("192.168.2.10"), MAC: net.HardwareAddr{2, 0, 0, 0, 0, 2}}
	conns := map[string]*fakeConn{}
	open := func(_ context.Context, iface DHCPInterface) (PacketConn, error) {
		if iface.Name == "eth1" {
			return nil, errors.New("cannot listen on UDP 68: address in use")
		}
		c := &fakeConn{from: &net.UDPAddr{IP: net.IPv4(192, 168, 1, 2), Port: 67}, replies: func(xid uint32) [][]byte {
			return [][]byte{
				buildOffer(xid, 2, "192.168.1.57", dhcpOpt{54, ip4("192.168.1.2")}),
				buildOffer(xid, 2, "192.168.1.58", dhcpOpt{54, ip4("192.168.1.2")}),    // same server twice
				buildOffer(xid+1, 2, "192.168.1.59", dhcpOpt{54, ip4("192.168.1.66")}), // another transaction
				buildOffer(xid, 2, "192.168.1.60", dhcpOpt{54, ip4("192.168.1.66")}),   // a second server
			}
		}}
		conns[iface.Name] = c
		return c, nil
	}
	res := DHCPProbe(context.Background(), []DHCPInterface{ok, busy}, 50*time.Millisecond, open)
	if len(res) != 2 {
		t.Fatalf("results: %+v", res)
	}
	if res[0].Name != "eth0" || res[0].MAC != "02:00:00:00:00:01" || res[0].ListenError != "" || len(res[0].Offers) != 2 ||
		res[0].Offers[0].ServerID != "192.168.1.2" || res[0].Offers[1].ServerID != "192.168.1.66" {
		t.Fatalf("eth0: %+v", res[0])
	}
	if res[1].ListenError == "" || len(res[1].Offers) != 0 || res[1].Offers == nil {
		t.Fatalf("eth1 should report the listen error with an empty list: %+v", res[1])
	}
	if c := conns["eth0"]; len(c.sent) != 1 || !c.closed {
		t.Fatalf("exactly one DHCPDISCOVER is sent and the socket closed: sent %d closed %v", len(c.sent), c.closed)
	}
}

func TestCleanTextKeepsLongFieldsAndStripsControls(t *testing.T) {
	long := strings.Repeat("é", 200) // 400 bytes
	if got := cleanText(long, 300); len(got) != 300 || !strings.HasPrefix(long, got) {
		t.Fatalf("cut to %d bytes", len(got))
	}
	if got := cleanText("a\x00b\x1bc\x7fd\u0085e\xffz ", 120); got != "abcdez" {
		t.Fatalf("got %q", got)
	}
}
