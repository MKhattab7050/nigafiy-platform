package mndp

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// routerOSAnnouncement is a RouterOS 7 MNDP announcement byte for byte: 4-byte header (sequence
// 0x2a), then MAC, identity, version, platform, uptime (93784 s, little-endian), software ID,
// board, unpack, IPv6, interface name and IPv4 TLVs.
const routerOSAnnouncement = "0000002a0001000648a98a0102030005" +
	"000a6841502d6f666669636500070024" +
	"372e31352e332028737461626c652920" +
	"4a756c2f30392f323032342031303a32" +
	"383a3336000800084d696b726f54696b" +
	"000a0004586e0100000b000941424344" +
	"2d31323334000c001352423936325569" +
	"47532d354861635432486e54000e0001" +
	"01000f0010fe800000000000004aa98a" +
	"fffe0102030010000662726964676500" +
	"110004c0a85801"

func fixture(t *testing.T, h string) []byte {
	t.Helper()
	b, err := hex.DecodeString(h)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParse(t *testing.T) {
	up := int64(93784)
	cases := []struct {
		name    string
		hex     string
		want    Announcement
		wantErr bool
	}{
		{
			name: "RouterOS 7 announcement with every field",
			hex:  routerOSAnnouncement,
			want: Announcement{
				MAC: "48:a9:8a:01:02:03", Identity: "hAP-office", Version: "7.15.3 (stable) Jul/09/2024 10:28:36", Platform: "MikroTik",
				Board: "RB962UiGS-5HacT2HnT", InterfaceName: "bridge", IPv4: "192.168.88.1", IPv6: "fe80::4aa9:8aff:fe01:203", UptimeSeconds: &up,
			},
		},
		{
			// RouterOS 6 sends fewer TLVs: MAC, identity, version, platform, uptime, board, interface.
			name: "minimal announcement",
			hex:  "00000001" + "0001000648a98a0a0b0c" + "000500086361702d726f6f66" + "000800084d696b726f54696b",
			want: Announcement{MAC: "48:a9:8a:0a:0b:0c", Identity: "cap-roof", Platform: "MikroTik"},
		},
		{
			name: "unknown TLV types are skipped",
			hex:  "00000001" + "00630002abcd" + "0001000648a98a0a0b0c",
			want: Announcement{MAC: "48:a9:8a:0a:0b:0c"},
		},
		{
			name: "control characters are removed from text",
			hex:  "00000001" + "0001000648a98a0a0b0c" + "000500056162070a63",
			want: Announcement{MAC: "48:a9:8a:0a:0b:0c", Identity: "abc"},
		},
		{name: "discovery request (header only) is not an announcement", hex: "00000000", wantErr: true},
		{name: "no MAC address", hex: "00000001" + "000500086361702d726f6f66", wantErr: true},
		{name: "zero MAC address", hex: "00000001" + "00010006000000000000", wantErr: true},
		{name: "TLV longer than the packet", hex: "00000001" + "0001000648a98a0a0b0c" + "00050040616263", wantErr: true},
		{name: "truncated TLV header", hex: "00000001" + "0001000648a98a0a0b0c" + "0005", wantErr: true},
		{name: "wrong-length MAC is ignored", hex: "00000001" + "0001000448a98a0a", wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Parse(fixture(t, c.hex))
			if c.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (got.UptimeSeconds == nil) != (c.want.UptimeSeconds == nil) || (got.UptimeSeconds != nil && *got.UptimeSeconds != *c.want.UptimeSeconds) {
				t.Errorf("uptime: got %v want %v", got.UptimeSeconds, c.want.UptimeSeconds)
			}
			got.UptimeSeconds, c.want.UptimeSeconds = nil, nil
			if got != c.want {
				t.Errorf("got  %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func scope(cidr string) func(netip.Addr) bool {
	p := netip.MustParsePrefix(cidr)
	return p.Contains
}

func TestTableAcceptsOnlyInScopeSources(t *testing.T) {
	tb := NewTable(scope("192.168.88.0/24"))
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	pkt := fixture(t, routerOSAnnouncement)
	tb.Handle(pkt, netip.MustParseAddr("192.168.88.1"), now)
	tb.Handle(pkt, netip.MustParseAddr("10.9.9.9"), now)                    // outside the authorized scope
	tb.Handle(pkt, netip.MustParseAddr("fe80::1"), now)                     // IPv6 sources are not accepted
	tb.Handle([]byte{0, 0, 0, 0}, netip.MustParseAddr("192.168.88.7"), now) // discovery request
	tb.Handle(pkt, netip.MustParseAddr("192.168.88.1"), now.Add(time.Minute))

	list, st := tb.Snapshot(now.Add(time.Minute))
	if len(list) != 1 {
		t.Fatalf("neighbours: %+v", list)
	}
	n := list[0]
	if n.MAC != "48:a9:8a:01:02:03" || n.SourceIP != "192.168.88.1" || !n.FirstSeen.Equal(now) || !n.LastSeen.Equal(now.Add(time.Minute)) {
		t.Errorf("neighbour: %+v", n)
	}
	if st.Received != 2 || st.OutOfScope != 2 || st.Malformed != 1 || st.Neighbors != 1 {
		t.Errorf("status: %+v", st)
	}

	// Not heard for longer than Expiry: gone.
	list, _ = tb.Snapshot(now.Add(time.Minute + Expiry + time.Second))
	if len(list) != 0 {
		t.Errorf("expired neighbour still listed: %+v", list)
	}
}

func TestTableIsBounded(t *testing.T) {
	tb := NewTable(scope("10.0.0.0/8"))
	now := time.Now()
	for i := 0; i < MaxNeighbors+50; i++ {
		mac := []byte{0x02, 0, 0, byte(i >> 16), byte(i >> 8), byte(i)}
		pkt := append([]byte{0, 0, 0, 1, 0, 1, 0, 6}, mac...)
		tb.Handle(pkt, netip.MustParseAddr("10.0.0.1"), now)
	}
	if list, _ := tb.Snapshot(now); len(list) != MaxNeighbors {
		t.Errorf("want the table capped at %d, got %d", MaxNeighbors, len(list))
	}
}

type fakeConn struct {
	pkts   chan []byte
	closed chan struct{}
}

func (f *fakeConn) ReadFrom(p []byte) (int, net.Addr, error) {
	select {
	case b := <-f.pkts:
		return copy(p, b), &net.UDPAddr{IP: net.ParseIP("192.168.88.1"), Port: Port}, nil
	case <-f.closed:
		return 0, nil, net.ErrClosed
	}
}

func (f *fakeConn) Close() error {
	select {
	case <-f.closed:
	default:
		close(f.closed)
	}
	return nil
}

func TestServeReportsBindFailureAndListens(t *testing.T) {
	tb := NewTable(scope("192.168.88.0/24"))
	inUse := errors.New("listen udp4 :5678: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.")
	err := tb.Serve(context.Background(), ":5678", func(context.Context, string) (PacketConn, error) { return nil, inUse })
	if err == nil {
		t.Fatal("want the bind error back")
	}
	_, st := tb.Snapshot(time.Now())
	if st.State != "bind_failed" || !strings.Contains(st.Error, "already in use") {
		t.Errorf("status after bind failure: %+v", st)
	}

	conn := &fakeConn{pkts: make(chan []byte, 1), closed: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- tb.Serve(ctx, ":5678", func(context.Context, string) (PacketConn, error) { return conn, nil })
	}()
	conn.pkts <- fixture(t, routerOSAnnouncement)
	deadline := time.Now().Add(2 * time.Second)
	for {
		list, st := tb.Snapshot(time.Now())
		if len(list) == 1 && st.State == "listening" && st.Error == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not received: %+v %+v", list, st)
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, st := tb.Snapshot(time.Now()); st.State != "stopped" {
		t.Errorf("state after stop: %+v", st)
	}
}

// The real socket on loopback: bind a free port, receive one datagram. Skipped when the sandbox
// does not allow binding UDP.
func TestServeOnLoopbackUDP(t *testing.T) {
	probe, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind loopback UDP:", err)
	}
	addr := probe.LocalAddr().String()
	_ = probe.Close()
	tb := NewTable(scope("127.0.0.0/8"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = tb.Serve(ctx, addr, nil) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, st := tb.Snapshot(time.Now()); st.State == "listening" {
			break
		}
		if time.Now().After(deadline) {
			t.Skip("listener did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	c, err := net.Dial("udp4", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for time.Now().Before(deadline.Add(2 * time.Second)) {
		_, _ = c.Write(fixture(t, routerOSAnnouncement))
		if list, _ := tb.Snapshot(time.Now()); len(list) == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no announcement received on the loopback socket")
}
