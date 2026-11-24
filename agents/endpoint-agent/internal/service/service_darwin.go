//go:build darwin

package service

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
)

// DefaultName is the launchd label.
func DefaultName() string { return "com.nigafiy.endpoint-agent" }

// DefaultStateDir: /Library/Application Support/Nigafiy/EndpointAgent.
func DefaultStateDir() string { return "/Library/Application Support/Nigafiy/EndpointAgent" }

const logPath = "/Library/Logs/Nigafiy/endpoint-agent.log"

func plistPath(name string) string { return filepath.Join("/Library/LaunchDaemons", name+".plist") }

func xmlText(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// Plist is the launchd daemon definition for spec.
func Plist(spec Spec) string {
	var args strings.Builder
	for _, a := range append([]string{spec.Exe}, spec.Args...) {
		args.WriteString("\t\t<string>" + xmlText(a) + "</string>\n")
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
%s	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, xmlText(spec.Name), args.String(), logPath)
}

// Install writes the daemon's plist and loads it (when start is set; it loads at boot anyway).
func Install(spec Spec, start bool) error {
	if err := ValidName(spec.Name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	p := plistPath(spec.Name)
	if _, err := os.Stat(p); err == nil {
		return fmt.Errorf("%s already exists (uninstall first)", p)
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(Plist(spec)), 0o644); err != nil {
		return err
	}
	if start {
		return runTool("launchctl", "bootstrap", "system", p)
	}
	return nil
}

// Uninstall unloads the daemon and removes its plist.
func Uninstall(name string) error {
	if err := ValidName(name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	p := plistPath(name)
	if _, err := os.Stat(p); err != nil {
		return fmt.Errorf("no daemon %s is installed", p)
	}
	_ = runTool("launchctl", "bootout", "system/"+name)
	return os.Remove(p)
}

// consoleUser parses `stat -f "%Su %u" /dev/console`. The sign-in window owns the console as
// root (or _mbsetupuser during setup): nobody is signed in then.
func consoleUser(out string) (string, int, error) {
	f := strings.Fields(strings.TrimSpace(out))
	if len(f) != 2 {
		return "", 0, errors.New("cannot tell who is signed in at the console")
	}
	uid, err := strconv.Atoi(f[1])
	if err != nil {
		return "", 0, err
	}
	if uid == 0 || f[0] == "root" || f[0] == "loginwindow" || strings.HasPrefix(f[0], "_") {
		return "", 0, errors.New("nobody is signed in at the console (sign-in window)")
	}
	return f[0], uid, nil
}

func currentConsoleUser() (string, int, error) {
	out, err := exec.Command("stat", "-f", "%Su %u", "/dev/console").Output()
	if err != nil {
		return "", 0, err
	}
	return consoleUser(string(out))
}

// asuserArgs: launchctl asuser UID sudo -u USER -- EXE ARGS... (the helper runs in the user's
// GUI bootstrap namespace, so it can reach the WindowServer, and as the user).
func asuserArgs(user string, uid int, exe string, args []string) []string {
	a := []string{"asuser", strconv.Itoa(uid), "sudo", "-u", user, "--", exe}
	return append(a, args...)
}

// AsUserLauncher (root): the helper runs as the console user in their GUI session.
type AsUserLauncher struct {
	Exe  string
	Args []string
	Log  *slog.Logger

	mu  sync.Mutex
	uid int
}

func (l *AsUserLauncher) Describe() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.uid != 0 {
		return "console user's desktop (uid " + strconv.Itoa(l.uid) + ")"
	}
	return "console user's desktop"
}

func (l *AsUserLauncher) Stale() bool {
	l.mu.Lock()
	launched := l.uid
	l.mu.Unlock()
	if launched == 0 {
		return false
	}
	_, uid, err := currentConsoleUser()
	return err != nil || uid != launched
}

func (l *AsUserLauncher) Launch(ctx context.Context) (io.ReadWriteCloser, func(), error) {
	user, uid, err := currentConsoleUser()
	if err != nil {
		return nil, nil, err
	}
	rwc, stop, err := desktop.ExecLauncher{Path: "launchctl", Args: asuserArgs(user, uid, l.Exe, l.Args)}.Launch(ctx)
	if err != nil {
		return nil, nil, err
	}
	l.mu.Lock()
	l.uid = uid
	l.mu.Unlock()
	return rwc, stop, nil
}

// HelperLauncher: as root (the launchd daemon), the helper runs as the console user; as a normal
// user, it is a child process.
func HelperLauncher(exe string, log *slog.Logger) desktop.Launcher {
	if IsPrivileged() {
		return &AsUserLauncher{Exe: exe, Args: HelperArgs(), Log: log}
	}
	return desktop.ExecLauncher{Path: exe, Args: HelperArgs(), Desc: "child process of this user"}
}

// DefaultInstallDir: /Library/Nigafiy/EndpointAgent (install copies the agent there).
func DefaultInstallDir() string { return "/Library/Nigafiy/EndpointAgent" }

// Exists reports whether the daemon's plist is installed.
func Exists(name string) (bool, error) { return SystemController{}.Exists(name) }

// SystemController is launchd (Controller for the in-place upgrade).
type SystemController struct{}

func (SystemController) Exists(name string) (bool, error) {
	_, err := os.Stat(plistPath(name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// BinaryPath is the first ProgramArguments string of the plist (as Plist writes it).
func (SystemController) BinaryPath(name string) (string, error) {
	raw, err := os.ReadFile(plistPath(name))
	if err != nil {
		return "", err
	}
	return PlistBinary(string(raw))
}

// Stop unloads the daemon (bootout waits for it to exit); Start loads it again.
func (SystemController) Stop(name string, _ time.Duration) error {
	if ok, _ := (SystemController{}).Running(name); !ok {
		return nil
	}
	return runTool("launchctl", "bootout", "system/"+name)
}

func (SystemController) Start(name string) error {
	return runTool("launchctl", "bootstrap", "system", plistPath(name))
}

func (SystemController) Running(name string) (bool, error) {
	out, err := exec.Command("launchctl", "print", "system/"+name).Output()
	if err != nil {
		return false, nil // not loaded
	}
	return strings.Contains(string(out), "state = running"), nil
}

// PlistBinary reads the first string of ProgramArguments.
func PlistBinary(plist string) (string, error) {
	i := strings.Index(plist, "<key>ProgramArguments</key>")
	if i < 0 {
		return "", errors.New("the plist has no ProgramArguments")
	}
	rest := plist[i:]
	a := strings.Index(rest, "<string>")
	b := strings.Index(rest, "</string>")
	if a < 0 || b < a {
		return "", errors.New("the plist's ProgramArguments is empty")
	}
	var v string
	if err := xml.Unmarshal([]byte(rest[a:b+len("</string>")]), &v); err != nil {
		return "", err
	}
	return v, nil
}
