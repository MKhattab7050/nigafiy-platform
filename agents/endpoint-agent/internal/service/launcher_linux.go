//go:build linux

package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/lan-detective/endpoint-agent/internal/desktop"
)

// linuxSession is the active graphical session on seat0 (from loginctl).
type linuxSession struct {
	ID      string
	User    string
	UID     int
	Display string
	Type    string // x11, wayland, tty
	Class   string // user, greeter
}

func activeLinuxSession() (linuxSession, error) {
	out, err := exec.Command("loginctl", "show-seat", "seat0", "-p", "ActiveSession").Output()
	if err != nil {
		return linuxSession{}, fmt.Errorf("loginctl show-seat: %w", err)
	}
	id := parseKV(string(out))["ActiveSession"]
	if id == "" {
		return linuxSession{}, errors.New("no session is active on seat0")
	}
	out, err = exec.Command("loginctl", "show-session", id, "-p", "Name", "-p", "User", "-p", "Display", "-p", "Type", "-p", "Class").Output()
	if err != nil {
		return linuxSession{}, fmt.Errorf("loginctl show-session: %w", err)
	}
	return parseLinuxSession(id, string(out))
}

func parseLinuxSession(id, out string) (linuxSession, error) {
	kv := parseKV(out)
	uid, err := strconv.Atoi(kv["User"])
	if err != nil {
		return linuxSession{}, fmt.Errorf("session %s has no user", id)
	}
	s := linuxSession{ID: id, User: kv["Name"], UID: uid, Display: kv["Display"], Type: kv["Type"], Class: kv["Class"]}
	if s.Class != "user" || s.User == "" || s.UID == 0 {
		return linuxSession{}, errors.New("nobody is signed in to the graphical session (sign-in screen)")
	}
	if s.Type != "x11" && s.Type != "wayland" {
		return linuxSession{}, fmt.Errorf("the active session is not graphical (%s)", s.Type)
	}
	return s, nil
}

// helperEnv is the environment the helper needs to reach the user's display, D-Bus session bus
// (portals, notifications) and runtime directory. exists is os.Stat-like (tests pass a fake).
func helperEnv(s linuxSession, exists func(string) bool, glob func(string) []string) []string {
	run := "/run/user/" + strconv.Itoa(s.UID)
	env := []string{
		"HOME=" + homeOf(s.User),
		"USER=" + s.User,
		"LOGNAME=" + s.User,
		"XDG_RUNTIME_DIR=" + run,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=" + run + "/bus",
		"XDG_SESSION_TYPE=" + s.Type,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
	display := s.Display
	if display == "" && s.Type == "x11" {
		display = ":0"
	}
	if display != "" {
		env = append(env, "DISPLAY="+display)
	}
	if s.Type == "wayland" {
		if socks := glob(filepath.Join(run, "wayland-[0-9]*")); len(socks) > 0 {
			for _, sock := range socks {
				if filepath.Ext(sock) != ".lock" {
					env = append(env, "WAYLAND_DISPLAY="+filepath.Base(sock))
					break
				}
			}
		}
	}
	for _, xa := range []string{run + "/gdm/Xauthority", homeOf(s.User) + "/.Xauthority"} {
		if exists(xa) {
			env = append(env, "XAUTHORITY="+xa)
			break
		}
	}
	return env
}

func homeOf(user string) string {
	if user == "root" {
		return "/root"
	}
	return "/home/" + user
}

// runuserArgs: runuser -u USER -- env -i VARS... EXE ARGS...
func runuserArgs(s linuxSession, env []string, exe string, args []string) []string {
	a := []string{"-u", s.User, "--", "env", "-i"}
	a = append(a, env...)
	a = append(a, exe)
	return append(a, args...)
}

// RunuserLauncher (root): the helper runs as the active graphical session's user via runuser,
// with that session's DISPLAY / WAYLAND_DISPLAY / D-Bus address.
type RunuserLauncher struct {
	Exe  string
	Args []string
	Log  *slog.Logger

	mu      sync.Mutex
	session string
}

func (l *RunuserLauncher) Describe() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.session != "" {
		return "signed-in user's desktop (logind session " + l.session + ")"
	}
	return "signed-in user's desktop (logind)"
}

func (l *RunuserLauncher) Stale() bool {
	l.mu.Lock()
	launched := l.session
	l.mu.Unlock()
	if launched == "" {
		return false
	}
	s, err := activeLinuxSession()
	return err != nil || s.ID != launched
}

func (l *RunuserLauncher) Launch(ctx context.Context) (io.ReadWriteCloser, func(), error) {
	s, err := activeLinuxSession()
	if err != nil {
		return nil, nil, err
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	glob := func(p string) []string { m, _ := filepath.Glob(p); return m }
	env := helperEnv(s, exists, glob)
	rwc, stop, err := desktop.ExecLauncher{Path: "runuser", Args: runuserArgs(s, env, l.Exe, l.Args)}.Launch(ctx)
	if err != nil {
		return nil, nil, err
	}
	l.mu.Lock()
	l.session = s.ID
	l.mu.Unlock()
	return rwc, stop, nil
}

// HelperLauncher: as root (the systemd unit), the helper runs in the active graphical session as
// its user; as a normal user, it is a child process of the same user.
func HelperLauncher(exe string, log *slog.Logger) desktop.Launcher {
	if IsPrivileged() {
		return &RunuserLauncher{Exe: exe, Args: HelperArgs(), Log: log}
	}
	return desktop.ExecLauncher{Path: exe, Args: HelperArgs(), Desc: "child process of this user"}
}
