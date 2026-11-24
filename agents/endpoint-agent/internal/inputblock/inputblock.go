// Package inputblock blocks the local user's physical mouse and keyboard while an operator works
// (Fleet Pro "block the local user's input", the block_input permission). Input the operator sends
// (injected by this agent) still goes through.
//
// It never records anything: the keyboard hook only looks at whether a key event was injected and
// whether it completes Ctrl+Alt+Shift+E, the combination that always ends the session (it works
// while input is blocked, so the person is never locked out). Ctrl+Alt+Del cannot be blocked by any
// program and also always works.
//
// Windows: WH_KEYBOARD_LL and WH_MOUSE_LL hooks on a dedicated thread (pure Go syscalls). Not
// BlockInput: that API needs an elevated process and would also swallow the end combination.
// Other platforms: not available (ErrUnsupported), refused honestly.
package inputblock

import "errors"

// ErrUnsupported: this platform cannot block local input from the agent.
var ErrUnsupported = errors.New("blocking the local user's input is supported on Windows only")

// Combo tracks the physical state of Ctrl, Alt and Shift to recognise Ctrl+Alt+Shift+E. Pure logic,
// shared by the hook and the tests.
type Combo struct {
	ctrl, alt, shift [2]bool
}

// Virtual-key codes the hook sees (left/right variants).
const (
	VkLShift   = 0xA0
	VkRShift   = 0xA1
	VkLControl = 0xA2
	VkRControl = 0xA3
	VkLMenu    = 0xA4
	VkRMenu    = 0xA5
	VkShift    = 0x10
	VkControl  = 0x11
	VkMenu     = 0x12
	VkE        = 0x45
)

// Key updates the state with one physical key event; it returns true when this event is the E of
// Ctrl+Alt+Shift+E (key down).
func (c *Combo) Key(vk uint32, down bool) bool {
	switch vk {
	case VkLControl, VkControl:
		c.ctrl[0] = down
	case VkRControl:
		c.ctrl[1] = down
	case VkLMenu, VkMenu:
		c.alt[0] = down
	case VkRMenu:
		c.alt[1] = down
	case VkLShift, VkShift:
		c.shift[0] = down
	case VkRShift:
		c.shift[1] = down
	case VkE:
		return down && (c.ctrl[0] || c.ctrl[1]) && (c.alt[0] || c.alt[1]) && (c.shift[0] || c.shift[1])
	}
	return false
}

// Blocker is one active block. Stop releases it (idempotent).
type Blocker interface {
	Stop()
}

// Start blocks physical input until Stop. onEndCombo runs (in its own goroutine) when the person
// presses Ctrl+Alt+Shift+E.
func Start(onEndCombo func()) (Blocker, error) { return start(onEndCombo) }
