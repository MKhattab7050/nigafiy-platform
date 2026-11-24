package userui

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

// Command lines of the Linux and macOS dialog tools. Pure functions, so they are tested on every
// platform. Every text goes in as its own argument (never through a shell); for osascript the text
// is quoted as an AppleScript string literal.

// ConsentCommand: zenity (exit 0 allow, 1 decline, 5 timeout), kdialog (0 yes, 1 no; the timeout is
// ours), or osascript `display dialog … giving up after N`.
func ConsentCommand(goos string, r ConsentRequest, lookPath func(string) (string, error)) (string, []string, error) {
	r = r.Normalize()
	title, allow, decline := r.Labels()
	if goos == "darwin" {
		script := "display dialog " + AppleScriptString(ConsentText(r, -1)+"\n\n"+r.TimeoutNote()) +
			" with title " + AppleScriptString(title) +
			" buttons {" + AppleScriptString(decline) + ", " + AppleScriptString(allow) + "}" +
			" default button " + AppleScriptString(decline) + " cancel button " + AppleScriptString(decline) +
			" with icon caution giving up after " + strconv.Itoa(r.TimeoutSeconds)
		return "/usr/bin/osascript", []string{"-e", script}, nil
	}
	if p, err := lookPath("zenity"); err == nil {
		return p, []string{"--question", "--title=" + title, "--text=" + ConsentText(r, -1) + "\n\n" + r.TimeoutNote(),
			"--ok-label=" + allow, "--cancel-label=" + decline, "--default-cancel", "--no-markup", "--timeout=" + strconv.Itoa(r.TimeoutSeconds)}, nil
	}
	if p, err := lookPath("kdialog"); err == nil {
		return p, []string{"--title", title, "--yes-label", allow, "--no-label", decline, "--warningyesno", ConsentText(r, -1)}, nil
	}
	return "", nil, errors.New("no dialog tool to ask for consent: install zenity or kdialog")
}

// InterpretConsent turns the tool's result into an answer. killed: our own timeout ended it.
func InterpretConsent(tool string, stdout string, exitCode int, killed bool) ConsentAnswer {
	if killed {
		return TimedOut
	}
	switch {
	case strings.HasSuffix(tool, "osascript"):
		if strings.Contains(stdout, "gave up:true") {
			return TimedOut
		}
		if exitCode == 0 && (strings.Contains(stdout, "button returned:"+AllowLabel) || strings.Contains(stdout, "button returned:"+StartNowLabel)) {
			return Accepted
		}
		return Denied
	case strings.HasSuffix(tool, "zenity"):
		switch exitCode {
		case 0:
			return Accepted
		case 5:
			return TimedOut
		}
		return Denied
	default: // kdialog
		if exitCode == 0 {
			return Accepted
		}
		return Denied
	}
}

// BannerCommand: a window that stays until the person presses "End session" (or we close it).
func BannerCommand(goos string, i BannerInfo, lookPath func(string) (string, error)) (string, []string, error) {
	i = i.Normalize()
	if goos == "darwin" {
		script := "display dialog " + AppleScriptString(BannerText(i)) + " with title " + AppleScriptString(i.Title()) +
			" buttons {" + AppleScriptString(EndLabel) + "} default button 1 with icon note"
		return "/usr/bin/osascript", []string{"-e", script}, nil
	}
	if p, err := lookPath("zenity"); err == nil {
		return p, []string{"--info", "--title=" + i.Title(), "--text=" + BannerText(i), "--ok-label=" + EndLabel, "--no-markup", "--no-wrap"}, nil
	}
	if p, err := lookPath("kdialog"); err == nil {
		return p, []string{"--title", i.Title(), "--ok-label", EndLabel, "--msgbox", BannerText(i)}, nil
	}
	return "", nil, errors.New("no dialog tool to show the session banner: install zenity or kdialog")
}

// BannerEndedByUser: the banner tool exited normally, i.e. the person pressed End session (a kill
// from HideBanner is an error exit).
func BannerEndedByUser(err error) bool {
	if err == nil {
		return true
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// zenity/kdialog return 1 when the window is closed with its close box: also an "end".
		return ee.ExitCode() == 1
	}
	return false
}

// AppleScriptString quotes s as an AppleScript string literal (backslash and quote escaped,
// control characters replaced), so no text can end the statement.
func AppleScriptString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '"':
			b.WriteString(`\"`)
		case r == '\n':
			b.WriteString(`\n`)
		case r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029:
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
