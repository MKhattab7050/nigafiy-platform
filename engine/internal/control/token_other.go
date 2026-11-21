//go:build !windows

package control

import (
	"os"
	"strconv"
)

// restrictFile: owner-only permissions (the engine's user; root can read anything anyway).
func restrictFile(path, _ string) error { return os.Chmod(path, 0o600) }

// CurrentUserSID is the numeric user id outside Windows.
func CurrentUserSID() (string, error) { return strconv.Itoa(os.Getuid()), nil }
