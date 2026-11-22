package remotedesktop

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMacInputEvents(t *testing.T) {
	m, err := MacInput(InputEvent{Kind: "key_press", Key: "c", Ctrl: true, Shift: true})
	if err != nil || m.Code != 8 || m.Flags != macFlagControl|macFlagShift {
		t.Fatalf("%+v %v", m, err)
	}
	m, _ = MacInput(InputEvent{Kind: "key_press", Key: "Enter", Alt: true})
	if m.Code != 36 || m.Flags != macFlagOption {
		t.Fatalf("%+v", m)
	}
	if _, err := MacInput(InputEvent{Kind: "key_press", Key: "NoSuchKey"}); err == nil {
		t.Fatal("unknown key accepted")
	}
	m, _ = MacInput(InputEvent{Kind: "mouse_click", NormalizedX: 1.5, NormalizedY: -1, Button: "Right", Double: true})
	if m.X != 1 || m.Y != 0 || m.Button != "right" || !m.Double {
		t.Fatalf("%+v", m)
	}
	m, _ = MacInput(InputEvent{Kind: "mouse_wheel", DeltaY: -360})
	if m.Lines != -3 {
		t.Fatalf("%+v", m)
	}
	m, _ = MacInput(InputEvent{Kind: "mouse_wheel", DeltaY: 40})
	if m.Lines != 1 {
		t.Fatalf("a small wheel delta still scrolls: %+v", m)
	}
	if _, err := MacInput(InputEvent{Kind: "text"}); err == nil {
		t.Fatal("empty text accepted")
	}
	if _, err := MacInput(InputEvent{Kind: "warp"}); err == nil {
		t.Fatal("unknown kind accepted")
	}
	arg, err := MacInputArg(InputEvent{Kind: "text", Text: "héllo \"x\""})
	if err != nil {
		t.Fatal(err)
	}
	var back MacInputEvent
	if json.Unmarshal([]byte(arg), &back) != nil || back.Text != "héllo \"x\"" || back.Kind != "text" {
		t.Fatalf("argument does not round-trip: %s", arg)
	}
	// The script handles every kind MacInput accepts.
	for _, k := range []string{"mouse_move", "mouse_down", "mouse_up", "mouse_click", "mouse_wheel", "key_press", "text"} {
		if !strings.Contains(MacInputScript, "case '"+k+"'") {
			t.Errorf("script has no case for %s", k)
		}
	}
}
