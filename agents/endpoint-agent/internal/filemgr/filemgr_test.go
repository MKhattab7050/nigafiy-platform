package filemgr

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"path/filepath"
	"testing"
)

func TestFileManagerLifecycleAndSecurity(t *testing.T) {
	tmp := t.TempDir()

	// 1. Roots
	rootsRes, err := Execute(Request{Op: "roots"})
	if err != nil || len(rootsRes.Roots) == 0 {
		t.Fatalf("expected non-empty roots, got err=%v roots=%d", err, len(rootsRes.Roots))
	}

	// 2. Mkdir
	subDir := filepath.Join(tmp, "reports")
	if _, err := Execute(Request{Op: "mkdir", Path: subDir, AllowedRoots: []string{tmp}}); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	// 3. Touch / Create file
	helloPath := filepath.Join(subDir, "notes.txt")
	content := []byte("LAN Detective Enterprise File Manager Test")
	if _, err := Execute(Request{
		Op:           "touch",
		Path:         helloPath,
		DataBase64:   base64.StdEncoding.EncodeToString(content),
		AllowedRoots: []string{tmp},
	}); err != nil {
		t.Fatalf("touch failed: %v", err)
	}

	// 4. List directory
	listRes, err := Execute(Request{Op: "list", Path: subDir, AllowedRoots: []string{tmp}})
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if len(listRes.Entries) != 1 || listRes.Entries[0].Name != "notes.txt" || listRes.Entries[0].Ext != "txt" {
		t.Fatalf("unexpected list entries: %+v", listRes.Entries)
	}

	// 5. Rename
	if _, err := Execute(Request{
		Op:           "rename",
		Path:         helloPath,
		NewName:      "summary.txt",
		AllowedRoots: []string{tmp},
	}); err != nil {
		t.Fatalf("rename failed: %v", err)
	}
	renamedPath := filepath.Join(subDir, "summary.txt")

	// 6. Copy & Move
	backupDir := filepath.Join(tmp, "backup")
	_, _ = Execute(Request{Op: "mkdir", Path: backupDir, AllowedRoots: []string{tmp}})
	if _, err := Execute(Request{
		Op:           "copy",
		Paths:        []string{renamedPath},
		TargetPath:   backupDir,
		AllowedRoots: []string{tmp},
	}); err != nil {
		t.Fatalf("copy failed: %v", err)
	}

	archiveDir := filepath.Join(tmp, "archive")
	_, _ = Execute(Request{Op: "mkdir", Path: archiveDir, AllowedRoots: []string{tmp}})
	if _, err := Execute(Request{
		Op:           "move",
		Paths:        []string{filepath.Join(backupDir, "summary.txt")},
		TargetPath:   archiveDir,
		AllowedRoots: []string{tmp},
	}); err != nil {
		t.Fatalf("move failed: %v", err)
	}

	// 7. Search
	searchRes, err := Execute(Request{
		Op:           "search",
		Path:         tmp,
		Query:        "summary",
		AllowedRoots: []string{tmp},
	})
	if err != nil || len(searchRes.Entries) != 2 {
		t.Fatalf("expected 2 search hits for summary, got %d (err=%v)", len(searchRes.Entries), err)
	}

	// 8. Chunked Upload with SHA-256 verification & Download
	uploadPath := filepath.Join(tmp, "chunked.bin")
	part1 := []byte("First chunk of data -- ")
	part2 := []byte("Second chunk of data!")
	combined := append(append([]byte{}, part1...), part2...)
	sum := sha256.Sum256(combined)
	sumHex := hex.EncodeToString(sum[:])

	if _, err := Execute(Request{
		Op:           "upload",
		Path:         uploadPath,
		Offset:       0,
		Append:       false,
		DataBase64:   base64.StdEncoding.EncodeToString(part1),
		AllowedRoots: []string{tmp},
	}); err != nil {
		t.Fatalf("upload chunk 1 failed: %v", err)
	}
	if _, err := Execute(Request{
		Op:             "upload",
		Path:           uploadPath,
		Offset:         int64(len(part1)),
		Append:         true,
		DataBase64:     base64.StdEncoding.EncodeToString(part2),
		ExpectedSHA256: sumHex,
		AllowedRoots:   []string{tmp},
	}); err != nil {
		t.Fatalf("upload chunk 2 failed: %v", err)
	}

	dlRes, err := Execute(Request{
		Op:           "download",
		Path:         uploadPath,
		Offset:       0,
		Length:       1024,
		AllowedRoots: []string{tmp},
	})
	if err != nil || !dlRes.EOF || dlRes.SHA256 != sumHex {
		t.Fatalf("download failed or checksum mismatch: err=%v eof=%v sha=%s", err, dlRes.EOF, dlRes.SHA256)
	}

	// 9. Delete requires ConfirmDestructive
	if _, err := Execute(Request{Op: "delete", Path: uploadPath, ConfirmDestructive: false}); err == nil {
		t.Fatal("expected delete without confirmation to be rejected")
	}
	if _, err := Execute(Request{Op: "delete", Path: uploadPath, ConfirmDestructive: true, AllowedRoots: []string{tmp}}); err != nil {
		t.Fatalf("confirmed delete failed: %v", err)
	}

	// 10. Security boundaries: traversal, outside allowed roots, and protected system paths
	if _, err := ValidateAndCleanPath(filepath.Join(tmp, "..", "outside"), []string{tmp}, false); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
	if _, err := ValidateAndCleanPath(`C:\Windows\System32\config\SAM`, nil, false); err == nil {
		t.Fatal("expected SAM credential hive to be rejected")
	}
	if _, err := ValidateAndCleanPath(`C:\Windows\System32\cmd.exe`, nil, true); err == nil {
		t.Fatal("expected mutating operation on System32 to be rejected")
	}
}

