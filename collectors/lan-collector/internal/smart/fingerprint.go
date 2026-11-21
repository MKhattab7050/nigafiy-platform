package smart

import (
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/dhcp"
)

// DHCP fingerprints: the option list (55) each client asks for, its vendor class (60), hostname
// (12) and, in a DHCPREQUEST, the server it chose (54). The passive DHCP listener (internal/dhcp,
// receive-only) hands every client message to Observe; the agent reports the table with Drain.
// Nothing is ever sent to the clients.

// Fingerprint is what one client announced most recently.
type Fingerprint struct {
	MAC         string    `json:"mac"`
	PRL         string    `json:"prl"`
	VendorClass string    `json:"vendor_class,omitempty"`
	Hostname    string    `json:"hostname,omitempty"`
	ServerID    string    `json:"server_id,omitempty"`
	SeenAt      time.Time `json:"seen_at"`
}

const (
	// MaxFingerprints bounds the table (and one report): random MACs on a hostile LAN cannot grow it.
	MaxFingerprints = 1024
	maxPRLLen       = 400
	dhcpRequest     = 3
)

// FingerprintTable keeps one fingerprint per client MAC until it is drained.
type FingerprintTable struct {
	mu      sync.Mutex
	entries map[string]Fingerprint
}

func NewFingerprintTable() *FingerprintTable {
	return &FingerprintTable{entries: map[string]Fingerprint{}}
}

// Observe records one client message, seen now.
func (t *FingerprintTable) Observe(m dhcp.ClientMessage) { t.ObserveAt(m, time.Now()) }

// ObserveAt records one client message seen at now. A message without an option list is no
// fingerprint and is ignored. A later message without a hostname, vendor class or server keeps
// the ones learned earlier.
func (t *FingerprintTable) ObserveAt(m dhcp.ClientMessage, now time.Time) {
	prl := boundPRL(m.PRL)
	if m.MAC == "" || prl == "" {
		return
	}
	fp := Fingerprint{
		MAC:         m.MAC,
		PRL:         prl,
		VendorClass: cleanText(m.VendorClass, 120),
		Hostname:    cleanText(m.Hostname, 120),
		SeenAt:      now.UTC(),
	}
	// Option 54 is the client's choice of server only in a DHCPREQUEST.
	if a, err := netip.ParseAddr(m.ServerID); err == nil && a.Is4() && m.Type == dhcpRequest {
		fp.ServerID = a.String()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	old, known := t.entries[m.MAC]
	if known {
		if fp.VendorClass == "" {
			fp.VendorClass = old.VendorClass
		}
		if fp.Hostname == "" {
			fp.Hostname = old.Hostname
		}
		if fp.ServerID == "" {
			fp.ServerID = old.ServerID
		}
	} else if len(t.entries) >= MaxFingerprints {
		t.evictOldestLocked()
	}
	t.entries[m.MAC] = fp
}

func (t *FingerprintTable) evictOldestLocked() {
	var oldest string
	var at time.Time
	for mac, f := range t.entries {
		if oldest == "" || f.SeenAt.Before(at) {
			oldest, at = mac, f.SeenAt
		}
	}
	delete(t.entries, oldest)
}

// Drain returns the clients seen at or after since (zero: all), sorted by MAC, and empties the table.
func (t *FingerprintTable) Drain(since time.Time) []Fingerprint {
	t.mu.Lock()
	entries := t.entries
	t.entries = map[string]Fingerprint{}
	t.mu.Unlock()
	out := make([]Fingerprint, 0, len(entries))
	for _, f := range entries {
		if !f.SeenAt.Before(since) {
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MAC < out[j].MAC })
	if len(out) > MaxFingerprints {
		out = out[:MaxFingerprints]
	}
	return out
}

func (t *FingerprintTable) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

// boundPRL keeps whole codes, in order, within the protocol's 400 characters.
func boundPRL(prl string) string {
	if len(prl) <= maxPRLLen {
		return prl
	}
	cut := prl[:maxPRLLen+1]
	if i := strings.LastIndexByte(cut, ','); i > 0 {
		return prl[:i]
	}
	return ""
}
