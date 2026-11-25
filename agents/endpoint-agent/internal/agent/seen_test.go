package agent

import (
	"fmt"
	"testing"
)

// EXT-4: filling the set never forgets a recent id; only the oldest ones go.
func TestSeenSetKeepsRecentIDs(t *testing.T) {
	s := newSeenSet(4)
	for i := 0; i < 4; i++ {
		if !s.add(fmt.Sprint(i)) {
			t.Fatalf("%d not new", i)
		}
	}
	if s.add("3") || s.add("0") {
		t.Fatal("a recent id was run twice")
	}
	// Past capacity: the oldest (0) goes, 1..4 stay.
	if !s.add("4") {
		t.Fatal("4 not new")
	}
	for _, id := range []string{"1", "2", "3", "4"} {
		if s.add(id) {
			t.Fatalf("recent id %s forgotten", id)
		}
	}
	if !s.add("0") {
		t.Fatal("the oldest id should have been forgotten")
	}
	if len(s.ids) != 4 {
		t.Fatalf("%d ids kept", len(s.ids))
	}
	// A long run: the last 4 are always remembered.
	big := newSeenSet(seenCommandsKept)
	for i := 0; i < 3*seenCommandsKept; i++ {
		big.add(fmt.Sprint("c", i))
	}
	for i := 3*seenCommandsKept - seenCommandsKept; i < 3*seenCommandsKept; i++ {
		if big.add(fmt.Sprint("c", i)) {
			t.Fatalf("recent id c%d forgotten", i)
		}
	}
}
