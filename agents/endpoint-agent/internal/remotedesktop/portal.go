// godbus v5.1.0 builds on these; the Wayland code that uses this is Linux only, and the pure
// parts are tested on every platform with a working godbus.

//go:build linux || windows || darwin

package remotedesktop

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/godbus/dbus/v5"
)

// Wayland has no X11-style screen grab or input injection for ordinary programs: both go through
// xdg-desktop-portal, which asks the signed-in user first (GNOME and KDE show their own dialog).
//
//   - Frames: org.freedesktop.portal.Screenshot (non-interactive), one PNG per frame.
//   - Input:  org.freedesktop.portal.RemoteDesktop with a ScreenCast monitor source, so pointer
//     moves can be absolute (NotifyPointerMotionAbsolute on the session's stream).
//
// This file is the protocol's pure parts (keysyms, buttons, portal results); wayland_linux.go
// makes the D-Bus calls.

// Portal request response codes (org.freedesktop.portal.Request.Response).
func portalResponseError(code uint32) error {
	switch code {
	case 0:
		return nil
	case 1:
		return errors.New("the user declined the desktop portal's request")
	default:
		return fmt.Errorf("the desktop portal ended the request (response %d)", code)
	}
}

// fileURIPath turns the screenshot portal's file:// URI into a local path.
func fileURIPath(uri string) (string, error) {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" || u.Path == "" {
		return "", fmt.Errorf("the screenshot portal returned an unexpected location %q", uri)
	}
	if u.Host != "" && u.Host != "localhost" {
		return "", fmt.Errorf("the screenshot portal returned a remote location %q", uri)
	}
	return u.Path, nil
}

// portalStream is one stream of a started ScreenCast/RemoteDesktop session.
type portalStream struct {
	Node          uint32
	Width, Height int32
}

// parsePortalStreams reads Start's "streams" result: a(ua{sv}), each with a "size" (ii).
func parsePortalStreams(v dbus.Variant) ([]portalStream, error) {
	var raw [][]any
	if err := dbus.Store([]any{v.Value()}, &raw); err != nil {
		return nil, fmt.Errorf("unexpected streams from the portal: %v", err)
	}
	var out []portalStream
	for _, item := range raw {
		if len(item) != 2 {
			continue
		}
		node, ok := item[0].(uint32)
		if !ok {
			continue
		}
		props, _ := item[1].(map[string]dbus.Variant)
		s := portalStream{Node: node}
		if size, ok := props["size"]; ok {
			var wh []any
			if dbus.Store([]any{size.Value()}, &wh) == nil && len(wh) == 2 {
				s.Width, _ = wh[0].(int32)
				s.Height, _ = wh[1].(int32)
			}
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil, errors.New("the portal started the session without a screen stream")
	}
	return out, nil
}

// Linux evdev button codes (NotifyPointerButton).
const (
	btnLeft   = 0x110
	btnRight  = 0x111
	btnMiddle = 0x112
)

func evdevButton(b string) int32 {
	switch strings.ToLower(b) {
	case "right":
		return btnRight
	case "middle":
		return btnMiddle
	default:
		return btnLeft
	}
}

// X keysyms of the modifier keys.
const (
	keysymShiftL   = 0xffe1
	keysymControlL = 0xffe3
	keysymAltL     = 0xffe9
)

var namedKeysyms = map[string]int32{
	"enter": 0xff0d, "return": 0xff0d, "backspace": 0xff08, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b,
	"space": 0x20, " ": 0x20, "delete": 0xffff, "del": 0xffff, "home": 0xff50, "end": 0xff57,
	"pageup": 0xff55, "pagedown": 0xff56, "arrowleft": 0xff51, "left": 0xff51, "arrowup": 0xff52, "up": 0xff52,
	"arrowright": 0xff53, "right": 0xff53, "arrowdown": 0xff54, "down": 0xff54,
	"f1": 0xffbe, "f2": 0xffbf, "f3": 0xffc0, "f4": 0xffc1, "f5": 0xffc2, "f6": 0xffc3,
	"f7": 0xffc4, "f8": 0xffc5, "f9": 0xffc6, "f10": 0xffc7, "f11": 0xffc8, "f12": 0xffc9,
}

// runeKeysym: Latin-1 characters are their own keysym; every other character is 0x01000000 + its
// code point (the X11 Unicode keysym range).
func runeKeysym(r rune) (int32, bool) {
	switch {
	case r == '\n' || r == '\r':
		return 0xff0d, true
	case r == '\t':
		return 0xff09, true
	case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r > 0x10ffff:
		return 0, false
	case r <= 0xff:
		return int32(r), true
	default:
		return int32(0x01000000 | r), true
	}
}

// keyKeysym maps the console's key names (and single characters) to a keysym.
func keyKeysym(k string) (int32, bool) {
	if k != " " {
		k = strings.ToLower(strings.TrimSpace(k))
	}
	if ks, ok := namedKeysyms[k]; ok {
		return ks, true
	}
	if r := []rune(k); len(r) == 1 {
		return runeKeysym(r[0])
	}
	return 0, false
}

// wheelSteps: the console sends 120 per notch, positive = up; the portal's discrete axis steps
// are positive = down.
func wheelSteps(deltaY int) int32 {
	s := deltaY / 120
	if s == 0 && deltaY != 0 {
		s = 1
		if deltaY < 0 {
			s = -1
		}
	}
	return int32(-s)
}
