package control

// Desktop-session actions: on-screen notices, lock, sign-out and power. On Linux and macOS the agent
// runs as root outside the user's graphical session, so every user-facing action is started inside
// the logged-in user's session (loginctl + runuser on Linux, launchctl asuser + sudo -u on macOS) and
// the result says exactly which mechanism was used.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{1,16}$`)
	userNamePattern  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}\$?$`)
	uidPattern       = regexp.MustCompile(`^[0-9]{1,10}$`)
	x11DisplayRegex  = regexp.MustCompile(`^:[0-9]{1,4}(\.[0-9]{1,3})?$`)
)

// macOS CGSession (fast user switching to the login window = locked). Present up to macOS 10.15/11
// on most installs; later releases removed it.
const cgSessionPath = "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession"

// Delivery says how a notice reached the user.
type Delivery struct {
	Method   string   `json:"method"` // msg | notify-send | wall | osascript-notification | osascript-dialog
	Targets  []string `json:"targets,omitempty"`
	Fallback string   `json:"fallback_reason,omitempty"`
	Summary  string   `json:"summary"`
}

// DesktopSession is one logind session.
type DesktopSession struct {
	ID, User, UID, Type, Display, Class, State string
	Active, Remote                             bool
}

// ParseLoginctlSessionIDs reads `loginctl list-sessions --no-legend --no-pager` (first column).
func ParseLoginctlSessionIDs(out string) []string {
	var ids []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || !sessionIDPattern.MatchString(f[0]) {
			continue
		}
		ids = append(ids, f[0])
	}
	return ids
}

// ParseLoginctlShowSession reads `loginctl show-session ID -p …` (KEY=value lines).
func ParseLoginctlShowSession(out string) DesktopSession {
	var s DesktopSession
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "Id":
			s.ID = v
		case "Name":
			s.User = v
		case "User":
			s.UID = v
		case "Type":
			s.Type = v
		case "Display":
			s.Display = v
		case "Class":
			s.Class = v
		case "State":
			s.State = v
		case "Active":
			s.Active = v == "yes"
		case "Remote":
			s.Remote = v == "yes"
		}
	}
	return s
}

// Graphical reports whether this is a local user's graphical desktop session.
func (s DesktopSession) Graphical() bool {
	t := strings.ToLower(s.Type)
	return (t == "x11" || t == "wayland" || t == "mir") && (s.Class == "" || s.Class == "user") && s.State != "closing"
}

// linuxGraphicalSessions lists graphical sessions, the active ones first.
func (r Runner) linuxGraphicalSessions(ctx context.Context) ([]DesktopSession, error) {
	out, err := r.Exec(ctx, "loginctl", "list-sessions", "--no-legend", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("loginctl list-sessions failed: %s", firstNonEmpty(out, err.Error()))
	}
	var list []DesktopSession
	for _, id := range ParseLoginctlSessionIDs(out) {
		show, err := r.Exec(ctx, "loginctl", "show-session", id, "--no-pager",
			"-p", "Id", "-p", "Name", "-p", "User", "-p", "Type", "-p", "Display", "-p", "Class", "-p", "State", "-p", "Active", "-p", "Remote")
		if err != nil {
			continue
		}
		s := ParseLoginctlShowSession(show)
		if s.ID == "" {
			s.ID = id
		}
		if s.Graphical() && sessionIDPattern.MatchString(s.ID) {
			list = append(list, s)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Active && !list[j].Active })
	return list, nil
}

func describeSession(s DesktopSession) string {
	return fmt.Sprintf("%s (session %s, %s)", firstNonEmpty(s.User, "?"), s.ID, s.Type)
}

// activeOnly keeps the active sessions when there are any (a locked/inactive seat is still a target
// only when nothing else is active).
func activeOnly(list []DesktopSession) []DesktopSession {
	var act []DesktopSession
	for _, s := range list {
		if s.Active {
			act = append(act, s)
		}
	}
	if len(act) > 0 {
		return act
	}
	return list
}

// LinuxNotifyArgs builds the runuser command that shows a desktop notification in a user's session:
// runuser -u USER -- env [DISPLAY=:0] DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/UID/bus notify-send … -- TITLE BODY
func LinuxNotifyArgs(s DesktopSession, title, body string) ([]string, error) {
	if !userNamePattern.MatchString(s.User) || !uidPattern.MatchString(s.UID) {
		return nil, fmt.Errorf("session %s has no usable user name / uid", s.ID)
	}
	args := []string{"-u", s.User, "--", "env"}
	if x11DisplayRegex.MatchString(s.Display) {
		args = append(args, "DISPLAY="+s.Display)
	}
	args = append(args, "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"+s.UID+"/bus",
		"notify-send", "--urgency=critical", "--app-name=Nigafiy", "--", title, body)
	return args, nil
}

// AppleScriptString quotes s as an AppleScript string literal: backslashes and double quotes are
// escaped and control characters (which could end the statement) become spaces.
func AppleScriptString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '"':
			b.WriteString(`\"`)
		case r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029:
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

type consoleUser struct{ name, uid string }

// macConsoleUser finds the user logged in at the Mac's console (the GUI session).
func (r Runner) macConsoleUser(ctx context.Context) (consoleUser, error) {
	out, err := r.Exec(ctx, "stat", "-f", "%Su", "/dev/console")
	name := strings.TrimSpace(firstLine(out))
	if err != nil || name == "" {
		return consoleUser{}, fmt.Errorf("cannot read the console user: %s", firstNonEmpty(out, errString(err)))
	}
	if name == "root" || name == "loginwindow" || !userNamePattern.MatchString(name) {
		return consoleUser{}, errors.New("no user is logged in at the Mac's screen (login window is showing)")
	}
	idOut, err := r.Exec(ctx, "id", "-u", name)
	uid := strings.TrimSpace(firstLine(idOut))
	if err != nil || !uidPattern.MatchString(uid) {
		return consoleUser{}, fmt.Errorf("cannot read the uid of %s: %s", name, firstNonEmpty(idOut, errString(err)))
	}
	return consoleUser{name: name, uid: uid}, nil
}

// asMacUser runs a program inside the console user's GUI session.
func (r Runner) asMacUser(ctx context.Context, u consoleUser, name string, args ...string) (string, error) {
	full := append([]string{"asuser", u.uid, "sudo", "-u", u.name, name}, args...)
	return r.Exec(ctx, "launchctl", full...)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func noticeText(title, message string) (string, string) {
	title = strings.TrimSpace(title)
	message = strings.TrimSpace(message)
	if title == "" {
		title = "Message from IT"
	}
	if len(title) > 120 {
		title = title[:120]
	}
	if len(message) > 600 {
		message = message[:600]
	}
	return title, message
}

// notifyUser shows the administrator's notice on the endpoint's screen.
func (r Runner) notifyUser(ctx context.Context, rawTitle, rawMessage string) (Delivery, error) {
	title, message := noticeText(rawTitle, rawMessage)
	switch r.goos() {
	case "windows":
		full := strings.TrimSpace(title + ": " + message)
		if len(full) > 500 {
			full = full[:500]
		}
		out, err := r.Exec(ctx, "msg", "*", "/TIME:60", full)
		if err != nil {
			return Delivery{}, errors.New(firstNonEmpty(out, err.Error()))
		}
		return Delivery{Method: "msg", Targets: []string{"all sessions"}, Summary: "Message shown in every user session (msg *)"}, nil

	case "darwin":
		u, err := r.macConsoleUser(ctx)
		if err != nil {
			return Delivery{}, err
		}
		script := "display notification " + AppleScriptString(message) + " with title " + AppleScriptString(title) + ` subtitle "Nigafiy"`
		out, err := r.asMacUser(ctx, u, "osascript", "-e", script)
		if err == nil {
			return Delivery{Method: "osascript-notification", Targets: []string{u.name},
				Summary: "Notification Center banner sent to " + u.name + " (osascript display notification; hidden if the user turned notifications off or Focus is on)"}, nil
		}
		reason := firstNonEmpty(out, err.Error())
		dialog := "display dialog " + AppleScriptString(message) + " with title " + AppleScriptString(title) + ` buttons {"OK"} default button 1 giving up after 20`
		out, err = r.asMacUser(ctx, u, "osascript", "-e", dialog)
		if err != nil {
			return Delivery{}, fmt.Errorf("osascript notification failed (%s) and the dialog failed too: %s", reason, firstNonEmpty(out, err.Error()))
		}
		return Delivery{Method: "osascript-dialog", Targets: []string{u.name}, Fallback: reason,
			Summary: "Dialog shown to " + u.name + " (osascript display dialog, closes after 20 s); the notification banner failed: " + reason}, nil

	default:
		var fallback string
		sessions, err := r.linuxGraphicalSessions(ctx)
		switch {
		case err != nil:
			fallback = err.Error()
		case len(sessions) == 0:
			fallback = "no graphical desktop session is logged in"
		case !r.has("notify-send"):
			fallback = "notify-send is not installed (libnotify-bin / libnotify)"
		case !r.has("runuser"):
			fallback = "runuser is not available to reach the user's session"
		}
		if fallback == "" {
			var shown, failed []string
			for _, s := range activeOnly(sessions) {
				args, aerr := LinuxNotifyArgs(s, title, message)
				if aerr != nil {
					failed = append(failed, aerr.Error())
					continue
				}
				if out, rerr := r.Exec(ctx, "runuser", args...); rerr != nil {
					failed = append(failed, describeSession(s)+": "+firstNonEmpty(out, rerr.Error()))
					continue
				}
				shown = append(shown, describeSession(s))
			}
			if len(shown) > 0 {
				return Delivery{Method: "notify-send", Targets: shown, Summary: "Desktop notification shown with notify-send to " + strings.Join(shown, ", ")}, nil
			}
			fallback = "notify-send failed: " + strings.Join(failed, "; ")
		}
		// Two arguments: util-linux wall reads a single argument naming an existing file as the
		// message source, so the text is never passed alone.
		out, werr := r.Exec(ctx, "wall", "--", "[Nigafiy] "+title+":", message)
		if werr != nil {
			return Delivery{}, fmt.Errorf("no desktop notification (%s) and wall failed: %s", fallback, firstNonEmpty(out, werr.Error()))
		}
		return Delivery{Method: "wall", Targets: []string{"all terminals"}, Fallback: fallback,
			Summary: "Broadcast to logged-in terminals with wall (no desktop notification: " + fallback + ")"}, nil
	}
}

// powerAction locks, signs out, restarts or shuts down the machine and says how it was done.
func (r Runner) powerAction(ctx context.Context, action string) (string, error) {
	if r.Exec == nil {
		return "", errors.New("Execution disabled")
	}
	run := func(name string, args ...string) error {
		out, err := r.Exec(ctx, name, args...)
		if err != nil {
			return errors.New(firstNonEmpty(out, err.Error()))
		}
		return nil
	}
	goos := r.goos()
	switch action {
	case "restart":
		if goos == "windows" {
			return "Restart scheduled in 5 seconds (shutdown /r)", run("shutdown", "/r", "/t", "5", "/c", "Restart requested by IT administrator (Nigafiy)")
		}
		return "Restart scheduled in 1 minute (shutdown -r +1)", run("shutdown", "-r", "+1", "Restart requested by IT administrator")
	case "shutdown":
		if goos == "windows" {
			return "Shutdown scheduled in 5 seconds (shutdown /s)", run("shutdown", "/s", "/t", "5", "/c", "Shutdown requested by IT administrator (Nigafiy)")
		}
		return "Shutdown scheduled in 1 minute (shutdown -h +1)", run("shutdown", "-h", "+1", "Shutdown requested by IT administrator")
	}

	switch goos {
	case "windows":
		if action == "lock" {
			return "Workstation locked (LockWorkStation)", run("rundll32.exe", "user32.dll,LockWorkStation")
		}
		return "User signed out (shutdown /l)", run("shutdown", "/l")

	case "darwin":
		u, err := r.macConsoleUser(ctx)
		if err != nil {
			return "", err
		}
		if action == "lock" {
			if r.exists(cgSessionPath) {
				if _, err := r.asMacUser(ctx, u, cgSessionPath, "-suspend"); err == nil {
					return "Screen locked for " + u.name + " (CGSession -suspend: switched to the login window)", nil
				}
			}
			// Keystroke-free: start the screen saver. It locks only when the Mac requires the password
			// immediately after the screen saver starts (System Settings > Lock Screen).
			if out, err := r.asMacUser(ctx, u, "open", "-a", "ScreenSaverEngine"); err != nil {
				return "", fmt.Errorf("could not lock the screen: %s", firstNonEmpty(out, err.Error()))
			}
			return "Screen saver started for " + u.name + " (CGSession is not available on this macOS); the screen is locked only if \"Require password immediately\" is set", nil
		}
		if out, err := r.asMacUser(ctx, u, "osascript", "-e", `tell application "System Events" to log out`); err != nil {
			return "", fmt.Errorf("log out failed: %s", firstNonEmpty(out, err.Error()))
		}
		return "Log out requested for " + u.name + " via System Events (macOS asks the user to confirm and apps with unsaved work can cancel it)", nil

	default:
		sessions, err := r.linuxGraphicalSessions(ctx)
		if err != nil {
			return "", err
		}
		if len(sessions) == 0 {
			return "", errors.New("no graphical desktop session is logged in (loginctl)")
		}
		verb := "lock-session"
		if action == "logoff" {
			verb = "terminate-session"
		}
		var done, failed []string
		for _, s := range activeOnly(sessions) {
			if out, err := r.Exec(ctx, "loginctl", verb, s.ID); err != nil {
				failed = append(failed, describeSession(s)+": "+firstNonEmpty(out, err.Error()))
				continue
			}
			done = append(done, describeSession(s))
		}
		if len(done) == 0 {
			return "", fmt.Errorf("loginctl %s failed: %s", verb, strings.Join(failed, "; "))
		}
		if action == "lock" {
			return "Lock requested with loginctl lock-session for " + strings.Join(done, ", ") + " (the desktop environment performs the lock)", nil
		}
		return "Signed out with loginctl terminate-session: " + strings.Join(done, ", "), nil
	}
}
