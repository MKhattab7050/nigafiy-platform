package filemgr

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestUploadNeverSilentlyOverwrites(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "report.txt")
	if err := os.WriteFile(target, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	up := func(offset int64, data string, overwrite bool) (Response, error) {
		return Execute(Request{Op: "upload", Path: target, Offset: offset, Append: offset > 0, DataBase64: b64(data), Overwrite: overwrite, AllowedRoots: []string{tmp}})
	}

	// 1. Existing file, no confirmed overwrite: refused and untouched.
	if _, err := up(0, "new", false); err == nil || !strings.HasPrefix(err.Error(), ErrUploadTargetExists) {
		t.Fatalf("expected %q refusal, got %v", ErrUploadTargetExists, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "original" {
		t.Fatalf("file changed without confirmation: %q", got)
	}

	// 2. A continuation chunk cannot be aimed at an existing file either (size must match the offset).
	if _, err := up(3, "XYZ", false); err == nil || !strings.Contains(err.Error(), "continuation refused") {
		t.Fatalf("continuation into a foreign file must be refused, got %v", err)
	}
	// Even exactly at its end: only a file this agent's own upload started can be continued.
	if _, err := up(8, "tail", false); err == nil || !strings.Contains(err.Error(), "no upload of report.txt started here") {
		t.Fatalf("appending to a file no upload started must be refused, got %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "original" {
		t.Fatalf("file changed by refused chunks: %q", got)
	}

	// 3. Operator-confirmed overwrite replaces it and says so.
	res, err := up(0, "replaced", true)
	if err != nil || !res.Overwritten || !strings.Contains(res.Message, "Overwrote") {
		t.Fatalf("confirmed overwrite: %+v %v", res, err)
	}
	if res, err = up(8, "-part2", false); err != nil || res.Overwritten {
		t.Fatalf("continuation after overwrite: %+v %v", res, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "replaced-part2" {
		t.Fatalf("content: %q", got)
	}

	// 4. A new file needs no confirmation; a folder can never be replaced by an upload.
	fresh := filepath.Join(tmp, "fresh.bin")
	if res, err := Execute(Request{Op: "upload", Path: fresh, DataBase64: b64("x"), AllowedRoots: []string{tmp}}); err != nil || res.Overwritten {
		t.Fatalf("new file: %+v %v", res, err)
	}
	if _, err := Execute(Request{Op: "upload", Path: tmp, DataBase64: b64("x"), Overwrite: true}); err == nil {
		t.Fatal("uploading over a folder must be refused")
	}
	if _, err := Execute(Request{Op: "upload", Path: filepath.Join(tmp, "gone.bin"), Offset: 10, DataBase64: b64("x")}); err == nil {
		t.Fatal("a continuation for a missing file must be refused")
	}
}

func TestDPAPIAndCredentialStoresAreForbidden(t *testing.T) {
	forbidden := []string{
		`C:\Users\alice\AppData\Roaming\Microsoft\Credentials`,
		`C:\Users\alice\AppData\Roaming\Microsoft\Credentials\DFBE70A7E5CC19A398EBF1B96859CE5D`,
		`C:\Users\alice\AppData\Roaming\Microsoft\Protect\S-1-5-21-1-2-3-1001\a1b2c3d4-0000-0000-0000-000000000000`,
		`C:\Users\alice\AppData\Local\Microsoft\Credentials`,
		`C:\Users\alice\AppData\Local\Microsoft\Vault\4BF4C442-9B8A-41A0-B380-DD4A704DDB28`,
		`C:\Users\alice\AppData\Roaming\Microsoft\Vault`,
		`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\Microsoft\Protect`,
		`C:\Windows\System32\Microsoft\Protect\S-1-5-18\User`,
		`C:\ProgramData\Microsoft\Vault`,
	}
	for _, p := range forbidden {
		if !isForbiddenCredentialPath(p) {
			t.Errorf("%s must be forbidden", p)
		}
	}
	allowed := []string{
		`C:\Users\alice\AppData\Roaming\Microsoft\Windows\Recent`,
		`C:\Users\alice\Documents\Credentials review.docx`,
		`C:\Users\alice\AppData\Roaming\Microsoft\ProtectedNotes`,
		`C:\Users\alice\AppData\Local\Microsoft\VaultBackup`,
	}
	for _, p := range allowed {
		if isForbiddenCredentialPath(p) {
			t.Errorf("%s must stay reachable", p)
		}
	}

	// Through the real request path, and search never enters a credential store.
	tmp := t.TempDir()
	store := filepath.Join(tmp, "AppData", "Roaming", "Microsoft", "Credentials")
	if err := os.MkdirAll(store, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "secretblob"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(Request{Op: "list", Path: store}); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("listing the Credentials folder must be forbidden, got %v", err)
	}
	if _, err := Execute(Request{Op: "download", Path: filepath.Join(store, "secretblob")}); err == nil {
		t.Fatal("downloading a credential blob must be forbidden")
	}
	res, err := Execute(Request{Op: "search", Path: tmp, Query: "secret", ShowHidden: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entries) != 0 {
		t.Fatalf("search must not reveal files inside a credential store: %+v", res.Entries)
	}
}
