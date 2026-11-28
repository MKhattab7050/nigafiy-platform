package filemgr

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWalkListsTheWholeTreeWithTotals(t *testing.T) {
	tmp := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(tmp, "a", "b", "empty"), 0o755))
	must(os.WriteFile(filepath.Join(tmp, "top.txt"), []byte("12345"), 0o644))
	must(os.WriteFile(filepath.Join(tmp, "a", "one.bin"), make([]byte, 100), 0o644))
	must(os.WriteFile(filepath.Join(tmp, "a", "b", "two.bin"), make([]byte, 1000), 0o644))

	res, err := Execute(Request{Op: "walk", Path: tmp, AllowedRoots: []string{tmp}})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if res.TotalFiles != 3 || res.TotalDirs != 3 || res.TotalSize != 1105 || res.Truncated {
		t.Fatalf("totals: files %d dirs %d size %d truncated %v", res.TotalFiles, res.TotalDirs, res.TotalSize, res.Truncated)
	}
	if len(res.Entries) != 6 {
		t.Fatalf("entries: %d", len(res.Entries))
	}
	// A folder comes before what is inside it, so the receiver can create it first.
	seen := map[string]bool{}
	for _, e := range res.Entries {
		parent := filepath.Dir(e.Path)
		if parent != tmp && !seen[parent] {
			t.Fatalf("%s listed before its folder", e.Path)
		}
		seen[e.Path] = true
	}

	// Outside the allowed roots: refused like list.
	if _, err := Execute(Request{Op: "walk", Path: tmp, AllowedRoots: []string{filepath.Join(tmp, "a")}}); err == nil {
		t.Fatal("walk outside the allowed roots was not refused")
	}
}

func TestDownloadChunkIsOneMiB(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "big.bin")
	if err := os.WriteFile(p, make([]byte, 3*1024*1024), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Execute(Request{Op: "download", Path: p, Length: 8 * 1024 * 1024, AllowedRoots: []string{tmp}})
	if err != nil {
		t.Fatal(err)
	}
	if res.BytesRead != 1024*1024 || res.EOF {
		t.Fatalf("read %d eof %v", res.BytesRead, res.EOF)
	}
}

// A large upload continues after the agent restarts (the tracker is kept in the state folder) and
// its last chunk is checked against the running SHA-256 without reading the file again.
func TestUploadResumesAfterRestart(t *testing.T) {
	tmp := t.TempDir()
	state := t.TempDir()
	SetStateDir(state)
	defer func() { uploads = &uploadTracker{m: map[string]trackedUpload{}} }()
	p := filepath.Join(tmp, "huge.bin")
	part1 := make([]byte, 300)
	part2 := make([]byte, 200)
	for i := range part1 {
		part1[i] = byte(i)
	}
	for i := range part2 {
		part2[i] = byte(i * 3)
	}
	whole := sha256.Sum256(append(append([]byte{}, part1...), part2...))
	if _, err := Execute(Request{Op: "upload", Path: p, DataBase64: base64.StdEncoding.EncodeToString(part1), AllowedRoots: []string{tmp}}); err != nil {
		t.Fatal(err)
	}
	// Restart: a new tracker reads the state folder.
	uploads = &uploadTracker{m: map[string]trackedUpload{}}
	SetStateDir(state)
	st, err := Execute(Request{Op: "hash", Path: p, SizeOnly: true, AllowedRoots: []string{tmp}})
	if err != nil || st.UploadNext == nil || *st.UploadNext != 300 || st.SHA256 != "" || st.ModTime == "" {
		t.Fatalf("size-only answer after restart: %+v err %v", st, err)
	}
	res, err := Execute(Request{Op: "upload", Path: p, Offset: 300, DataBase64: base64.StdEncoding.EncodeToString(part2), ExpectedSHA256: hex.EncodeToString(whole[:]), AllowedRoots: []string{tmp}})
	if err != nil || res.SHA256 != hex.EncodeToString(whole[:]) || res.TotalSize != 500 {
		t.Fatalf("continued upload: %+v err %v", res, err)
	}
	// Someone else's file of the same size is never continued.
	other := filepath.Join(tmp, "other.bin")
	if err := os.WriteFile(other, part1, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(Request{Op: "upload", Path: other, Offset: 300, DataBase64: base64.StdEncoding.EncodeToString(part2), AllowedRoots: []string{tmp}}); err == nil {
		t.Fatal("continued a file this agent did not upload")
	}
}

func TestDownloadCarriesChunkHashAndModTime(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "f.bin")
	data := []byte("hello chunk")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Execute(Request{Op: "download", Path: p, AllowedRoots: []string{tmp}})
	sum := sha256.Sum256(data)
	if err != nil || res.ChunkSHA256 != hex.EncodeToString(sum[:]) || res.ModTime == "" {
		t.Fatalf("%+v %v", res, err)
	}
}

// The modification time the tracker keeps must still match once the handle is closed, or every
// continued upload would fall back to reading the whole file again.
func TestUploadTrackerModTimeMatchesClosedFile(t *testing.T) {
	tmp := t.TempDir()
	defer func() { uploads = &uploadTracker{m: map[string]trackedUpload{}} }()
	p := filepath.Join(tmp, "m.bin")
	if _, err := Execute(Request{Op: "upload", Path: p, DataBase64: base64.StdEncoding.EncodeToString(make([]byte, 64)), AllowedRoots: []string{tmp}}); err != nil {
		t.Fatal(err)
	}
	tr, ok := uploads.lookup(p, 64)
	info, err := os.Stat(p)
	if !ok || err != nil || tr.ModTime != modTime(info) || len(tr.Hash) == 0 {
		t.Fatalf("tracked %+v ok %v, file mtime %v err %v", tr, ok, info.ModTime(), err)
	}
}

// A file changed by someone else while the upload waited (same size) is not trusted to the
// running hash: the last chunk checks the real file and reports the mismatch.
func TestUploadNoticesFileChangedWhileWaiting(t *testing.T) {
	tmp := t.TempDir()
	defer func() { uploads = &uploadTracker{m: map[string]trackedUpload{}} }()
	p := filepath.Join(tmp, "t.bin")
	part1, part2 := []byte("aaaaaaaa"), []byte("bbbb")
	whole := sha256.Sum256(append(append([]byte{}, part1...), part2...))
	if _, err := Execute(Request{Op: "upload", Path: p, DataBase64: base64.StdEncoding.EncodeToString(part1), AllowedRoots: []string{tmp}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("zzzzzzzz"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(p, future, future)
	_, err := Execute(Request{Op: "upload", Path: p, Offset: 8, DataBase64: base64.StdEncoding.EncodeToString(part2), ExpectedSHA256: hex.EncodeToString(whole[:]), AllowedRoots: []string{tmp}})
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("changed file passed the check: %v", err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("a file that failed its check stayed behind: %v", err)
	}
}

// Two copies of the same continuation chunk arriving together: exactly one is written.
func TestConcurrentContinuationChunksWriteOnce(t *testing.T) {
	tmp := t.TempDir()
	defer func() { uploads = &uploadTracker{m: map[string]trackedUpload{}} }()
	p := filepath.Join(tmp, "c.bin")
	if _, err := Execute(Request{Op: "upload", Path: p, DataBase64: base64.StdEncoding.EncodeToString(make([]byte, 16)), AllowedRoots: []string{tmp}}); err != nil {
		t.Fatal(err)
	}
	chunk := base64.StdEncoding.EncodeToString(make([]byte, 1<<20))
	var wg sync.WaitGroup
	var okCount atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Execute(Request{Op: "upload", Path: p, Offset: 16, DataBase64: chunk, AllowedRoots: []string{tmp}}); err == nil {
				okCount.Add(1)
			}
		}()
	}
	wg.Wait()
	info, _ := os.Stat(p)
	if okCount.Load() != 1 || info.Size() != 16+1<<20 {
		t.Fatalf("%d chunks accepted, file %d bytes", okCount.Load(), info.Size())
	}
}
