//go:build linux || darwin || freebsd || openbsd || netbsd

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// openTerminal opens the controlling terminal (/dev/tty), never redirected standard input, so the
// password can only be typed by a person at this terminal.
func openTerminal() (*terminal, error) {
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, errors.New("no controlling terminal: run router-probe interactively")
	}
	fd := int(f.Fd())
	if _, err := unix.IoctlGetTermios(fd, ioctlGetTermios); err != nil {
		f.Close()
		return nil, errors.New("not a terminal: run router-probe interactively")
	}
	t := &terminal{in: f, out: f}
	t.noEcho = func() (func(), error) {
		old, err := unix.IoctlGetTermios(fd, ioctlGetTermios)
		if err != nil {
			return nil, err
		}
		n := *old
		n.Lflag &^= unix.ECHO
		n.Lflag |= unix.ICANON | unix.ISIG
		if err := unix.IoctlSetTermios(fd, ioctlSetTermios, &n); err != nil {
			return nil, err
		}
		return func() { _ = unix.IoctlSetTermios(fd, ioctlSetTermios, old) }, nil
	}
	return t, nil
}
