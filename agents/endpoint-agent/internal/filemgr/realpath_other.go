//go:build !windows

package filemgr

import "path/filepath"

func realPath(p string) (string, error) { return filepath.EvalSymlinks(p) }
