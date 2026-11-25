package remotedesktop

import (
	"errors"
	"math"
	"unicode/utf8"
)

// ValidateInput applies the API's rd_input rules (apps/api …/remote-desktop/schema.ts,
// rdInputCommandSchema) on the agent. The WebRTC data channel carries input straight from the
// operator's browser, so the agent checks what the API checks on the socket and HTTP paths.
func ValidateInput(ev InputEvent) error {
	switch ev.Kind {
	case "mouse_move", "mouse_click", "mouse_down", "mouse_up", "mouse_wheel", "key_press", "key_down", "key_up", "key_combo", "text":
	default:
		return errors.New("input event kind not allowed")
	}
	if ev.DisplayIndex < 0 || ev.DisplayIndex > 8 {
		return errors.New("display_index out of range")
	}
	for _, v := range []float64{ev.NormalizedX, ev.NormalizedY} {
		if math.IsNaN(v) || v < 0 || v > 1 {
			return errors.New("pointer position out of range")
		}
	}
	switch ev.Button {
	case "", "left", "right", "middle":
	default:
		return errors.New("button not allowed")
	}
	if ev.DeltaY < -2400 || ev.DeltaY > 2400 {
		return errors.New("wheel delta out of range")
	}
	if utf8.RuneCountInString(ev.Key) > 40 || utf8.RuneCountInString(ev.Text) > 240 {
		return errors.New("key or text too long")
	}
	if ev.Code != "" && !keyName(ev.Code) {
		return errors.New("key code not allowed")
	}
	if ev.Keys != nil {
		if len(ev.Keys) < 2 || len(ev.Keys) > 4 {
			return errors.New("a key combination has 2 to 4 keys")
		}
		for _, k := range ev.Keys {
			if !keyName(k) {
				return errors.New("key name not allowed")
			}
		}
	}
	if (ev.Kind == "key_down" || ev.Kind == "key_up") && ev.Code == "" {
		return errors.New("key_down and key_up need a code")
	}
	return nil
}

// keyName: ^[A-Za-z0-9]{1,24}$
func keyName(s string) bool {
	if len(s) < 1 || len(s) > 24 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
