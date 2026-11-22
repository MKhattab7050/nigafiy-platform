package remotedesktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// macOS mouse and keyboard, without cgo: one osascript (JavaScript for Automation) run per event,
// calling CoreGraphics through the ObjC bridge (CGEventCreateMouseEvent / CGEventCreateKeyboardEvent
// / CGEventKeyboardSetUnicodeString / CGEventCreateScrollWheelEvent2, posted with CGEventPost).
// macOS lets this through only when the agent holds the Accessibility permission, which the
// console shows (Info.Permissions); without it the events are dropped by the OS.
//
// The event goes to the script as one JSON argument; the script places normalised coordinates on
// the main display's bounds itself (CGDisplayBounds), in points.

// MacInputScript is the JXA program (argv[0] = the JSON of MacInputEvent).
const MacInputScript = `ObjC.import('CoreGraphics');
function post(e) { $.CGEventPost($.kCGHIDEventTap, e); }
function run(argv) {
  var a = JSON.parse(argv[0]);
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  var p = $.CGPointMake(b.origin.x + a.x * b.size.width, b.origin.y + a.y * b.size.height);
  var btn = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[a.button] || [1, 2, 0];
  function mouse(type) { return $.CGEventCreateMouseEvent(null, type, p, btn[2]); }
  function key(code, down, flags) { var e = $.CGEventCreateKeyboardEvent(null, code, down); $.CGEventSetFlags(e, flags); return e; }
  switch (a.kind) {
    case 'mouse_move': post(mouse(5)); break;
    case 'mouse_down': post(mouse(btn[0])); break;
    case 'mouse_up': post(mouse(btn[1])); break;
    case 'mouse_click':
      for (var i = 1; i <= (a.double ? 2 : 1); i++) {
        var d = mouse(btn[0]); $.CGEventSetIntegerValueField(d, 1, i); post(d);
        var u = mouse(btn[1]); $.CGEventSetIntegerValueField(u, 1, i); post(u);
      }
      break;
    case 'mouse_wheel': post(mouse(5)); post($.CGEventCreateScrollWheelEvent2(null, 1, 1, a.lines, 0, 0)); break;
    case 'key_press': post(key(a.code, true, a.flags)); post(key(a.code, false, a.flags)); break;
    case 'text':
      var chars = Array.from(a.text);
      for (var j = 0; j < chars.length; j++) {
        var c = chars[j];
        var kd = $.CGEventCreateKeyboardEvent(null, 0, true); $.CGEventKeyboardSetUnicodeString(kd, c.length, c); post(kd);
        var ku = $.CGEventCreateKeyboardEvent(null, 0, false); $.CGEventKeyboardSetUnicodeString(ku, c.length, c); post(ku);
      }
      break;
  }
  return 'ok';
}`

// MacInputEvent is what the script receives.
type MacInputEvent struct {
	Kind   string  `json:"kind"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button,omitempty"`
	Double bool    `json:"double,omitempty"`
	Lines  int     `json:"lines,omitempty"`
	Code   int     `json:"code,omitempty"`
	Flags  int     `json:"flags,omitempty"`
	Text   string  `json:"text,omitempty"`
}

// CGEventFlags masks.
const (
	macFlagShift   = 0x20000
	macFlagControl = 0x40000
	macFlagOption  = 0x80000
)

// macKeyCodes: virtual key codes (kVK_*; letter and symbol keys are the ANSI positions).
var macKeyCodes = map[string]int{
	"enter": 36, "return": 36, "tab": 48, "space": 49, " ": 49, "backspace": 51, "escape": 53, "esc": 53,
	"delete": 117, "del": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"arrowleft": 123, "left": 123, "arrowright": 124, "right": 124, "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
	"y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, `\`: 42, ",": 43, "/": 44,
	"n": 45, "m": 46, ".": 47, "`": 50,
}

// MacKeyCode maps the console's key names to a macOS virtual key code.
func MacKeyCode(k string) (int, bool) {
	k = strings.TrimSpace(k)
	if k != " " {
		k = strings.ToLower(k)
	}
	c, ok := macKeyCodes[k]
	return c, ok
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// MacInput builds the script's argument for one event. Only the main display is driven (the one
// screencapture shows).
func MacInput(ev InputEvent) (MacInputEvent, error) {
	m := MacInputEvent{Kind: ev.Kind, X: clamp01(ev.NormalizedX), Y: clamp01(ev.NormalizedY), Button: strings.ToLower(ev.Button), Double: ev.Double}
	if m.Button == "" {
		m.Button = "left"
	}
	switch ev.Kind {
	case "mouse_move", "mouse_down", "mouse_up", "mouse_click":
	case "mouse_wheel":
		// 120 per notch (the console sends wheel deltas the Windows way); positive scrolls up on both.
		m.Lines = ev.DeltaY / 120
		if m.Lines == 0 && ev.DeltaY != 0 {
			m.Lines = 1
			if ev.DeltaY < 0 {
				m.Lines = -1
			}
		}
	case "key_press":
		code, ok := MacKeyCode(ev.Key)
		if !ok {
			return m, fmt.Errorf("unsupported key: %s", ev.Key)
		}
		m.Code = code
		if ev.Ctrl {
			m.Flags |= macFlagControl
		}
		if ev.Alt {
			m.Flags |= macFlagOption
		}
		if ev.Shift {
			m.Flags |= macFlagShift
		}
	case "text":
		if ev.Text == "" {
			return m, errors.New("no text to type")
		}
		m.Text = ev.Text
	default:
		return m, fmt.Errorf("unknown input event kind: %s", ev.Kind)
	}
	return m, nil
}

// MacInputArg is the JSON argument for osascript.
func MacInputArg(ev InputEvent) (string, error) {
	m, err := MacInput(ev)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(m)
	return string(b), err
}
