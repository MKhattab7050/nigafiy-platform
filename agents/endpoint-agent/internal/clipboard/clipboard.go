// Package clipboard reads and writes the text clipboard of the interactive desktop, for the
// operator-initiated clipboard sync of a remote support session. Text only, size-limited; the
// content never leaves memory (it is never logged or stored).
package clipboard

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// MaxChars is the largest text either direction carries (the API enforces the same limit).
const MaxChars = 16_000

var (
	ErrTooLong = errors.New("the clipboard text is longer than 16000 characters")
	ErrNoText  = errors.New("the clipboard holds no text")
)

// Check validates text before it is written to the clipboard.
func Check(text string) error {
	if !utf8.ValidString(text) {
		return errors.New("clipboard text is not valid UTF-8")
	}
	if utf8.RuneCountInString(text) > MaxChars {
		return ErrTooLong
	}
	if strings.ContainsRune(text, 0) {
		return errors.New("clipboard text contains a NUL character")
	}
	return nil
}

// ReadText returns the clipboard's text.
func ReadText() (string, error) {
	s, err := readText()
	if err != nil {
		return "", err
	}
	if utf8.RuneCountInString(s) > MaxChars {
		return "", ErrTooLong
	}
	return s, nil
}

// WriteText replaces the clipboard's content with text.
func WriteText(text string) error {
	if err := Check(text); err != nil {
		return err
	}
	return writeText(text)
}
