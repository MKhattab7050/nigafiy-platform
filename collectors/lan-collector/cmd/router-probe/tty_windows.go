//go:build windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// openTerminal opens the console itself (CONIN$), never redirected standard input, so the
// password can only be typed by a person at this terminal.
func openTerminal() (*terminal, error) {
	in, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		return nil, errors.New("no interactive console: run router-probe in a terminal window")
	}
	var mode uint32
	if err := windows.GetConsoleMode(windows.Handle(in.Fd()), &mode); err != nil {
		in.Close()
		return nil, errors.New("standard console not available: run router-probe in a terminal window")
	}
	out, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		out = os.Stderr
	}
	t := &terminal{in: in, out: out}
	t.noEcho = func() (func(), error) {
		h := windows.Handle(in.Fd())
		var old uint32
		if err := windows.GetConsoleMode(h, &old); err != nil {
			return nil, err
		}
		if err := windows.SetConsoleMode(h, (old&^windows.ENABLE_ECHO_INPUT)|windows.ENABLE_LINE_INPUT|windows.ENABLE_PROCESSED_INPUT); err != nil {
			return nil, err
		}
		return func() { _ = windows.SetConsoleMode(h, old) }, nil
	}
	return t, nil
}
