package remotedesktop

import "testing"

func TestLookupCodeLayoutIndependent(t *testing.T) {
	q, ok := LookupCode("KeyQ")
	if !ok || q.Scan != 0x10 || q.Extended {
		t.Fatalf("KeyQ %+v", q)
	}
	up, _ := LookupCode("ArrowUp")
	if up.Scan != 0x48 || !up.Extended {
		t.Fatalf("ArrowUp %+v", up)
	}
	if _, ok := LookupCode("NotAKey"); ok {
		t.Fatal("unknown code accepted")
	}
}

func TestComboCodes(t *testing.T) {
	got, err := ComboCodes([]string{"Ctrl", "Shift", "Esc"})
	if err != nil || len(got) != 3 || got[0] != "ControlLeft" || got[2] != "Escape" {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := ComboCodes([]string{"Win", "r"}); err != nil || got[1] != "KeyR" {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := ComboCodes([]string{"Alt", "F4"}); err != nil || got[1] != "F4" {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := ComboCodes([]string{"Ctrl", "Alt", "Del"}); err != ErrSecureSequence {
		t.Fatalf("Ctrl+Alt+Del: %v", err)
	}
	if _, err := ComboCodes([]string{"Hyper"}); err == nil {
		t.Fatal("unknown key accepted")
	}
	if _, err := ComboCodes([]string{"a", "b", "c", "d", "e"}); err == nil {
		t.Fatal("five keys accepted")
	}
}
