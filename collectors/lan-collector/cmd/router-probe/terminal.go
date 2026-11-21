package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

// terminal is the interactive console. Passwords are read from it with echo off, byte by byte into
// a slice that is zeroed later; they never pass through a string.
type terminal struct {
	in     *os.File
	out    io.Writer
	noEcho func() (restore func(), err error)
}

const maxLine = 256

func (t *terminal) readLine() ([]byte, error) {
	buf := make([]byte, 0, 64)
	one := make([]byte, 1)
	for {
		n, err := t.in.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				break
			}
			if one[0] != '\r' {
				if len(buf) >= maxLine {
					router.Zero(buf)
					return nil, errors.New("input too long")
				}
				buf = append(buf, one[0])
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(buf) > 0 {
				break
			}
			router.Zero(buf)
			return nil, errors.New("input closed")
		}
	}
	one[0] = 0
	return buf, nil
}

// Secret prompts with echo off. The caller zeroes the result.
func (t *terminal) Secret(prompt string) ([]byte, error) {
	fmt.Fprint(t.out, prompt)
	restore, err := t.noEcho()
	if err != nil {
		return nil, errors.New("cannot turn off echo on this terminal; refusing to read a password")
	}
	b, err := t.readLine()
	restore()
	fmt.Fprintln(t.out)
	return b, err
}

// Line prompts with echo on (confirmations).
func (t *terminal) Line(prompt string) (string, error) {
	fmt.Fprint(t.out, prompt)
	b, err := t.readLine()
	return strings.TrimSpace(string(b)), err
}
