// Package dhcp passively learns device names from DHCP.
//
// When a device joins a network it broadcasts a DHCP request that carries the name it calls
// itself ("Galaxy-A52", "Monas-iPhone", "OFFICE-PC") and a vendor class ("android-dhcp-14",
// "MSFT 5.0"). Those broadcasts reach every host on the segment. This package only LISTENS for
// them: it never sends a packet, never answers, and is not a DHCP server. It is the one reliable
// way to name phones that use randomized MAC addresses and stay silent to other discovery.
//
// Requirements: permission to bind UDP port 67 (Linux: CAP_NET_BIND_SERVICE; Windows: no DHCP
// server on the host and an inbound firewall rule for UDP 67). If the port cannot be bound the
// feature is simply off; everything else keeps working.
package dhcp

import (
	"context"
	"encoding/binary"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/sensor/internal/identify"
	"github.com/nigafiy/sensor/internal/netinfo"
)

const (
	// maxEntries bounds the table (and therefore the state file): every client on a hostile LAN
	// can forge DHCP requests with random MACs, so without a cap memory and disk would grow
	// without limit. When full, the entry seen least recently is dropped.
	maxEntries = 4096
	// entryTTL is how long a learned name stays valid after the client was last heard from.
	// 30 days covers devices that are away for holidays or a month-long leave, while a name
	// that a client has not announced for longer is too stale to show as that device's name.
	entryTTL = 30 * 24 * time.Hour
)

// Lease is what one client said about itself in its most recent DHCP request.
type Lease struct {
	Hostname    string
	VendorClass string
	RequestedIP string
	// FirstSeen is when this MAC was first heard announcing itself (kept across renewals).
	FirstSeen time.Time
	// SeenAt is when it was last heard.
	SeenAt time.Time
}

// Request is one parsed client message.
type Request struct {
	MAC string
	Lease
}

var magicCookie = []byte{99, 130, 83, 99}

// ClientMessage is everything one DHCP client message says about the client: its name and vendor
// class (Request), the option list it asks for (option 55, the OS's "DHCP fingerprint") and, in a
// DHCPREQUEST, the server it chose (option 54).
type ClientMessage struct {
	Request
	// PRL is option 55 as comma-separated decimal codes, in the order the client sent them.
	PRL string
	// ServerID is option 54: the DHCP server the client is requesting its lease from.
	ServerID string
	// Type is the DHCP message type (1 DISCOVER, 3 REQUEST, 8 INFORM).
	Type byte
}

// Parse extracts the client's MAC, hostname and vendor class from a BOOTP/DHCP client message.
// It returns ok=false for server replies, for anything malformed, and for messages that carry
// neither a hostname nor a vendor class.
func Parse(msg []byte) (Request, bool) {
	m, ok := ParseClient(msg)
	if !ok || (m.Hostname == "" && m.VendorClass == "") {
		return Request{}, false
	}
	return m.Request, true
}

// ParseClient parses a DHCP client message (DISCOVER, REQUEST or INFORM) whatever it announces.
func ParseClient(msg []byte) (ClientMessage, bool) {
	const fixed = 236
	if len(msg) < fixed+4 || msg[0] != 1 /* BOOTREQUEST */ || msg[1] != 1 /* Ethernet */ || msg[2] != 6 {
		return ClientMessage{}, false
	}
	if string(msg[fixed:fixed+4]) != string(magicCookie) {
		return ClientMessage{}, false
	}
	mac := netinfo.NormalizeMAC(net.HardwareAddr(msg[28:34]).String())
	if mac == "" {
		return ClientMessage{}, false
	}
	out := ClientMessage{Request: Request{MAC: mac}}
	req := &out.Request
	if ci := net.IP(msg[12:16]); !ci.IsUnspecified() {
		req.RequestedIP = ci.String()
	}
	isDHCP := false
	for opts := msg[fixed+4:]; len(opts) > 0; {
		code := opts[0]
		if code == 255 {
			break
		}
		if code == 0 { // pad
			opts = opts[1:]
			continue
		}
		if len(opts) < 2 || len(opts) < 2+int(opts[1]) {
			break // truncated option: keep what we have
		}
		value := opts[2 : 2+int(opts[1])]
		switch code {
		case 12:
			req.Hostname = identify.Clean(strings.TrimRight(string(value), "\x00"))
		case 60:
			req.VendorClass = identify.Clean(string(value))
		case 50:
			if len(value) == 4 {
				req.RequestedIP = net.IP(value).String()
			}
		case 53:
			// 1 DISCOVER, 3 REQUEST, 8 INFORM are the client messages that describe the client.
			isDHCP = len(value) == 1 && (value[0] == 1 || value[0] == 3 || value[0] == 8)
			if isDHCP {
				out.Type = value[0]
			}
		case 54:
			if len(value) == 4 {
				out.ServerID = net.IP(value).String()
			}
		case 55:
			codes := make([]string, 0, len(value))
			for _, c := range value {
				codes = append(codes, strconv.Itoa(int(c)))
			}
			out.PRL = strings.Join(codes, ",")
		}
		opts = opts[2+int(opts[1]):]
	}
	if !isDHCP {
		return ClientMessage{}, false
	}
	return out, true
}

// Table is a bounded, expiring memory of what clients announced. It can be persisted with
// Save/LoadTable and kept on disk with Persist.
type Table struct {
	mu      sync.Mutex
	entries map[string]Lease
	learned int
	// dirty is true while the table holds changes that are not yet on disk; changed is signalled
	// (non-blocking, capacity 1) whenever it becomes dirty so Persist can wake up.
	dirty   bool
	changed chan struct{}
}

func NewTable() *Table { return &Table{entries: map[string]Lease{}, changed: make(chan struct{}, 1)} }

// Record stores a request and reports whether it taught us something new.
func (t *Table) Record(r Request, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	old, known := t.entries[r.MAC]
	if known && now.Sub(old.SeenAt) > entryTTL {
		// An expired entry is gone: its name must not be resurrected by a later vendor-only message.
		known, old = false, Lease{}
	}
	lease := r.Lease
	lease.SeenAt = now
	lease.FirstSeen = now
	if known && !old.FirstSeen.IsZero() {
		lease.FirstSeen = old.FirstSeen
	}
	// A later message without a hostname must not erase a name learned earlier.
	if lease.Hostname == "" {
		lease.Hostname = old.Hostname
	}
	if lease.VendorClass == "" {
		lease.VendorClass = old.VendorClass
	}
	if _, present := t.entries[r.MAC]; !present && len(t.entries) >= maxEntries {
		t.evictOldest()
	}
	t.entries[r.MAC] = lease
	t.markDirtyLocked()
	changed := !known || old.Hostname != lease.Hostname || old.VendorClass != lease.VendorClass
	if changed {
		t.learned++
	}
	return changed
}

func (t *Table) markDirtyLocked() {
	t.dirty = true
	select {
	case t.changed <- struct{}{}:
	default:
	}
}

func (t *Table) evictOldest() {
	var oldest string
	var at time.Time
	for mac, l := range t.entries {
		if oldest == "" || l.SeenAt.Before(at) {
			oldest, at = mac, l.SeenAt
		}
	}
	delete(t.entries, oldest)
}

// Lookup returns what the client with this MAC announced, if it is still fresh.
func (t *Table) Lookup(mac string) (Lease, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	l, ok := t.entries[mac]
	if !ok || time.Since(l.SeenAt) > entryTTL {
		return Lease{}, false
	}
	return l, true
}

func (t *Table) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

// Listen receives DHCP client broadcasts on addr (":67" in production) until ctx ends.
// onLearn is called when a client announces a new or changed name. The returned error is non-nil
// only when the port could not be opened.
func Listen(ctx context.Context, addr string, table *Table, onLearn func(Request)) error {
	return ListenObserve(ctx, addr, table, onLearn, nil)
}

// ListenObserve is Listen that also hands every client message (with its option list and chosen
// server) to observe, for DHCP fingerprinting and rogue-DHCP evidence. observe may be nil.
func ListenObserve(ctx context.Context, addr string, table *Table, onLearn func(Request), observe func(ClientMessage)) error {
	conn, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := conn.ReadFrom(buf)
			if err != nil {
				return // closed on shutdown
			}
			m, ok := ParseClient(buf[:n])
			if !ok {
				continue
			}
			if observe != nil {
				observe(m)
			}
			if m.Hostname == "" && m.VendorClass == "" {
				continue
			}
			if table.Record(m.Request, time.Now()) && onLearn != nil {
				onLearn(m.Request)
			}
		}
	}()
	return nil
}

// buildRequest is used by tests to craft a client message.
func buildRequest(mac net.HardwareAddr, msgType byte, hostname, vendor string, requested net.IP) []byte {
	msg := make([]byte, 236)
	msg[0], msg[1], msg[2] = 1, 1, 6
	binary.BigEndian.PutUint32(msg[4:8], 0x1234abcd)
	copy(msg[28:34], mac)
	msg = append(msg, magicCookie...)
	msg = append(msg, 53, 1, msgType)
	if hostname != "" {
		msg = append(append(msg, 12, byte(len(hostname))), hostname...)
	}
	if vendor != "" {
		msg = append(append(msg, 60, byte(len(vendor))), vendor...)
	}
	if requested != nil {
		msg = append(append(msg, 50, 4), requested.To4()...)
	}
	return append(msg, 255)
}
