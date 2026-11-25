package quicksupport

import (
	"encoding/base64"
	"errors"
	"strings"
)

// LinkPrefix starts the link Fleet gives for the Microsoft Store version of Quick Support
// (docs/operations/microsoft-store.md). A Store package is the same signed file for everybody, so it
// cannot carry a trailer; it reads the same signed binding from the link it was opened with:
//
//	nigafiy-support:qs1/<base64url of the trailer JSON>
//
// The signature is checked exactly as for the trailer (ParseBinding), so a changed server breaks it.
const LinkPrefix = "nigafiy-support:qs1/"

// ErrNoLink: the Store version was started without a Fleet link (from the Start menu).
var ErrNoLink = errors.New("open Nigafiy Quick Support from the link your IT contact sends you (Fleet → Help requests → Quick Support → Microsoft Store link)")

// IsLink reports whether a command-line argument is a Quick Support link (any case of the scheme).
func IsLink(arg string) bool {
	return len(arg) >= len(LinkPrefix) && strings.EqualFold(arg[:len("nigafiy-support:")], "nigafiy-support:")
}

// ParseLink reads and verifies the binding in a link.
func ParseLink(link string) (Binding, error) {
	bad := errors.New("this Quick Support link is damaged or incomplete: ask your IT contact for a new one")
	link = strings.TrimSpace(link)
	if !IsLink(link) || !strings.EqualFold(link[:len(LinkPrefix)], LinkPrefix) {
		return Binding{}, bad
	}
	enc := strings.TrimRight(link[len(LinkPrefix):], "/")
	if enc == "" || len(enc) > 96<<10 {
		return Binding{}, bad
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(enc, "="))
	if err != nil {
		return Binding{}, bad
	}
	return ParseBinding(raw)
}

// FromArgs picks the binding: a link among the arguments wins; otherwise the trailer of the program
// file, which the Store package does not have (packaged = true gives ErrNoLink instead).
func FromArgs(args []string, exe string, packaged bool) (Binding, error) {
	for _, a := range args {
		if IsLink(a) {
			return ParseLink(a)
		}
	}
	if packaged {
		return Binding{}, ErrNoLink
	}
	return ReadBinding(exe)
}
