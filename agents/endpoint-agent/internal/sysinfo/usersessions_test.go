package sysinfo

import (
	"runtime"
	"testing"
)

func TestSessionStateNamesMatchTheAPI(t *testing.T) {
	want := map[uint32]string{0: "active", 1: "connected", 4: "disconnected", 5: "idle", 6: "listen", 2: "other", 9: "other"}
	for in, out := range want {
		if got := sessionState(in); got != out {
			t.Fatalf("state %d: %s, want %s", in, got, out)
		}
	}
	if keepSession(0, "active") || keepSession(3, "listen") || !keepSession(1, "active") {
		t.Fatal("session 0 and listeners are not offered")
	}
}

// Reads this computer's sessions (read-only: WTSEnumerateSessions).
func TestUserSessionsOnThisComputer(t *testing.T) {
	list := UserSessions()
	if runtime.GOOS != "windows" {
		if list != nil {
			t.Fatal("non-Windows lists no sessions")
		}
		return
	}
	for _, s := range list {
		if s.ID == 0 || s.State == "listen" {
			t.Fatalf("unexpected session %+v", s)
		}
	}
	t.Logf("%d session(s)", len(list))
}
