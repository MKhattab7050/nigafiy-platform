package filemgr

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// linkDir makes link point at target: a symlink, or on Windows without Developer Mode a
// directory junction (no privilege needed).
func linkDir(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS != "windows" || exec.Command("cmd", "/c", "mklink", "/J", link, target).Run() != nil {
			t.Skipf("cannot create a link here (%v)", err)
		}
	}
}

// EXT-8: a folder inside the allowed root is swapped for a link to a place outside it after the
// path was checked and before the file is opened. Reads, writes and creates must be refused, and
// nothing outside may be read, changed or left behind.
func TestSwapAfterCheckIsRefused(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "work")
	parked := filepath.Join(root, "parked")
	mk := func() {
		t.Helper()
		_ = os.Remove(dir) // a link left by the previous case
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("inside"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	swap := func(string) {
		_ = os.RemoveAll(parked)
		if err := os.Rename(dir, parked); err != nil {
			t.Fatalf("park: %v", err)
		}
		linkDir(t, outside, dir)
	}
	defer func() { afterValidate = func(string) {} }()

	payload := base64.StdEncoding.EncodeToString([]byte("planted"))
	cases := []Request{
		{Op: "download", Path: filepath.Join(dir, "secret.txt")},
		{Op: "hash", Path: filepath.Join(dir, "secret.txt")},
		{Op: "upload", Path: filepath.Join(dir, "secret.txt"), DataBase64: payload, Overwrite: true},
		{Op: "upload", Path: filepath.Join(dir, "new.txt"), DataBase64: payload},
		{Op: "touch", Path: filepath.Join(dir, "touched.txt"), DataBase64: payload},
		{Op: "copy", Path: filepath.Join(dir, "secret.txt"), TargetPath: root},
	}
	for _, c := range cases {
		mk()
		c.AllowedRoots = []string{root}
		afterValidate = swap
		res, err := Execute(c)
		afterValidate = func(string) {}
		if err == nil {
			t.Fatalf("%s through a swapped folder must be refused, got %+v", c.Op, res)
		}
		if res.DataBase64 != "" || res.SHA256 != "" {
			t.Fatalf("%s leaked data from outside: %+v", c.Op, res)
		}
		got, rerr := os.ReadFile(filepath.Join(outside, "secret.txt"))
		if rerr != nil || string(got) != "outside secret" {
			t.Fatalf("%s changed the file outside: %q %v", c.Op, got, rerr)
		}
		for _, n := range []string{"new.txt", "touched.txt"} {
			if _, serr := os.Lstat(filepath.Join(outside, n)); serr == nil {
				t.Fatalf("%s left %s outside the allowed root", c.Op, n)
			}
		}
		if c.Op == "copy" {
			if b, _ := os.ReadFile(filepath.Join(root, "secret.txt")); string(b) == "outside secret" {
				t.Fatal("copy brought the outside file into the allowed root")
			}
		}
		_ = os.Remove(filepath.Join(root, "secret.txt"))
	}

	// Without a swap the same requests work (the checks do not refuse plain files).
	mk()
	if _, err := Execute(Request{Op: "download", Path: filepath.Join(dir, "secret.txt"), AllowedRoots: []string{root}}); err != nil {
		t.Fatalf("plain download: %v", err)
	}
	if _, err := Execute(Request{Op: "upload", Path: filepath.Join(dir, "secret.txt"), DataBase64: payload, Overwrite: true, AllowedRoots: []string{root}}); err != nil {
		t.Fatalf("plain overwrite: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "secret.txt")); string(b) != "planted" {
		t.Fatalf("overwrite wrote %q", b)
	}
}
