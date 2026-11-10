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
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/identify"
	"github.com/lan-detective/lan-collector/internal/netinfo"
)

const (
	maxEntries = 4096
	entryTTL   = 30 * 24 * time.Hour
)

// Lease is what one client said about itself in its most recent DHCP request.
type Lease struct {
	Hostname    string
	VendorClass string
	RequestedIP string
	SeenAt      time.Time
}

// Request is one parsed client message.
type Request struct {
	MAC string
	Lease
}

var magicCookie = []byte{99, 130, 83, 99}

// Parse extracts the client's MAC, hostname and vendor class from a BOOTP/DHCP client message.
// It returns ok=false for server replies and for anything malformed.
func Parse(msg []byte) (Request, bool) {
	const fixed = 236
	if len(msg) < fixed+4 || msg[0] != 1 /* BOOTREQUEST */ || msg[1] != 1 /* Ethernet */ || msg[2] != 6 {
		return Request{}, false
	}
	if string(msg[fixed:fixed+4]) != string(magicCookie) {
		return Request{}, false
	}
	mac := netinfo.NormalizeMAC(net.HardwareAddr(msg[28:34]).String())
	if mac == "" {
		return Request{}, false
	}
	req := Request{MAC: mac}
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
		}
		opts = opts[2+int(opts[1]):]
	}
	if !isDHCP || (req.Hostname == "" && req.VendorClass == "") {
		return Request{}, false
	}
	return req, true
}

// Table is a bounded, expiring memory of what clients announced.
type Table struct {
	mu      sync.Mutex
	entries map[string]Lease
	learned int
}

func NewTable() *Table { return &Table{entries: map[string]Lease{}} }

// Record stores a request and reports whether it taught us something new.
func (t *Table) Record(r Request, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	old, known := t.entries[r.MAC]
	lease := r.Lease
	lease.SeenAt = now
	// A later message without a hostname must not erase a name learned earlier.
	if lease.Hostname == "" {
		lease.Hostname = old.Hostname
	}
	if lease.VendorClass == "" {
		lease.VendorClass = old.VendorClass
	}
	if !known && len(t.entries) >= maxEntries {
		t.evictOldest()
	}
	t.entries[r.MAC] = lease
	changed := !known || old.Hostname != lease.Hostname || old.VendorClass != lease.VendorClass
	if changed {
		t.learned++
	}
	return changed
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
			if req, ok := Parse(buf[:n]); ok && table.Record(req, time.Now()) && onLearn != nil {
				onLearn(req)
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
