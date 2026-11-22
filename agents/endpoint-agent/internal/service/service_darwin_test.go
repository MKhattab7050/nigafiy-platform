//go:build darwin

package service

import (
	"slices"
	"strings"
	"testing"
)

func TestConsoleUserIsParsed(t *testing.T) {
	u, uid, err := consoleUser("alice 501\n")
	if err != nil || u != "alice" || uid != 501 {
		t.Fatalf("%q %d %v", u, uid, err)
	}
	for _, nobody := range []string{"root 0", "_mbsetupuser 248", "loginwindow 88", "", "x"} {
		if _, _, err := consoleUser(nobody); err == nil {
			t.Errorf("%q treated as a signed-in user", nobody)
		}
	}
}

func TestHelperRunsInTheUsersGUISession(t *testing.T) {
	a := asuserArgs("alice", 501, "/Applications/Nigafiy/endpoint-agent", HelperArgs())
	want := []string{"asuser", "501", "sudo", "-u", "alice", "--", "/Applications/Nigafiy/endpoint-agent", "session-helper"}
	if !slices.Equal(a, want) {
		t.Fatalf("%v", a)
	}
}

func TestLaunchdPlistEscapesArguments(t *testing.T) {
	p := Plist(Spec{Name: "com.nigafiy.endpoint-agent", Exe: "/opt/n/endpoint-agent", Args: []string{"run", "-server", "https://a&b<c>"}})
	if !strings.Contains(p, "<string>https://a&amp;b&lt;c&gt;</string>") || !strings.Contains(p, "<string>com.nigafiy.endpoint-agent</string>") {
		t.Fatalf("plist:\n%s", p)
	}
}
