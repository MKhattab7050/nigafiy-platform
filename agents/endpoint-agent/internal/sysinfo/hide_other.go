//go:build !windows

package sysinfo

import "os/exec"

func HideWindow(*exec.Cmd) {}

func hideWindow(*exec.Cmd) {}

