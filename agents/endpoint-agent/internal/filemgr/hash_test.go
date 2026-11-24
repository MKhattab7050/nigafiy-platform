package filemgr

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The transfer queue's checks: "hash" gives the SHA-256 of a whole file of any size, and tells an
// interrupted upload where to resume; it never resumes into a file another upload did not start.
func TestHashAndResumeAnInterruptedUpload(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "big.bin")
	whole := strings.Repeat("0123456789", 100)
	sum := sha256.Sum256([]byte(whole))
	want := hex.EncodeToString(sum[:])

	if _, err := Execute(Request{Op: "upload", Path: target, Offset: 0, DataBase64: b64(whole[:400]), AllowedRoots: []string{tmp}}); err != nil {
		t.Fatal(err)
	}
	// The connection dropped here. The queue asks where to resume.
	h, err := Execute(Request{Op: "hash", Path: target, AllowedRoots: []string{tmp}})
	if err != nil {
		t.Fatal(err)
	}
	if h.TotalSize != 400 || h.UploadNext == nil || *h.UploadNext != 400 {
		t.Fatalf("resume point: size %d next %v", h.TotalSize, h.UploadNext)
	}
	if _, err := Execute(Request{Op: "upload", Path: target, Offset: 400, Append: true, DataBase64: b64(whole[400:]), ExpectedSHA256: want, AllowedRoots: []string{tmp}}); err != nil {
		t.Fatalf("resume: %v", err)
	}
	h, err = Execute(Request{Op: "hash", Path: target, AllowedRoots: []string{tmp}})
	if err != nil || h.SHA256 != want || h.TotalSize != int64(len(whole)) {
		t.Fatalf("hash after resume: %+v %v", h, err)
	}

	// A file no upload here started: hashed, but nothing to resume.
	other := filepath.Join(tmp, "other.txt")
	if err := os.WriteFile(other, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, err = Execute(Request{Op: "hash", Path: other, AllowedRoots: []string{tmp}})
	if err != nil || h.UploadNext != nil {
		t.Fatalf("foreign file must not offer a resume: %+v %v", h, err)
	}
	// The usual guards: outside the allowed roots, folders, traversal.
	if _, err := Execute(Request{Op: "hash", Path: filepath.Join(t.TempDir(), "x"), AllowedRoots: []string{tmp}}); err == nil {
		t.Fatal("hash outside the allowed roots must be refused")
	}
	if _, err := Execute(Request{Op: "hash", Path: tmp, AllowedRoots: []string{tmp}}); err == nil {
		t.Fatal("a folder cannot be hashed")
	}
	if _, err := Execute(Request{Op: "hash", Path: tmp + string(filepath.Separator) + ".." + string(filepath.Separator) + "x", AllowedRoots: []string{tmp}}); err == nil {
		t.Fatal("traversal must be refused")
	}
}
