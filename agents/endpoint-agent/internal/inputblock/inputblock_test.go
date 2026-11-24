package inputblock

import (
	"os"
	"runtime"
	"testing"
	"time"
)

func TestComboNeedsAllThreeModifiers(t *testing.T) {
	var c Combo
	if c.Key(VkE, true) {
		t.Fatal("E alone ended the session")
	}
	c.Key(VkLControl, true)
	c.Key(VkLMenu, true)
	if c.Key(VkE, true) {
		t.Fatal("Ctrl+Alt+E ended the session")
	}
	c.Key(VkRShift, true)
	if !c.Key(VkE, true) {
		t.Fatal("Ctrl+Alt+Shift+E did not end the session")
	}
	if c.Key(VkE, false) {
		t.Fatal("releasing E counted")
	}
	c.Key(VkRShift, false)
	if c.Key(VkE, true) {
		t.Fatal("released Shift still counted")
	}
}

func TestComboRightHandModifiers(t *testing.T) {
	var c Combo
	c.Key(VkRControl, true)
	c.Key(VkRMenu, true) // AltGr sends right Alt
	c.Key(VkLShift, true)
	if !c.Key(VkE, true) {
		t.Fatal("right-hand modifiers not recognised")
	}
}

// Installs the real hooks on this desktop for one second and removes them. Opt-in: while the hooks
// are installed the person at this computer cannot use the mouse or keyboard.
func TestRealHooksInstallAndRelease(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := Start(nil); err != ErrUnsupported {
			t.Fatalf("expected ErrUnsupported, got %v", err)
		}
		return
	}
	if os.Getenv("NIGAFIY_UI_TEST") != "1" {
		t.Skip("set NIGAFIY_UI_TEST=1 to block this desktop's input for one second")
	}
	b, err := Start(func() {})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Start(nil); err == nil {
		t.Fatal("a second block was allowed")
	}
	time.Sleep(time.Second)
	b.Stop()
	b.Stop()
	b2, err := Start(nil)
	if err != nil {
		t.Fatalf("blocking again after Stop: %v", err)
	}
	b2.Stop()
}
