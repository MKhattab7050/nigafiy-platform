package dhcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSaveAndLoadTableRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC().Truncate(time.Second)

	// Missing file returns an empty table and nil error, and cleans up stale .tmp files.
	staleTmp := path + ".12345.tmp"
	if err := os.WriteFile(staleTmp, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	empty, err := LoadTable(path, now)
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if empty.Len() != 0 {
		t.Fatalf("expected empty table, got %d", empty.Len())
	}
	if _, err := os.Stat(staleTmp); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected stale temp file to be removed, stat err = %v", err)
	}

	// Populate table and save.
	table := NewTable()
	firstSeen := now.Add(-2 * time.Hour)
	table.Record(Request{
		MAC: "da:a1:19:00:00:50",
		Lease: Lease{
			Hostname:    "Galaxy-A52",
			VendorClass: "android-dhcp-14",
			RequestedIP: "192.168.1.64",
		},
	}, firstSeen)
	// Renewal updates SeenAt while preserving FirstSeen and Hostname.
	table.Record(Request{
		MAC: "da:a1:19:00:00:50",
		Lease: Lease{
			VendorClass: "android-dhcp-14",
			RequestedIP: "192.168.1.65",
		},
	}, now)
	table.Record(Request{
		MAC: "00:11:22:33:44:55",
		Lease: Lease{
			Hostname:    "Office-PC",
			VendorClass: "MSFT 5.0",
			RequestedIP: "192.168.1.10",
		},
	}, now.Add(-10*time.Minute))

	if err := table.Save(path, now); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := LoadTable(path, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("LoadTable failed: %v", err)
	}
	if loaded.Len() != 2 {
		t.Fatalf("expected 2 entries, got %d", loaded.Len())
	}
	l1, ok := loaded.Lookup("da:a1:19:00:00:50")
	if !ok || l1.Hostname != "Galaxy-A52" || l1.VendorClass != "android-dhcp-14" || l1.RequestedIP != "192.168.1.65" {
		t.Fatalf("unexpected entry 1: %+v ok=%v", l1, ok)
	}
	if !l1.FirstSeen.Equal(firstSeen) || !l1.SeenAt.Equal(now) {
		t.Fatalf("timestamps not preserved: FirstSeen=%v (want %v), SeenAt=%v (want %v)", l1.FirstSeen, firstSeen, l1.SeenAt, now)
	}
	l2, ok := loaded.Lookup("00:11:22:33:44:55")
	if !ok || l2.Hostname != "Office-PC" || l2.VendorClass != "MSFT 5.0" || l2.RequestedIP != "192.168.1.10" {
		t.Fatalf("unexpected entry 2: %+v ok=%v", l2, ok)
	}
}

func TestSaveAtomicFailureRecoveryWithWriteHook(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC().Truncate(time.Second)

	table := NewTable()
	table.Record(Request{
		MAC:   "00:11:22:33:44:55",
		Lease: Lease{Hostname: "Original-Host", VendorClass: "MSFT 5.0"},
	}, now)
	if err := table.Save(path, now); err != nil {
		t.Fatalf("initial Save failed: %v", err)
	}

	// Record a second host and simulate a failure mid-write via writeHook.
	table.Record(Request{
		MAC:   "da:a1:19:00:00:50",
		Lease: Lease{Hostname: "New-Phone", VendorClass: "android-dhcp-14"},
	}, now.Add(time.Second))

	writeHook = func(f *os.File) error {
		return errors.New("simulated disk full during atomic write")
	}
	defer func() { writeHook = nil }()

	if err := table.Save(path, now.Add(time.Second)); err == nil {
		t.Fatal("expected Save to fail when writeHook returns an error")
	}

	// No leftover .tmp files should remain after the failed write.
	if matches, _ := filepath.Glob(path + ".*.tmp"); len(matches) != 0 {
		t.Fatalf("expected temp files to be cleaned up on failure, found %v", matches)
	}

	// The original on-disk file must still be intact and readable.
	onDisk, err := LoadTable(path, now.Add(2*time.Second))
	if err != nil {
		t.Fatalf("LoadTable after failed Save returned error: %v", err)
	}
	if onDisk.Len() != 1 {
		t.Fatalf("expected previous file with 1 entry to remain intact, got %d", onDisk.Len())
	}
	if l, ok := onDisk.Lookup("00:11:22:33:44:55"); !ok || l.Hostname != "Original-Host" {
		t.Fatalf("original entry corrupted: %+v ok=%v", l, ok)
	}

	// Because the failed Save re-marked the table dirty, clearing writeHook and saving again writes both entries.
	writeHook = nil
	if err := table.Save(path, now.Add(2*time.Second)); err != nil {
		t.Fatalf("retry Save failed: %v", err)
	}
	recovered, err := LoadTable(path, now.Add(3*time.Second))
	if err != nil || recovered.Len() != 2 {
		t.Fatalf("expected 2 entries after recovery Save, got len=%d err=%v", recovered.Len(), err)
	}
}

func TestLoadTableRejectsCorruptOversizedAndWrongVersionFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC()

	// 1. Corrupt JSON
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	tbl, err := LoadTable(path, now)
	if err == nil || !strings.Contains(err.Error(), "corrupt") || tbl.Len() != 0 {
		t.Fatalf("expected corrupt error and empty table, got len=%d err=%v", tbl.Len(), err)
	}

	// 2. Wrong format version
	wrongVer, _ := json.Marshal(fileFormat{Version: fileVersion + 1, SavedAt: now})
	if err := os.WriteFile(path, wrongVer, 0o600); err != nil {
		t.Fatal(err)
	}
	tbl, err = LoadTable(path, now)
	if err == nil || !strings.Contains(err.Error(), "format version") || tbl.Len() != 0 {
		t.Fatalf("expected format version error and empty table, got len=%d err=%v", tbl.Len(), err)
	}

	// 3. Oversized file (> maxFileBytes)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxFileBytes + 10); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	_ = f.Close()
	tbl, err = LoadTable(path, now)
	if err == nil || !strings.Contains(err.Error(), "larger than") || tbl.Len() != 0 {
		t.Fatalf("expected oversized error and empty table, got len=%d err=%v", tbl.Len(), err)
	}
}

func TestTTLExpiryAndValidationOnLoadAndSave(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC().Truncate(time.Second)

	// Craft a file containing valid, expired, future-beyond-skew, malformed MAC, empty name/vendor, and duplicate entries.
	ff := fileFormat{
		Version: fileVersion,
		SavedAt: now,
		Entries: []fileEntry{
			{
				MAC: "00:11:22:33:44:55", Hostname: "Fresh-Host", RequestedIP: "192.168.1.20",
				FirstSeen: now.Add(-time.Hour), LastSeen: now.Add(-time.Hour),
			},
			{
				// Duplicate MAC with newer LastSeen should win.
				MAC: "00:11:22:33:44:55", Hostname: "Fresh-Host-Renamed", RequestedIP: "fe80::1", // IPv6 should be stripped
				FirstSeen: now.Add(time.Hour), // FirstSeen after LastSeen should be repaired to LastSeen
				LastSeen:  now.Add(-10 * time.Minute),
			},
			{
				// Expired entry (> entryTTL old)
				MAC: "00:11:22:33:44:66", Hostname: "Stale-Host",
				FirstSeen: now.Add(-entryTTL - 2*time.Hour), LastSeen: now.Add(-entryTTL - time.Hour),
			},
			{
				// Far future entry (> clockSkew ahead)
				MAC: "00:11:22:33:44:77", Hostname: "Future-Host",
				FirstSeen: now, LastSeen: now.Add(clockSkew + time.Hour),
			},
			{
				// Non-normalized / invalid MAC
				MAC: "00:11:22:33:44:88:99", Hostname: "Bad-MAC",
				FirstSeen: now, LastSeen: now,
			},
			{
				// Upper-case MAC (not canonical)
				MAC: "AA:BB:CC:DD:EE:FF", Hostname: "Upper-MAC",
				FirstSeen: now, LastSeen: now,
			},
			{
				// Empty hostname and vendor class
				MAC:       "00:11:22:33:44:99",
				FirstSeen: now, LastSeen: now,
			},
		},
	}
	raw, _ := json.Marshal(ff)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	tbl, err := LoadTable(path, now)
	if err != nil {
		t.Fatalf("LoadTable failed: %v", err)
	}
	if tbl.Len() != 1 {
		t.Fatalf("expected only 1 valid non-expired entry, got %d", tbl.Len())
	}
	l, ok := tbl.Lookup("00:11:22:33:44:55")
	if !ok || l.Hostname != "Fresh-Host-Renamed" || l.RequestedIP != "" || !l.FirstSeen.Equal(l.SeenAt) {
		t.Fatalf("unexpected validated entry: %+v ok=%v", l, ok)
	}

	// Verify Save drops entries that have expired since they were recorded.
	tbl.Record(Request{
		MAC:   "00:11:22:33:44:aa",
		Lease: Lease{Hostname: "Old-Device"},
	}, now.Add(-entryTTL-time.Minute))
	if err := tbl.Save(path, now); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	if tbl.Len() != 1 {
		t.Fatalf("expected expired entry to be pruned from memory on Save, got %d", tbl.Len())
	}
	reloaded, err := LoadTable(path, now)
	if err != nil || reloaded.Len() != 1 {
		t.Fatalf("expected 1 entry on reload after TTL prune, got len=%d err=%v", reloaded.Len(), err)
	}
}

func TestLoadTableCapsAtMaxEntries(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC().Truncate(time.Second)

	entries := make([]fileEntry, 0, maxEntries+10)
	for i := 0; i < maxEntries+10; i++ {
		mac := fmt.Sprintf("02:00:00:%02x:%02x:%02x", (i>>16)&0xff, (i>>8)&0xff, i&0xff)
		entries = append(entries, fileEntry{
			MAC:       mac,
			Hostname:  fmt.Sprintf("host-%d", i),
			FirstSeen: now.Add(-time.Duration(maxEntries+20-i) * time.Second),
			LastSeen:  now.Add(-time.Duration(maxEntries+20-i) * time.Second),
		})
	}
	raw, _ := json.Marshal(fileFormat{Version: fileVersion, SavedAt: now, Entries: entries})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	tbl, err := LoadTable(path, now)
	if err != nil {
		t.Fatalf("LoadTable failed: %v", err)
	}
	if tbl.Len() != maxEntries {
		t.Fatalf("expected table capped at %d entries, got %d", maxEntries, tbl.Len())
	}
	// Oldest entry (i=0) should have been evicted.
	if _, ok := tbl.Lookup("02:00:00:00:00:00"); ok {
		t.Fatal("expected oldest entry to be evicted")
	}
}

func TestPersistDebounceAndFinalSaveOnCancel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	now := time.Now().UTC()

	table := NewTable()
	ctx, cancel := context.WithCancel(context.Background())
	var errCount atomic.Int32
	done := table.Persist(ctx, path, 40*time.Millisecond, func(err error) {
		errCount.Add(1)
	})

	// Burst of changes within debounce window should coalesce and write after debounce.
	table.Record(Request{MAC: "00:11:22:33:44:01", Lease: Lease{Hostname: "Host-1"}}, now)
	table.Record(Request{MAC: "00:11:22:33:44:02", Lease: Lease{Hostname: "Host-2"}}, now)

	// Poll with a plain read, not LoadTable: LoadTable removes leftover "<file>.*.tmp" files (it is
	// meant to run once at start-up, before Persist), so calling it while Persist runs can delete
	// the temp file Persist is about to rename. That made this test fail about 1 run in 30.
	savedEntries := func() int {
		raw, err := os.ReadFile(path)
		if err != nil {
			return -1
		}
		var ff fileFormat
		if json.Unmarshal(raw, &ff) != nil {
			return -1
		}
		return len(ff.Entries)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && savedEntries() != 2 {
		time.Sleep(15 * time.Millisecond)
	}
	if n := savedEntries(); n != 2 {
		t.Fatalf("expected debounced write of 2 entries, got %d", n)
	}

	// Now record a 3rd entry with a long debounce still pending, and immediately cancel ctx.
	// Persist must perform a final save before closing done.
	table.Record(Request{MAC: "00:11:22:33:44:03", Lease: Lease{Hostname: "Host-3-On-Shutdown"}}, now)
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Persist did not finish after context cancellation")
	}

	if errCount.Load() != 0 {
		t.Fatalf("unexpected write errors during Persist: %d", errCount.Load())
	}
	finalTable, err := LoadTable(path, now)
	if err != nil || finalTable.Len() != 3 {
		t.Fatalf("expected final save on shutdown to persist 3rd entry, got len=%d err=%v", finalTable.Len(), err)
	}
	if l, ok := finalTable.Lookup("00:11:22:33:44:03"); !ok || l.Hostname != "Host-3-On-Shutdown" {
		t.Fatalf("3rd entry missing after shutdown save: %+v ok=%v", l, ok)
	}
}
