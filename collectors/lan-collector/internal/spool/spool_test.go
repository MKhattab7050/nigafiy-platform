package spool

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSpoolIsFIFOAndSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := s.Put(fmt.Sprintf("batch-%d", i), []byte(fmt.Sprintf(`{"n":%d}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	// Simulates a collector restart during an outage: a new process opens the same directory.
	s2, _ := Open(dir, 100)
	if s2.Depth() != 5 {
		t.Fatalf("depth after reopen = %d, want 5", s2.Depth())
	}
	for i := 0; i < 5; i++ {
		name, data, ok, err := s2.Oldest()
		if err != nil || !ok || string(data) != fmt.Sprintf(`{"n":%d}`, i) {
			t.Fatalf("item %d: ok=%v err=%v data=%s", i, ok, err, data)
		}
		if err := s2.Remove(name); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, ok, _ := s2.Oldest(); ok {
		t.Fatal("spool should be empty")
	}
}

func TestSpoolIsBoundedAndDropsOldest(t *testing.T) {
	s, _ := Open(t.TempDir(), 3)
	dropped := 0
	for i := 0; i < 10; i++ {
		d, err := s.Put(fmt.Sprintf("b%d", i), []byte(fmt.Sprint(i)))
		if err != nil {
			t.Fatal(err)
		}
		dropped += d
	}
	if s.Depth() != 3 || dropped != 7 {
		t.Fatalf("depth=%d dropped=%d, want 3/7", s.Depth(), dropped)
	}
	_, data, _, _ := s.Oldest()
	if string(data) != "7" {
		t.Fatalf("oldest remaining = %s, want 7", data)
	}
}

func TestSpoolIgnoresPartialWrites(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 10)
	if err := os.WriteFile(filepath.Join(dir, "00000000000000000001-000001-x.json.tmp"), []byte("{half"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s.Depth() != 0 {
		t.Fatal("a .tmp file from an interrupted write must not be treated as a batch")
	}
}
