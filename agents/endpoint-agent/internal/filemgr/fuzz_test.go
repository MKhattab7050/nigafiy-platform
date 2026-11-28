package filemgr

import (
	"path/filepath"
	"strings"
	"testing"
)

// Whatever path the operator sends, ValidateAndCleanPath never panics, and a path it accepts is
// the allowed folder itself or inside it.
func FuzzValidateAndCleanPath(f *testing.F) {
	root := f.TempDir()
	for _, s := range []string{root, filepath.Join(root, "a"), filepath.Join(root, "..", "x"), root + "\x00", `\?\` + root, root + `\..\..`, "C:..", "/", `\server\share`, root + "/./a/../../b", strings.ToUpper(root) + `\A`} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, p string) {
		clean, err := ValidateAndCleanPath(p, []string{root}, false)
		if err != nil {
			return
		}
		rel, rerr := filepath.Rel(root, clean)
		if rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			t.Fatalf("accepted %q -> %q outside %q", p, clean, root)
		}
	})
}
