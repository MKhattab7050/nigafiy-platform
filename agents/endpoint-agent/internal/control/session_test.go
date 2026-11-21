package control

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// scripted is a fake Exec: it answers by command-line prefix and records every call.
type scripted struct {
	answers map[string]string
	fail    map[string]string
	calls   []string
}

func (s *scripted) exec(_ context.Context, name string, args ...string) (string, error) {
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	s.calls = append(s.calls, line)
	for prefix, out := range s.fail {
		if strings.HasPrefix(line, prefix) {
			return out, errors.New("exit status 1")
		}
	}
	for prefix, out := range s.answers {
		if strings.HasPrefix(line, prefix) {
			return out, nil
		}
	}
	return "", nil
}

func installed(names ...string) func(string) bool {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	return func(n string) bool { return set[n] }
}

const showGraphical = "Id=2\nName=alice\nUser=1000\nType=wayland\nDisplay=\nClass=user\nState=active\nActive=yes\nRemote=no\n"
const showX11 = "Id=5\nName=bob\nUser=1001\nType=x11\nDisplay=:1\nClass=user\nState=online\nActive=no\nRemote=no\n"
const showGreeter = "Id=c1\nName=gdm\nUser=120\nType=wayland\nDisplay=\nClass=greeter\nState=online\nActive=no\nRemote=no\n"
const showTTY = "Id=7\nName=root\nUser=0\nType=tty\nDisplay=\nClass=user\nState=online\nActive=no\nRemote=no\n"

func linuxSessions() map[string]string {
	return map[string]string{
		"loginctl list-sessions":    "     2 1000 alice seat0 tty2\n     5 1001 bob   seat0 tty3\n    c1  120 gdm   seat0 tty1\n     7    0 root        pts/0\n",
		"loginctl show-session 2 ":  showGraphical,
		"loginctl show-session 5 ":  showX11,
		"loginctl show-session c1 ": showGreeter,
		"loginctl show-session 7 ":  showTTY,
	}
}

func TestLoginctlParsers(t *testing.T) {
	ids := ParseLoginctlSessionIDs("     2 1000 alice seat0 tty2\n    c1  120 gdm   seat0 tty1\n\n")
	if strings.Join(ids, ",") != "2,c1" {
		t.Fatalf("ids: %v", ids)
	}
	s := ParseLoginctlShowSession(showX11)
	if s.ID != "5" || s.User != "bob" || s.UID != "1001" || s.Display != ":1" || s.Active || !s.Graphical() {
		t.Fatalf("show-session: %+v", s)
	}
	if ParseLoginctlShowSession(showGreeter).Graphical() || ParseLoginctlShowSession(showTTY).Graphical() {
		t.Fatal("greeter and tty sessions are not user desktops")
	}
}

func TestLinuxNotifyUsesNotifySendInTheActiveSession(t *testing.T) {
	s := &scripted{answers: linuxSessions()}
	r := Runner{Exec: s.exec, GOOS: "linux", LookPath: installed("notify-send", "runuser")}
	res := r.Execute(context.Background(), Command{ID: "n1", Kind: "notify_user", Payload: json.RawMessage(`{"title":"-IT","message":"Reboot at 5pm; \"save\" your work"}`)})
	if !res.OK {
		t.Fatalf("notify: %+v", res)
	}
	var d Delivery
	_ = json.Unmarshal(res.Data, &d)
	if d.Method != "notify-send" || len(d.Targets) != 1 || !strings.Contains(d.Targets[0], "alice") {
		t.Fatalf("delivery: %+v", d)
	}
	last := s.calls[len(s.calls)-1]
	want := `runuser -u alice -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus notify-send --urgency=critical --app-name=Nigafiy -- -IT Reboot at 5pm; "save" your work`
	if last != want {
		t.Fatalf("command:\n got %s\nwant %s", last, want)
	}
	args, err := LinuxNotifyArgs(ParseLoginctlShowSession(showX11), "T", "B")
	if err != nil || strings.Join(args, " ") != "-u bob -- env DISPLAY=:1 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus notify-send --urgency=critical --app-name=Nigafiy -- T B" {
		t.Fatalf("x11 args: %v %v", args, err)
	}
	if _, err := LinuxNotifyArgs(DesktopSession{ID: "9", User: "-rf", UID: "1"}, "T", "B"); err == nil {
		t.Fatal("a user name that looks like an option must be refused")
	}
}

func TestLinuxNotifyFallsBackToWallAndSaysWhy(t *testing.T) {
	s := &scripted{answers: linuxSessions()}
	r := Runner{Exec: s.exec, GOOS: "linux", LookPath: installed("runuser")}
	res := r.Execute(context.Background(), Command{ID: "n2", Kind: "notify_user", Payload: json.RawMessage(`{"title":"IT","message":"/etc/shadow"}`)})
	if !res.OK || !strings.Contains(res.Output, "wall") || !strings.Contains(res.Output, "notify-send is not installed") {
		t.Fatalf("fallback: %+v", res)
	}
	last := s.calls[len(s.calls)-1]
	// Never a single argument: wall would read an existing file named by it.
	if last != "wall -- [Nigafiy] IT: /etc/shadow" {
		t.Fatalf("wall command: %s", last)
	}
}

func TestMacNotifyRunsInTheConsoleUsersSession(t *testing.T) {
	s := &scripted{answers: map[string]string{"stat -f %Su /dev/console": "carol\n", "id -u carol": "501\n"}}
	r := Runner{Exec: s.exec, GOOS: "darwin"}
	res := r.Execute(context.Background(), Command{ID: "n3", Kind: "notify_user", Payload: json.RawMessage(`{"title":"IT \"desk\"","message":"line1\nline2 \\ end"}`)})
	if !res.OK {
		t.Fatalf("mac notify: %+v", res)
	}
	last := s.calls[len(s.calls)-1]
	want := `launchctl asuser 501 sudo -u carol osascript -e display notification "line1 line2 \\ end" with title "IT \"desk\"" subtitle "Nigafiy"`
	if last != want {
		t.Fatalf("osascript:\n got %s\nwant %s", last, want)
	}

	// Banner refused: the dialog is the fallback, and the result says so.
	s = &scripted{answers: map[string]string{"stat -f %Su /dev/console": "carol\n", "id -u carol": "501\n"},
		fail: map[string]string{"launchctl asuser 501 sudo -u carol osascript -e display notification": "execution error: not allowed (-1743)"}}
	r = Runner{Exec: s.exec, GOOS: "darwin"}
	res = r.Execute(context.Background(), Command{ID: "n4", Kind: "notify_user", Payload: json.RawMessage(`{"title":"IT","message":"hi"}`)})
	var d Delivery
	_ = json.Unmarshal(res.Data, &d)
	if !res.OK || d.Method != "osascript-dialog" || !strings.Contains(d.Fallback, "-1743") {
		t.Fatalf("dialog fallback: %+v %+v", res, d)
	}

	// Nobody at the console: refused, never sent to root's (invisible) session.
	s = &scripted{answers: map[string]string{"stat -f %Su /dev/console": "root\n"}}
	r = Runner{Exec: s.exec, GOOS: "darwin"}
	if res = r.Execute(context.Background(), Command{ID: "n5", Kind: "notify_user", Payload: json.RawMessage(`{"title":"IT","message":"hi"}`)}); res.OK {
		t.Fatalf("login window: %+v", res)
	}
	if got := AppleScriptString("a\"b\\c\rd"); got != `"a\"b\\c d"` {
		t.Fatalf("AppleScriptString: %s", got)
	}
}

func TestPowerActionsOnLinuxAndMac(t *testing.T) {
	ctx := context.Background()
	power := func(action string) Command {
		return Command{ID: action, Kind: "power_action", Payload: json.RawMessage(`{"action":"` + action + `"}`)}
	}

	s := &scripted{answers: linuxSessions()}
	r := Runner{Exec: s.exec, GOOS: "linux"}
	if res := r.Execute(ctx, power("lock")); !res.OK || s.calls[len(s.calls)-1] != "loginctl lock-session 2" || !strings.Contains(res.Output, "alice") {
		t.Fatalf("linux lock: %+v %v", res, s.calls)
	}
	if res := r.Execute(ctx, power("logoff")); !res.OK || s.calls[len(s.calls)-1] != "loginctl terminate-session 2" {
		t.Fatalf("linux logoff: %+v %v", res, s.calls)
	}
	s = &scripted{answers: map[string]string{"loginctl list-sessions": "     7    0 root        pts/0\n", "loginctl show-session 7 ": showTTY}}
	r = Runner{Exec: s.exec, GOOS: "linux"}
	if res := r.Execute(ctx, power("logoff")); res.OK || !strings.Contains(res.Error, "no graphical desktop session") {
		t.Fatalf("no desktop: %+v", res)
	}

	mac := map[string]string{"stat -f %Su /dev/console": "carol\n", "id -u carol": "501\n"}
	s = &scripted{answers: mac}
	r = Runner{Exec: s.exec, GOOS: "darwin", FileExists: func(p string) bool { return p == cgSessionPath }}
	if res := r.Execute(ctx, power("lock")); !res.OK || s.calls[len(s.calls)-1] != "launchctl asuser 501 sudo -u carol "+cgSessionPath+" -suspend" {
		t.Fatalf("mac lock with CGSession: %+v %v", res, s.calls)
	}
	s = &scripted{answers: mac}
	r = Runner{Exec: s.exec, GOOS: "darwin", FileExists: func(string) bool { return false }}
	res := r.Execute(ctx, power("lock"))
	if !res.OK || s.calls[len(s.calls)-1] != "launchctl asuser 501 sudo -u carol open -a ScreenSaverEngine" || !strings.Contains(res.Output, "Require password") {
		t.Fatalf("mac lock without CGSession: %+v %v", res, s.calls)
	}
	for _, c := range s.calls {
		if strings.Contains(c, "pmset") || strings.Contains(c, "keystroke") {
			t.Fatalf("display sleep or keystrokes are not a lock: %v", s.calls)
		}
	}
	if res := r.Execute(ctx, power("logoff")); !res.OK || s.calls[len(s.calls)-1] != `launchctl asuser 501 sudo -u carol osascript -e tell application "System Events" to log out` {
		t.Fatalf("mac logoff: %+v %v", res, s.calls)
	}
	if res := r.Execute(ctx, power("restart")); !res.OK || s.calls[len(s.calls)-1] != "shutdown -r +1 Restart requested by IT administrator" {
		t.Fatalf("mac restart: %+v", res)
	}
	if res := r.Execute(ctx, power("hibernate")); res.OK {
		t.Fatal("unknown power action must be refused")
	}
}

func TestPackageManagersDetectedWithDashDashGuard(t *testing.T) {
	cases := []struct {
		have   []string
		action string
		want   string
	}{
		{[]string{"apt-get", "dnf"}, "install", "apt-get install -y -- nginx"},
		{[]string{"apt-get"}, "upgrade", "apt-get install --only-upgrade -y -- nginx"},
		{[]string{"apt-get"}, "uninstall", "apt-get remove -y -- nginx"},
		{[]string{"dnf", "yum"}, "install", "dnf install -y -- nginx"},
		{[]string{"dnf"}, "upgrade", "dnf upgrade -y -- nginx"},
		{[]string{"dnf"}, "uninstall", "dnf remove -y -- nginx"},
		{[]string{"zypper"}, "install", "zypper --non-interactive install -- nginx"},
		{[]string{"zypper"}, "upgrade", "zypper --non-interactive update -- nginx"},
		{[]string{"yum"}, "install", "yum install -y -- nginx"},
		{[]string{"yum"}, "upgrade", "yum update -y -- nginx"},
		{[]string{"yum"}, "uninstall", "yum remove -y -- nginx"},
	}
	for _, c := range cases {
		s := &scripted{}
		r := Runner{Exec: s.exec, GOOS: "linux", LookPath: installed(c.have...)}
		res := r.Execute(context.Background(), Command{ID: "p", Kind: "software_action", Payload: json.RawMessage(`{"action":"` + c.action + `","package_id":"nginx"}`)})
		if !res.OK || len(s.calls) != 1 || s.calls[0] != c.want {
			t.Errorf("%v %s: got %v (%+v), want %s", c.have, c.action, s.calls, res, c.want)
		}
	}
	s := &scripted{}
	r := Runner{Exec: s.exec, GOOS: "linux", LookPath: installed()}
	if res := r.Execute(context.Background(), Command{ID: "p", Kind: "software_action", Payload: json.RawMessage(`{"action":"install","package_id":"nginx"}`)}); res.OK || len(s.calls) != 0 {
		t.Fatalf("no package manager: %+v", res)
	}
	for _, bad := range []string{"-y", "--setopt=x", "nginx;reboot", "a b", ""} {
		r := Runner{Exec: s.exec, GOOS: "linux", LookPath: installed("dnf")}
		payload, _ := json.Marshal(map[string]string{"action": "install", "package_id": bad})
		if res := r.Execute(context.Background(), Command{ID: "p", Kind: "software_action", Payload: payload}); res.OK {
			t.Fatalf("package id %q must be refused", bad)
		}
	}
	if len(s.calls) != 0 {
		t.Fatalf("nothing may run for refused ids: %v", s.calls)
	}
}

func TestMacLogShowHonoursLineCount(t *testing.T) {
	var b strings.Builder
	b.WriteString("Timestamp               Ty Process[PID:TID]\n")
	for i := 1; i <= 500; i++ {
		b.WriteString("2026-11-22 10:00:00.000 Df kernel[0:1] line ")
		b.WriteString(strings.Repeat("x", i%7))
		b.WriteString(" #")
		b.WriteString(string(rune('0' + i%10)))
		b.WriteString("\n")
	}
	s := &scripted{answers: map[string]string{"log show": b.String()}}
	r := Runner{Exec: s.exec, GOOS: "darwin"}
	res := r.Execute(context.Background(), Command{ID: "l", Kind: "fetch_logs", Payload: json.RawMessage(`{"source":"system","lines":25}`)})
	if !res.OK {
		t.Fatalf("log show: %+v", res)
	}
	lines := strings.Split(res.Output, "\n")
	if len(lines) != 25 || strings.HasPrefix(lines[0], "Timestamp") || !strings.HasSuffix(lines[24], "#0") {
		t.Fatalf("want the newest 25 lines, got %d: first=%q last=%q", len(lines), lines[0], lines[len(lines)-1])
	}
	if got := TailLogLines("a\n"+strings.Repeat("é", 300)+"\n", 5, 150); !strings.HasSuffix(got, "…") || len([]rune(strings.Split(got, "\n")[1])) != 150 {
		t.Fatalf("long lines are shortened to 150 characters: %q", got)
	}
	if !keepTail(withTailOutput(context.Background())) || keepTail(context.Background()) {
		t.Fatal("tail flag")
	}
}
