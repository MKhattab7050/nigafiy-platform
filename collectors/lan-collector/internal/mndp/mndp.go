// Package mndp listens for MikroTik Neighbor Discovery Protocol announcements. It is receive-only:
// the collector never sends an MNDP packet (no discovery request, no announcement of its own).
//
// RouterOS devices broadcast an announcement about once a minute on UDP port 5678 from every
// interface where neighbour discovery is enabled. The packet is a 4-byte header (2 bytes of
// header/version, 2 bytes of sequence number) followed by TLVs: 2-byte type, 2-byte length (both
// big-endian), then the value.
//
//	 1 MAC address (6)    5 Identity          7 Version        8 Platform
//	10 Uptime (uint32 seconds, little-endian) 11 Software ID   12 Board
//	14 Unpack (1)        15 IPv6 address (16) 16 Interface name 17 IPv4 address (4)
package mndp

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Port is the MNDP UDP port.
const Port = 5678

const (
	tlvMAC       = 1
	tlvIdentity  = 5
	tlvVersion   = 7
	tlvPlatform  = 8
	tlvUptime    = 10
	tlvSoftware  = 11
	tlvBoard     = 12
	tlvUnpack    = 14
	tlvIPv6      = 15
	tlvInterface = 16
	tlvIPv4      = 17

	maxPacket = 1500
	// MaxNeighbors bounds the table; a flood of forged MACs cannot grow it without limit.
	MaxNeighbors = 1024
	// Expiry drops neighbours not heard for this long (they announce about every 60 s).
	Expiry = 30 * time.Minute
)

// Announcement is one parsed MNDP packet.
type Announcement struct {
	MAC           string
	Identity      string
	Version       string
	Platform      string
	Board         string
	InterfaceName string
	IPv4          string
	IPv6          string
	UptimeSeconds *int64
}

var errShort = errors.New("not an MNDP announcement")

func cleanText(b []byte, max int) string {
	s := strings.TrimRight(string(b), "\x00")
	if !utf8.ValidString(s) {
		return ""
	}
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// Parse decodes an announcement. A packet without a MAC address is rejected: the MAC is what
// identifies the neighbour. Unknown TLV types are skipped.
func Parse(pkt []byte) (Announcement, error) {
	var a Announcement
	if len(pkt) < 4+4 || len(pkt) > maxPacket {
		return a, errShort
	}
	rest := pkt[4:]
	for len(rest) > 0 {
		if len(rest) < 4 {
			return Announcement{}, fmt.Errorf("truncated TLV header")
		}
		typ := binary.BigEndian.Uint16(rest[0:2])
		n := int(binary.BigEndian.Uint16(rest[2:4]))
		if len(rest) < 4+n {
			return Announcement{}, fmt.Errorf("TLV %d claims %d bytes, %d left", typ, n, len(rest)-4)
		}
		v := rest[4 : 4+n]
		rest = rest[4+n:]
		switch typ {
		case tlvMAC:
			if n == 6 {
				a.MAC = net.HardwareAddr(v).String()
			}
		case tlvIdentity:
			a.Identity = cleanText(v, 120)
		case tlvVersion:
			a.Version = cleanText(v, 120)
		case tlvPlatform:
			a.Platform = cleanText(v, 120)
		case tlvBoard:
			a.Board = cleanText(v, 120)
		case tlvInterface:
			a.InterfaceName = cleanText(v, 120)
		case tlvUptime:
			if n == 4 {
				u := int64(binary.LittleEndian.Uint32(v))
				a.UptimeSeconds = &u
			}
		case tlvIPv4:
			if n == 4 {
				a.IPv4 = netip.AddrFrom4([4]byte(v)).String()
			}
		case tlvIPv6:
			if n == 16 {
				a.IPv6 = netip.AddrFrom16([16]byte(v)).String()
			}
		case tlvSoftware, tlvUnpack:
			// Software ID is a licence identifier and is deliberately not kept; unpack is a flag.
		}
	}
	if a.MAC == "" || a.MAC == "00:00:00:00:00:00" {
		return Announcement{}, errShort
	}
	return a, nil
}

// Neighbor is a device heard announcing itself.
type Neighbor struct {
	Announcement
	SourceIP  string
	FirstSeen time.Time
	LastSeen  time.Time
}

// Status is reported in the heartbeat so the UI says whether MNDP is actually being received.
type Status struct {
	// State: listening, disabled (by the site or this collector's config), bind_failed, stopped.
	State      string    `json:"state"`
	Listen     string    `json:"listen,omitempty"`
	Error      string    `json:"error,omitempty"`
	Since      time.Time `json:"since"`
	Received   int64     `json:"received"`
	Malformed  int64     `json:"malformed"`
	OutOfScope int64     `json:"out_of_scope"`
	Neighbors  int       `json:"neighbors"`
}

// Table holds what was heard. Allow decides which source addresses are accepted (the collector
// passes its authorized scopes): announcements from anywhere else are counted and dropped.
type Table struct {
	Allow func(netip.Addr) bool

	mu        sync.Mutex
	neighbors map[string]*Neighbor
	status    Status
}

func NewTable(allow func(netip.Addr) bool) *Table {
	return &Table{Allow: allow, neighbors: map[string]*Neighbor{}, status: Status{State: "stopped", Since: time.Now().UTC()}}
}

// Handle processes one received datagram.
func (t *Table) Handle(pkt []byte, src netip.Addr, now time.Time) {
	src = src.Unmap()
	t.mu.Lock()
	defer t.mu.Unlock()
	if !src.Is4() || t.Allow == nil || !t.Allow(src) {
		t.status.OutOfScope++
		return
	}
	a, err := Parse(pkt)
	if err != nil {
		t.status.Malformed++
		return
	}
	t.status.Received++
	n := t.neighbors[a.MAC]
	if n == nil {
		t.expireLocked(now)
		if len(t.neighbors) >= MaxNeighbors {
			return
		}
		n = &Neighbor{FirstSeen: now}
		t.neighbors[a.MAC] = n
	}
	n.Announcement, n.SourceIP, n.LastSeen = a, src.String(), now
}

func (t *Table) expireLocked(now time.Time) {
	for mac, n := range t.neighbors {
		if now.Sub(n.LastSeen) > Expiry {
			delete(t.neighbors, mac)
		}
	}
}

// Snapshot returns the current neighbours (sorted by MAC) and status.
func (t *Table) Snapshot(now time.Time) ([]Neighbor, Status) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.expireLocked(now)
	out := make([]Neighbor, 0, len(t.neighbors))
	for _, n := range t.neighbors {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MAC < out[j].MAC })
	st := t.status
	st.Neighbors = len(out)
	return out, st
}

// SetState records a state change (listening, disabled, bind_failed, stopped).
func (t *Table) SetState(state, listen, errText string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.status.State != state || t.status.Error != errText {
		t.status.Since = now.UTC()
	}
	t.status.State, t.status.Listen, t.status.Error = state, listen, errText
}

// PacketConn is the part of net.PacketConn the listener uses (injectable for tests).
type PacketConn interface {
	ReadFrom(p []byte) (int, net.Addr, error)
	Close() error
}

// ListenFunc opens the receive socket.
type ListenFunc func(ctx context.Context, addr string) (PacketConn, error)

// ListenUDP opens a plain UDP socket. It never sets broadcast-send options: nothing is sent.
func ListenUDP(ctx context.Context, addr string) (PacketConn, error) {
	var lc net.ListenConfig
	return lc.ListenPacket(ctx, "udp4", addr)
}

// Serve opens the socket and feeds the table until ctx ends. A bind failure (port in use — for
// example WinBox on the same host — or not permitted) is returned immediately and recorded in the
// status; the caller decides when to retry. Nothing is ever sent on the socket.
func (t *Table) Serve(ctx context.Context, addr string, listen ListenFunc) error {
	if listen == nil {
		listen = ListenUDP
	}
	conn, err := listen(ctx, addr)
	if err != nil {
		t.SetState("bind_failed", addr, bindError(err), time.Now())
		return err
	}
	t.SetState("listening", addr, "", time.Now())
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	buf := make([]byte, maxPacket+1)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				t.SetState("stopped", addr, "", time.Now())
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			t.SetState("stopped", addr, "receive failed: "+err.Error(), time.Now())
			return err
		}
		var src netip.Addr
		if ua, ok := from.(*net.UDPAddr); ok {
			src, _ = netip.AddrFromSlice(ua.IP)
		}
		t.Handle(buf[:n], src, time.Now())
	}
}

func bindError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "address already in use"), strings.Contains(msg, "Only one usage of each socket address"):
		return fmt.Sprintf("UDP port %d is already in use on the collector host (another MNDP listener such as WinBox?)", Port)
	case strings.Contains(msg, "permission denied"), strings.Contains(msg, "access permissions"):
		return fmt.Sprintf("not permitted to open UDP port %d on the collector host", Port)
	}
	return "cannot listen: " + msg
}
