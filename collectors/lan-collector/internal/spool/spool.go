// Package spool is the collector's on-disk outbox.
//
// Every telemetry batch is written here first and deleted only after the cloud acknowledged it,
// so measurements survive internet outages and collector restarts (at-least-once delivery; the
// cloud de-duplicates by batch id). The spool is bounded: when full, the oldest batch is dropped.
package spool

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Spool struct {
	dir string
	max int
	mu  sync.Mutex
	seq uint64
}

func Open(dir string, maxBatches int) (*Spool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create spool dir: %w", err)
	}
	return &Spool{dir: dir, max: maxBatches}, nil
}

func (s *Spool) list() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // names start with a zero-padded timestamp → chronological
	return names, nil
}

// Put durably stores one batch. It returns how many old batches had to be dropped to make room.
func (s *Spool) Put(batchID string, data []byte) (dropped int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	name := fmt.Sprintf("%020d-%06d-%s.json", time.Now().UnixNano(), s.seq%1_000_000, batchID)
	tmp := filepath.Join(s.dir, name+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return 0, fmt.Errorf("write spool file: %w", err)
	}
	// Rename is atomic: a crash never leaves a half-written batch that looks complete.
	if err := os.Rename(tmp, filepath.Join(s.dir, name)); err != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("commit spool file: %w", err)
	}
	names, err := s.list()
	if err != nil {
		return 0, err
	}
	for len(names) > s.max {
		if err := os.Remove(filepath.Join(s.dir, names[0])); err == nil {
			dropped++
		}
		names = names[1:]
	}
	return dropped, nil
}

// Oldest returns the oldest stored batch, or ok=false when the spool is empty.
func (s *Spool) Oldest() (name string, data []byte, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	names, err := s.list()
	if err != nil || len(names) == 0 {
		return "", nil, false, err
	}
	data, err = os.ReadFile(filepath.Join(s.dir, names[0]))
	if err != nil {
		return "", nil, false, err
	}
	return names[0], data, true, nil
}

func (s *Spool) Remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.Remove(filepath.Join(s.dir, filepath.Base(name)))
}

func (s *Spool) Depth() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	names, _ := s.list()
	return len(names)
}
