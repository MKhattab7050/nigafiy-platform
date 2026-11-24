//go:build !windows

package patch

import (
	"os"
	"os/exec"
	"runtime"
)

// New returns the updater of this computer: apt or dnf on Linux, softwareupdate on macOS, or a
// scanner that reports "none" when neither is present.
func New() Scanner {
	root := os.Geteuid() == 0
	has := func(p string) bool { _, err := os.Stat(p); return err == nil }
	switch {
	case runtime.GOOS == "darwin":
		return &PackageScanner{Source: "softwareupdate", Root: root, Run: ExecRunner, FileHas: has}
	case lookPath("apt-get") && lookPath("apt"):
		return &PackageScanner{Source: "apt", Root: root, Run: ExecRunner, FileHas: has}
	case lookPath("dnf"):
		return &PackageScanner{Source: "dnf", Root: root, Run: ExecRunner, FileHas: has}
	}
	return &PackageScanner{Source: "none", Run: ExecRunner, FileHas: has}
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
