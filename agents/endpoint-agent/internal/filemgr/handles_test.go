package filemgr

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// raceFixture: an allowed root with a folder "work" (holding secret.txt and sub/inner.txt) and a
// folder outside the root with its own secret.txt that nothing may read, change or delete.
type raceFixture struct {
	t       *testing.T
	root    string
	outside string
	dir     string
	parked  string
}

func newRaceFixture(t *testing.T) *raceFixture {
	t.Helper()
	f := &raceFixture{t: t, root: t.TempDir(), outside: t.TempDir()}
	f.dir = filepath.Join(f.root, "work")
	f.parked = filepath.Join(f.root, "parked")
	write(t, filepath.Join(f.outside, "secret.txt"), "outside secret")
	write(t, filepath.Join(f.outside, "sub", "inner.txt"), "outside inner")
	return f
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// reset puts a plain "work" folder back (removing the link a previous case left).
func (f *raceFixture) reset() {
	f.t.Helper()
	removeLink(f.dir)
	_ = os.RemoveAll(f.dir)
	_ = os.RemoveAll(f.parked)
	_ = os.RemoveAll(filepath.Join(f.root, "dest"))
	write(f.t, filepath.Join(f.dir, "secret.txt"), "inside")
	write(f.t, filepath.Join(f.dir, "sub", "inner.txt"), "inside inner")
	if err := os.MkdirAll(filepath.Join(f.root, "dest"), 0o755); err != nil {
		f.t.Fatal(err)
	}
}

// removeLink deletes a link or junction itself (never what it points at).
func removeLink(p string) {
	if st, err := os.Lstat(p); err == nil && (st.Mode()&fs.ModeSymlink != 0 || st.Mode()&fs.ModeIrregular != 0) {
		_ = os.Remove(p)
	}
}

// swapper returns a hook that, once, parks the folder at p and puts a link to target there. It
// fires on the first call (afterValidate, which gets the checked path) or, with onlyFor, only when
// the hook is called for p itself (afterResolve, which gets each folder it is about to open).
func (f *raceFixture) swapper(p, target string, onlyFor bool) func(string) {
	done := false
	return func(got string) {
		if done || (onlyFor && !samePath(got, p)) {
			return
		}
		done = true
		_ = os.RemoveAll(f.parked)
		if err := os.Rename(p, f.parked); err != nil {
			f.t.Fatalf("park %s: %v", p, err)
		}
		linkDir(f.t, target, p)
	}
}

// outsideIntact fails when anything outside the root was read into, changed, removed or added.
func (f *raceFixture) outsideIntact(what string) {
	f.t.Helper()
	for p, want := range map[string]string{
		filepath.Join(f.outside, "secret.txt"):       "outside secret",
		filepath.Join(f.outside, "sub", "inner.txt"): "outside inner",
	} {
		if got, err := os.ReadFile(p); err != nil || string(got) != want {
			f.t.Fatalf("%s changed %s outside the allowed root: %q %v", what, p, got, err)
		}
	}
	entries, _ := os.ReadDir(f.outside)
	if len(entries) != 2 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		f.t.Fatalf("%s left something outside the allowed root: %v", what, names)
	}
}

func (f *raceFixture) noOutsideNames(what string, res Response) {
	f.t.Helper()
	for _, e := range res.Entries {
		if e.Name == "secret.txt" || e.Name == "inner.txt" || e.Name == "sub" {
			f.t.Fatalf("%s showed an entry of the folder outside: %+v", what, e)
		}
	}
}

func (f *raceFixture) requests() []Request {
	return []Request{
		{Op: "mkdir", Path: filepath.Join(f.dir, "newdir")},
		{Op: "mkdir", Path: filepath.Join(f.dir, "a", "b")},
		{Op: "rename", Path: filepath.Join(f.dir, "secret.txt"), NewName: "renamed.txt"},
		{Op: "rename", Path: filepath.Join(f.dir, "sub"), NewName: "renamed"},
		{Op: "move", Path: filepath.Join(f.dir, "secret.txt"), TargetPath: filepath.Join(f.root, "dest")},
		{Op: "move", Path: filepath.Join(f.dir, "sub"), TargetPath: filepath.Join(f.root, "dest")},
		{Op: "delete", Path: filepath.Join(f.dir, "secret.txt"), ConfirmDestructive: true},
		{Op: "delete", Path: filepath.Join(f.dir, "sub"), ConfirmDestructive: true},
		{Op: "list", Path: f.dir},
		{Op: "search", Path: f.dir, Query: "e"},
		{Op: "copy", Path: f.dir, TargetPath: filepath.Join(f.root, "dest")},
	}
}

// R-7: a folder inside the allowed root is swapped for a link to a place outside it right after
// the path check (afterValidate) or right after the folder's real location was resolved and before
// it is opened (afterResolve). Every operation must be refused, and nothing outside may be shown,
// changed, removed or added.
func TestHandleOpsRefuseFolderSwappedForLink(t *testing.T) {
	f := newRaceFixture(t)
	defer func() { afterValidate = func(string) {}; afterResolve = func(string) {} }()
	for _, hook := range []string{"afterValidate", "afterResolve"} {
		for _, c := range f.requests() {
			f.reset()
			c.AllowedRoots = []string{f.root}
			swap := f.swapper(f.dir, f.outside, hook == "afterResolve")
			if hook == "afterValidate" {
				afterValidate = swap
			} else {
				afterResolve = swap
			}
			res, err := Execute(c)
			afterValidate, afterResolve = func(string) {}, func(string) {}
			what := hook + " " + c.Op + " " + filepath.Base(c.Path)
			if err == nil {
				t.Fatalf("%s through a swapped folder must be refused, got %+v", what, res)
			}
			f.noOutsideNames(what, res)
			f.outsideIntact(what)
			if c.Op == "move" || c.Op == "copy" {
				if entries, _ := os.ReadDir(filepath.Join(f.root, "dest")); len(entries) != 0 {
					t.Fatalf("%s brought something from outside into the root: %v", what, entries)
				}
			}
		}
	}
}

// The destination folder of a move is swapped for a link to outside: the item must not land there.
func TestMoveIntoSwappedDestinationIsRefused(t *testing.T) {
	f := newRaceFixture(t)
	defer func() { afterResolve = func(string) {}; afterValidate = func(string) {} }()
	item := filepath.Join(f.root, "item.txt")
	for _, hook := range []string{"afterValidate", "afterResolve"} {
		f.reset()
		write(t, item, "item")
		swap := f.swapper(f.dir, f.outside, hook == "afterResolve")
		if hook == "afterValidate" {
			afterValidate = swap
		} else {
			afterResolve = swap
		}
		_, err := Execute(Request{Op: "move", Path: item, TargetPath: f.dir, AllowedRoots: []string{f.root}})
		afterValidate, afterResolve = func(string) {}, func(string) {}
		if err == nil {
			t.Fatalf("%s: move into a swapped destination must be refused", hook)
		}
		f.outsideIntact(hook + " move into swapped destination")
		if b, err := os.ReadFile(item); err != nil || string(b) != "item" {
			t.Fatalf("%s: the item was lost: %q %v", hook, b, err)
		}
	}
}

// Deleting the folder itself after it became a link deletes the link only.
func TestDeleteOfFolderSwappedForLinkDeletesOnlyTheLink(t *testing.T) {
	f := newRaceFixture(t)
	defer func() { afterValidate = func(string) {} }()
	f.reset()
	afterValidate = f.swapper(f.dir, f.outside, false)
	_, err := Execute(Request{Op: "delete", Path: f.dir, ConfirmDestructive: true, AllowedRoots: []string{f.root}})
	afterValidate = func(string) {}
	f.outsideIntact("delete of a swapped folder")
	if err == nil {
		if _, serr := os.Lstat(f.dir); !errors.Is(serr, fs.ErrNotExist) {
			t.Fatalf("delete reported success but the link is still there: %v", serr)
		}
	}
}

// A recursive delete: a subfolder is swapped for a link to outside while the tree is being deleted
// (removeEntryHook runs at the most dangerous point on each platform). Nothing outside is touched.
func TestRecursiveDeleteNeverFollowsALinkSwappedInMidway(t *testing.T) {
	f := newRaceFixture(t)
	defer func() { removeEntryHook = func(string) {} }()
	f.reset()
	sub := filepath.Join(f.dir, "sub")
	swap := f.swapper(sub, filepath.Join(f.outside, "sub"), false)
	fired := false
	removeEntryHook = func(name string) {
		if name == "sub" {
			fired = true
			swap(sub)
		}
	}
	_, err := Execute(Request{Op: "delete", Path: f.dir, ConfirmDestructive: true, AllowedRoots: []string{f.root}})
	removeEntryHook = func(string) {}
	if !fired {
		t.Fatal("the recursive delete did not go through the handle walk (hook never ran)")
	}
	f.outsideIntact("recursive delete with a swapped subfolder")
	// The link put in the folder's place is deleted itself, so the whole tree goes.
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, serr := os.Lstat(f.dir); !errors.Is(serr, fs.ErrNotExist) {
		t.Fatalf("delete reported success but the folder is still there: %v", serr)
	}
}

// A link that already sits inside a deleted tree is deleted itself; what it points at stays.
func TestRecursiveDeleteRemovesLinksNotTheirTargets(t *testing.T) {
	f := newRaceFixture(t)
	f.reset()
	linkDir(t, f.outside, filepath.Join(f.dir, "sub", "to-outside"))
	ro := filepath.Join(f.dir, "sub", "readonly.txt")
	write(t, ro, "ro")
	if err := os.Chmod(ro, 0o444); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(Request{Op: "delete", Path: f.dir, ConfirmDestructive: true, AllowedRoots: []string{f.root}}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Lstat(f.dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("folder still there: %v", err)
	}
	f.outsideIntact("delete of a tree holding a link")
	// Deleting something already gone is not an error (like os.RemoveAll).
	if _, err := Execute(Request{Op: "delete", Path: f.dir, ConfirmDestructive: true, AllowedRoots: []string{f.root}}); err != nil {
		t.Fatalf("delete of a missing folder: %v", err)
	}
}

func TestHandleOpsNormalBehaviour(t *testing.T) {
	f := newRaceFixture(t)
	f.reset()
	roots := []string{f.root}
	run := func(r Request) Response {
		t.Helper()
		r.AllowedRoots = roots
		res, err := Execute(r)
		if err != nil {
			t.Fatalf("%s %s: %v", r.Op, r.Path, err)
		}
		return res
	}
	mustFail := func(r Request, want string) {
		t.Helper()
		r.AllowedRoots = roots
		if _, err := Execute(r); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s %s: want an error with %q, got %v", r.Op, r.Path, want, err)
		}
	}

	// mkdir: nested, again (no error), over a file (error).
	nested := filepath.Join(f.root, "x", "y", "z")
	run(Request{Op: "mkdir", Path: nested})
	run(Request{Op: "mkdir", Path: nested})
	if st, err := os.Stat(nested); err != nil || !st.IsDir() {
		t.Fatalf("mkdir did not create %s: %v", nested, err)
	}
	if _, err := Execute(Request{Op: "mkdir", Path: filepath.Join(f.dir, "secret.txt"), AllowedRoots: roots}); err == nil {
		t.Fatal("mkdir over a file must fail")
	}

	// rename: file and folder; never onto an existing name, never with a stream or separator.
	run(Request{Op: "rename", Path: filepath.Join(f.dir, "secret.txt"), NewName: "renamed.txt"})
	run(Request{Op: "rename", Path: filepath.Join(f.dir, "sub"), NewName: "sub2"})
	write(t, filepath.Join(f.dir, "other.txt"), "other")
	mustFail(Request{Op: "rename", Path: filepath.Join(f.dir, "other.txt"), NewName: "renamed.txt"}, "already exists")
	if b, _ := os.ReadFile(filepath.Join(f.dir, "renamed.txt")); string(b) != "inside" {
		t.Fatalf("rename replaced an existing file: %q", b)
	}
	if runtime.GOOS == "windows" {
		mustFail(Request{Op: "rename", Path: filepath.Join(f.dir, "other.txt"), NewName: "x.txt:stream"}, "invalid")
	}
	// The no-replace guarantee holds in the handle call itself, not only in the earlier check.
	if err := renameChecked(filepath.Join(f.dir, "other.txt"), "renamed.txt", guard{roots, true}); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("handle rename onto an existing name: want ErrExist, got %v", err)
	}

	// move: file and folder into another folder; never onto an existing name or into itself.
	dest := filepath.Join(f.root, "dest")
	run(Request{Op: "move", Paths: []string{filepath.Join(f.dir, "renamed.txt"), filepath.Join(f.dir, "sub2")}, TargetPath: dest})
	if b, _ := os.ReadFile(filepath.Join(dest, "sub2", "inner.txt")); string(b) != "inside inner" {
		t.Fatalf("move lost the folder content: %q", b)
	}
	write(t, filepath.Join(f.dir, "renamed.txt"), "second")
	mustFail(Request{Op: "move", Path: filepath.Join(f.dir, "renamed.txt"), TargetPath: dest}, "already exists")
	if err := moveChecked(filepath.Join(f.dir, "renamed.txt"), filepath.Join(dest, "renamed.txt"), roots); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("handle move onto an existing name: want ErrExist, got %v", err)
	}
	mustFail(Request{Op: "move", Path: dest, TargetPath: filepath.Join(dest, "sub2")}, "into itself")

	// list and search through handles.
	res := run(Request{Op: "list", Path: dest})
	if len(res.Entries) != 2 || !res.Entries[0].IsDir || res.Entries[0].Name != "sub2" || res.Entries[1].Name != "renamed.txt" || res.Entries[1].Size != int64(len("inside")) {
		t.Fatalf("list: %+v", res.Entries)
	}
	res = run(Request{Op: "search", Path: f.root, Query: "inner"})
	if len(res.Entries) != 1 || res.Entries[0].Path != filepath.Join(dest, "sub2", "inner.txt") {
		t.Fatalf("search: %+v", res.Entries)
	}

	// copy a folder (listed and created through handles).
	run(Request{Op: "copy", Path: filepath.Join(dest, "sub2"), TargetPath: f.dir})
	if b, _ := os.ReadFile(filepath.Join(f.dir, "sub2", "inner.txt")); string(b) != "inside inner" {
		t.Fatalf("copy: %q", b)
	}

	// delete a file and a folder tree.
	run(Request{Op: "delete", Paths: []string{filepath.Join(dest, "renamed.txt"), filepath.Join(dest, "sub2")}, ConfirmDestructive: true})
	if entries, _ := os.ReadDir(dest); len(entries) != 0 {
		t.Fatalf("delete left %v", entries)
	}

	// Outside the allowed roots and protected locations stay refused.
	mustFail(Request{Op: "mkdir", Path: filepath.Join(f.outside, "nope")}, "outside the allowed")
	mustFail(Request{Op: "delete", Path: filepath.Join(f.outside, "secret.txt"), ConfirmDestructive: true}, "outside the allowed")
	f.outsideIntact("normal operations")
}
