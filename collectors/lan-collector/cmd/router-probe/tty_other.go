//go:build !windows && !linux && !darwin && !freebsd && !openbsd && !netbsd

package main

import "errors"

func openTerminal() (*terminal, error) {
	return nil, errors.New("hidden password prompt is not supported on this platform")
}
