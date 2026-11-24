//go:build linux

package service

import (
	"slices"
	"strings"
	"testing"
)

func TestActiveLogindSessionIsParsed(t *testing.T) {
	s, err := parseLinuxSession("3", "Name=alice\nUser=1000\nDisplay=:1\nType=x11\nClass=user\n")
	if err != nil || s.User != "alice" || s.UID != 1000 || s.Display != ":1" || s.Type != "x11" {
		t.Fatalf("%+v %v", s, err)
	}
	if _, err := parseLinuxSession("1", "Name=gdm\nUser=120\nType=wayland\nClass=greeter\n"); err == nil {
		t.Fatal("the sign-in screen (greeter) is not a user session")
	}
	if _, err := parseLinuxSession("2", "Name=bob\nUser=1001\nType=tty\nClass=user\n"); err == nil {
		t.Fatal("a text console has no desktop")
	}
	if _, err := parseLinuxSession("4", "Name=root\nUser=0\nType=x11\nClass=user\n"); err == nil {
		t.Fatal("root's desktop is refused")
	}
}

func TestHelperEnvironmentReachesTheUsersDisplayAndBus(t *testing.T) {
	wl := linuxSession{ID: "5", User: "alice", UID: 1000, Type: "wayland", Class: "user"}
	env := helperEnv(wl, func(string) bool { return false }, func(string) []string {
		return []string{"/run/user/1000/wayland-0", "/run/user/1000/wayland-0.lock"}
	})
	for _, want := range []string{"XDG_RUNTIME_DIR=/run/user/1000", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "WAYLAND_DISPLAY=wayland-0", "XDG_SESSION_TYPE=wayland", "HOME=/home/alice"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %s in %v", want, env)
		}
	}
	x := linuxSession{ID: "6", User: "bob", UID: 1001, Type: "x11", Class: "user"}
	env = helperEnv(x, func(p string) bool { return p == "/run/user/1001/gdm/Xauthority" }, func(string) []string { return nil })
	if !slices.Contains(env, "DISPLAY=:0") || !slices.Contains(env, "XAUTHORITY=/run/user/1001/gdm/Xauthority") {
		t.Fatalf("x11 env %v", env)
	}
	args := runuserArgs(x, env, "/opt/nigafiy/endpoint-agent", HelperArgs())
	if args[0] != "-u" || args[1] != "bob" || args[3] != "env" || args[4] != "-i" || args[len(args)-1] != "session-helper" {
		t.Fatalf("runuser args %v", args)
	}
}

func TestSystemdUnitQuotesTheCommandLine(t *testing.T) {
	u := UnitFile(Spec{Name: "nigafiy-endpoint-agent", Exe: "/opt/nigafiy/endpoint-agent", Args: []string{"run", "-state-dir", "/var/lib/a b", "-tls-pin", "50%$x"}})
	if !strings.Contains(u, `ExecStart="/opt/nigafiy/endpoint-agent" "run" "-state-dir" "/var/lib/a b" "-tls-pin" "50%%$$x"`) {
		t.Fatalf("unit:\n%s", u)
	}
	if !strings.Contains(u, "Restart=on-failure") || !strings.Contains(u, "WantedBy=multi-user.target") {
		t.Fatalf("unit:\n%s", u)
	}
}

func TestExecStartBinaryReadsBackWhatUnitFileWrote(t *testing.T) {
	for _, exe := range []string{"/opt/nigafiy-agent/nigafiy-agent", `/opt/odd "dir"/100%/$x/nigafiy-agent`} {
		unit := UnitFile(Spec{Name: "nigafiy-endpoint-agent", Exe: exe, Args: []string{"run", "-server", "https://n.example"}})
		got, err := ExecStartBinary(unit)
		if err != nil || got != exe {
			t.Fatalf("%q: %q %v", exe, got, err)
		}
	}
	if _, err := ExecStartBinary("[Service]\nType=simple\n"); err == nil {
		t.Fatal("a unit without ExecStart was accepted")
	}
}
