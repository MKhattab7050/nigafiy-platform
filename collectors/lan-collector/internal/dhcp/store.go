package dhcp

// Persistence of the learned-name table, so names that phones and other devices announced survive
// a collector restart. The file lives in the collector's state_dir next to the spool and the
// cached configuration, follows the same conventions (0600 file in a 0700 directory, written to a
// temporary file and renamed into place), and holds only what devices broadcast about themselves:
// no credentials. Everything in it came from untrusted devices, so it is validated again on load
// exactly as if it had just arrived from the wire.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/identify"
	"github.com/nigafiy/sensor/internal/netinfo"
)

const (
	// FileName is the table's file inside state_dir.
	FileName = "dhcp-names.json"
	// fileVersion is bumped whenever the on-disk format changes incompatibly. A file with another
	// version is not guessed at: the table starts empty and is rewritten in the current format.
	fileVersion = 1
	// maxFileBytes bounds what is read back. A full table (maxEntries entries of at most a few
	// hundred bytes each) is well under 2 MiB; anything larger was not written by us.
	maxFileBytes = 4 << 20
	// SaveDebounce is how long Persist waits after a change before writing, so a burst of DHCP
	// traffic (every renewal refreshes last-seen) costs one write, not one per packet.
	SaveDebounce = 30 * time.Second
	// maxFieldLen caps every stored string. DHCP options are at most 255 bytes and identify.Clean
	// already shortens names further; this is the last guard on what reaches the disk.
	maxFieldLen = 255
	// clockSkew tolerates a last-seen slightly in the future (clock adjusted backwards between
	// runs); anything further ahead is not trusted.
	clockSkew = 24 * time.Hour
)

type fileEntry struct {
	MAC         string    `json:"mac"`
	Hostname    string    `json:"hostname,omitempty"`
	VendorClass string    `json:"vendor_class,omitempty"`
	RequestedIP string    `json:"requested_ip,omitempty"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
}

type fileFormat struct {
	Version int         `json:"version"`
	SavedAt time.Time   `json:"saved_at"`
	Entries []fileEntry `json:"entries"`
}

// writeHook lets tests fail a write half-way to prove the old file survives. Nil in production.
var writeHook func(f *os.File) error

// LoadTable reads the table saved at path. It never fails hard: a missing file gives an empty
// table and a nil error; a truncated, corrupt, oversized or foreign-version file gives an empty
// table plus an error describing the problem, so the caller can log it once and carry on.
// Entries that are invalid, expired or beyond the cap are dropped individually.
func LoadTable(path string, now time.Time) (*Table, error) {
	t := NewTable()
	removeStaleTemps(path)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return t, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return t, fmt.Errorf("read %s: %w", path, err)
	}
	if len(raw) > maxFileBytes {
		return t, fmt.Errorf("%s is larger than %d bytes; ignoring it", path, maxFileBytes)
	}
	var ff fileFormat
	if err := json.Unmarshal(raw, &ff); err != nil {
		return t, fmt.Errorf("%s is corrupt (%v); starting with an empty table", path, err)
	}
	if ff.Version != fileVersion {
		return t, fmt.Errorf("%s has format version %d, expected %d; starting with an empty table", path, ff.Version, fileVersion)
	}
	for _, e := range ff.Entries {
		mac, lease, ok := validEntry(e, now)
		if !ok {
			continue
		}
		if cur, dup := t.entries[mac]; dup && !lease.SeenAt.After(cur.SeenAt) {
			continue
		}
		t.entries[mac] = lease
	}
	for len(t.entries) > maxEntries {
		t.evictOldest()
	}
	return t, nil
}

// validEntry re-applies to a stored entry every rule a freshly received packet goes through.
func validEntry(e fileEntry, now time.Time) (string, Lease, bool) {
	mac := netinfo.NormalizeMAC(e.MAC)
	if mac == "" || mac != e.MAC {
		return "", Lease{}, false
	}
	l := Lease{
		Hostname:    capLen(identify.Clean(e.Hostname)),
		VendorClass: capLen(identify.Clean(e.VendorClass)),
		FirstSeen:   e.FirstSeen,
		SeenAt:      e.LastSeen,
	}
	if l.Hostname == "" && l.VendorClass == "" {
		return "", Lease{}, false
	}
	if ip := net.ParseIP(e.RequestedIP); ip != nil && ip.To4() != nil && !strings.Contains(e.RequestedIP, ":") {
		l.RequestedIP = ip.To4().String()
	}
	if l.SeenAt.IsZero() || l.SeenAt.After(now.Add(clockSkew)) || now.Sub(l.SeenAt) > entryTTL {
		return "", Lease{}, false
	}
	if l.FirstSeen.IsZero() || l.FirstSeen.After(l.SeenAt) {
		l.FirstSeen = l.SeenAt
	}
	return mac, l, true
}

func capLen(s string) string {
	if len(s) <= maxFieldLen {
		return s
	}
	return identify.Clean(s[:maxFieldLen]) // Clean also repairs a UTF-8 sequence cut in half
}

// Save writes the table atomically: a temporary file in the same directory is written, flushed
// to disk and renamed over path, so a crash or power loss leaves either the old file or the new
// one, never a half-written table. Expired entries are left out.
func (t *Table) Save(path string, now time.Time) error {
	ff := t.snapshot(now)
	raw, err := json.Marshal(ff)
	if err != nil {
		return err
	}
	if err := writeAtomic(path, raw); err != nil {
		t.mu.Lock()
		t.markDirtyLocked() // try again on the next change or at shutdown
		t.mu.Unlock()
		return err
	}
	return nil
}

// snapshot copies the live entries and marks the table clean. Changes that arrive after this
// point mark it dirty again, so nothing learned during the write is lost.
func (t *Table) snapshot(now time.Time) fileFormat {
	t.mu.Lock()
	defer t.mu.Unlock()
	ff := fileFormat{Version: fileVersion, SavedAt: now.UTC(), Entries: make([]fileEntry, 0, len(t.entries))}
	for mac, l := range t.entries {
		if now.Sub(l.SeenAt) > entryTTL {
			delete(t.entries, mac) // expired: forget it in memory too
			continue
		}
		ff.Entries = append(ff.Entries, fileEntry{
			MAC: mac, Hostname: l.Hostname, VendorClass: l.VendorClass, RequestedIP: l.RequestedIP,
			FirstSeen: l.FirstSeen.UTC(), LastSeen: l.SeenAt.UTC(),
		})
	}
	sort.Slice(ff.Entries, func(i, j int) bool { return ff.Entries[i].MAC < ff.Entries[j].MAC })
	t.dirty = false
	return ff
}

func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	fail := func(err error) error {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	// Owner-only, like credential.json and the spool. (CreateTemp already uses 0600 on Unix.)
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		return fail(err)
	}
	if _, err := f.Write(data); err != nil {
		return fail(err)
	}
	if writeHook != nil {
		if err := writeHook(f); err != nil {
			return fail(err)
		}
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := renameReplacing(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	syncDir(dir)
	return nil
}

// renameReplacing renames tmp over path. On Windows the rename fails with "access denied" while
// another handle has path open (an antivirus scan, the search indexer, or a reader loading the
// table), or with a sharing violation, which Go does not map to os.ErrPermission. It retries any
// error except a missing temp file for up to about two seconds before giving up.
func renameReplacing(tmp, path string) error {
	err := os.Rename(tmp, path)
	if runtime.GOOS != "windows" {
		return err
	}
	for i := 0; err != nil && !errors.Is(err, os.ErrNotExist) && i < 40; i++ {
		time.Sleep(50 * time.Millisecond)
		err = os.Rename(tmp, path)
	}
	return err
}

// syncDir makes the rename itself durable on Unix. Windows has no directory handle to flush and
// its rename is already journaled by NTFS.
func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
}

// removeStaleTemps deletes temporary files left behind by a crash during a previous save.
func removeStaleTemps(path string) {
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(path), filepath.Base(path)+".*.tmp"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// Persist keeps the file at path up to date until ctx ends: after a change it waits debounce,
// then writes once; when ctx ends it writes any unsaved change a final time. The returned
// channel is closed after that final write, so a clean shutdown can wait for it. onErr (may be
// nil) receives write failures; at most one per debounce period.
func (t *Table) Persist(ctx context.Context, path string, debounce time.Duration, onErr func(error)) <-chan struct{} {
	done := make(chan struct{})
	save := func() {
		t.mu.Lock()
		dirty := t.dirty
		t.mu.Unlock()
		if !dirty {
			return
		}
		if err := t.Save(path, time.Now()); err != nil && onErr != nil {
			onErr(err)
		}
	}
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				save()
				return
			case <-t.changed:
			}
			select {
			case <-ctx.Done():
				save()
				return
			case <-time.After(debounce):
			}
			save()
		}
	}()
	return done
}
