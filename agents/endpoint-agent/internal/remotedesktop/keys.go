package remotedesktop

import (
	"errors"
	"strings"
)

// Keyboard by position (Fleet Pro keyboard layout mapping). The viewer sends the physical key the
// operator pressed (KeyboardEvent.code, e.g. "KeyQ"), not the character, and the agent presses the
// same physical key here (a PS/2 set-1 scan code on Windows). The remote computer's own layout then
// decides the character, so an operator with a French keyboard typing into an Arabic or German
// remote session gets what that layout produces, like a local keyboard would. The other mode, by
// character, sends text (Unicode) and needs no mapping.

// PhysicalKey is one key of a standard 104/105-key keyboard.
type PhysicalKey struct {
	Scan     uint16 // set-1 make code
	Extended bool   // E0 prefix
	X11      string // xdotool keysym name
}

// physicalKeys maps KeyboardEvent.code values (W3C UI Events KeyboardEvent code values).
var physicalKeys = map[string]PhysicalKey{
	"Escape": {0x01, false, "Escape"}, "Digit1": {0x02, false, "1"}, "Digit2": {0x03, false, "2"}, "Digit3": {0x04, false, "3"},
	"Digit4": {0x05, false, "4"}, "Digit5": {0x06, false, "5"}, "Digit6": {0x07, false, "6"}, "Digit7": {0x08, false, "7"},
	"Digit8": {0x09, false, "8"}, "Digit9": {0x0A, false, "9"}, "Digit0": {0x0B, false, "0"}, "Minus": {0x0C, false, "minus"},
	"Equal": {0x0D, false, "equal"}, "Backspace": {0x0E, false, "BackSpace"}, "Tab": {0x0F, false, "Tab"},
	"KeyQ": {0x10, false, "q"}, "KeyW": {0x11, false, "w"}, "KeyE": {0x12, false, "e"}, "KeyR": {0x13, false, "r"},
	"KeyT": {0x14, false, "t"}, "KeyY": {0x15, false, "y"}, "KeyU": {0x16, false, "u"}, "KeyI": {0x17, false, "i"},
	"KeyO": {0x18, false, "o"}, "KeyP": {0x19, false, "p"}, "BracketLeft": {0x1A, false, "bracketleft"},
	"BracketRight": {0x1B, false, "bracketright"}, "Enter": {0x1C, false, "Return"}, "ControlLeft": {0x1D, false, "Control_L"},
	"KeyA": {0x1E, false, "a"}, "KeyS": {0x1F, false, "s"}, "KeyD": {0x20, false, "d"}, "KeyF": {0x21, false, "f"},
	"KeyG": {0x22, false, "g"}, "KeyH": {0x23, false, "h"}, "KeyJ": {0x24, false, "j"}, "KeyK": {0x25, false, "k"},
	"KeyL": {0x26, false, "l"}, "Semicolon": {0x27, false, "semicolon"}, "Quote": {0x28, false, "apostrophe"},
	"Backquote": {0x29, false, "grave"}, "ShiftLeft": {0x2A, false, "Shift_L"}, "Backslash": {0x2B, false, "backslash"},
	"KeyZ": {0x2C, false, "z"}, "KeyX": {0x2D, false, "x"}, "KeyC": {0x2E, false, "c"}, "KeyV": {0x2F, false, "v"},
	"KeyB": {0x30, false, "b"}, "KeyN": {0x31, false, "n"}, "KeyM": {0x32, false, "m"}, "Comma": {0x33, false, "comma"},
	"Period": {0x34, false, "period"}, "Slash": {0x35, false, "slash"}, "ShiftRight": {0x36, false, "Shift_R"},
	"NumpadMultiply": {0x37, false, "KP_Multiply"}, "AltLeft": {0x38, false, "Alt_L"}, "Space": {0x39, false, "space"},
	"CapsLock": {0x3A, false, "Caps_Lock"}, "F1": {0x3B, false, "F1"}, "F2": {0x3C, false, "F2"}, "F3": {0x3D, false, "F3"},
	"F4": {0x3E, false, "F4"}, "F5": {0x3F, false, "F5"}, "F6": {0x40, false, "F6"}, "F7": {0x41, false, "F7"},
	"F8": {0x42, false, "F8"}, "F9": {0x43, false, "F9"}, "F10": {0x44, false, "F10"}, "NumLock": {0x45, false, "Num_Lock"},
	"ScrollLock": {0x46, false, "Scroll_Lock"}, "Numpad7": {0x47, false, "KP_7"}, "Numpad8": {0x48, false, "KP_8"},
	"Numpad9": {0x49, false, "KP_9"}, "NumpadSubtract": {0x4A, false, "KP_Subtract"}, "Numpad4": {0x4B, false, "KP_4"},
	"Numpad5": {0x4C, false, "KP_5"}, "Numpad6": {0x4D, false, "KP_6"}, "NumpadAdd": {0x4E, false, "KP_Add"},
	"Numpad1": {0x4F, false, "KP_1"}, "Numpad2": {0x50, false, "KP_2"}, "Numpad3": {0x51, false, "KP_3"},
	"Numpad0": {0x52, false, "KP_0"}, "NumpadDecimal": {0x53, false, "KP_Decimal"}, "IntlBackslash": {0x56, false, "less"},
	"F11": {0x57, false, "F11"}, "F12": {0x58, false, "F12"}, "IntlRo": {0x73, false, "backslash"},
	"NumpadEnter": {0x1C, true, "KP_Enter"}, "ControlRight": {0x1D, true, "Control_R"}, "NumpadDivide": {0x35, true, "KP_Divide"},
	"PrintScreen": {0x37, true, "Print"}, "AltRight": {0x38, true, "ISO_Level3_Shift"}, "Home": {0x47, true, "Home"},
	"ArrowUp": {0x48, true, "Up"}, "PageUp": {0x49, true, "Prior"}, "ArrowLeft": {0x4B, true, "Left"},
	"ArrowRight": {0x4D, true, "Right"}, "End": {0x4F, true, "End"}, "ArrowDown": {0x50, true, "Down"},
	"PageDown": {0x51, true, "Next"}, "Insert": {0x52, true, "Insert"}, "Delete": {0x53, true, "Delete"},
	"MetaLeft": {0x5B, true, "Super_L"}, "MetaRight": {0x5C, true, "Super_R"}, "ContextMenu": {0x5D, true, "Menu"},
	"Pause": {0x45, false, "Pause"},
}

// LookupCode returns the physical key of a KeyboardEvent.code value.
func LookupCode(code string) (PhysicalKey, bool) {
	k, ok := physicalKeys[code]
	return k, ok
}

// comboNames are the names a key_combo may use (toolbar shortcuts the browser cannot capture:
// Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4, Win+R, PrintScreen…). Letters, digits and F-keys
// are accepted as themselves.
var comboNames = map[string]string{
	"ctrl": "ControlLeft", "control": "ControlLeft", "alt": "AltLeft", "shift": "ShiftLeft", "meta": "MetaLeft",
	"win": "MetaLeft", "super": "MetaLeft", "tab": "Tab", "esc": "Escape", "escape": "Escape", "delete": "Delete",
	"del": "Delete", "enter": "Enter", "space": "Space", "printscreen": "PrintScreen", "backspace": "Backspace",
	"home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown", "insert": "Insert", "contextmenu": "ContextMenu",
	"up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
}

// MaxComboKeys bounds a key_combo.
const MaxComboKeys = 4

// ErrSecureSequence: Ctrl+Alt+Del is never synthesised as key presses (Windows ignores them); the
// operator uses the Ctrl+Alt+Del button, which asks the service for the Secure Attention Sequence.
var ErrSecureSequence = errors.New("Ctrl+Alt+Del cannot be sent as key presses: use the Ctrl+Alt+Del button (Secure Attention Sequence)")

// ComboCodes resolves key_combo names to physical keys, in press order.
func ComboCodes(keys []string) ([]string, error) {
	if len(keys) == 0 || len(keys) > MaxComboKeys {
		return nil, errors.New("a key combination has 1 to 4 keys")
	}
	var out []string
	var ctrl, alt, del bool
	for _, k := range keys {
		n := strings.ToLower(strings.TrimSpace(k))
		code, ok := comboNames[n]
		switch {
		case ok:
		case len(n) == 1 && n[0] >= 'a' && n[0] <= 'z':
			code = "Key" + strings.ToUpper(n)
		case len(n) == 1 && n[0] >= '0' && n[0] <= '9':
			code = "Digit" + n
		case len(n) >= 2 && n[0] == 'f' && physicalKeys[strings.ToUpper(n)].Scan != 0:
			code = strings.ToUpper(n)
		default:
			return nil, errors.New("unknown key in combination: " + k)
		}
		ctrl = ctrl || code == "ControlLeft"
		alt = alt || code == "AltLeft"
		del = del || code == "Delete"
		out = append(out, code)
	}
	if ctrl && alt && del {
		return nil, ErrSecureSequence
	}
	return out, nil
}
