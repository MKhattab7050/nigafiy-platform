package sas

import (
	"errors"
	"testing"
)

func TestPolicyValues(t *testing.T) {
	for v, want := range map[uint32]bool{0: false, 1: true, 2: false, 3: true, 4: false} {
		if PolicyAllowsServices(v, true) != want {
			t.Fatalf("value %d", v)
		}
	}
	if PolicyAllowsServices(1, false) {
		t.Fatal("a missing value allowed it")
	}
}

func TestRefusedOutsideTheService(t *testing.T) {
	var r *Refusal
	if err := Send(false); !errors.As(err, &r) || r.Code != CodeNotService {
		t.Fatalf("got %v", err)
	}
}
