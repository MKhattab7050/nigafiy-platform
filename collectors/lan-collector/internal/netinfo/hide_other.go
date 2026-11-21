//go:build !windows

package netinfo

import "os/exec"

func hideWindow(*exec.Cmd) {}
