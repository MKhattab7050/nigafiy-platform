package configbackup

import (
	"regexp"
	"strconv"
	"strings"
)

// Terminal clean-up: what a person would have seen on the screen, without colour codes, pager
// prompts, carriage-return overwrites and backspaces. Volatile lines (timestamps, counters) are
// removed by the server's normalizer, which is shared by every collector version.

var (
	ansiRe = regexp.MustCompile(`\x1b(\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()*+][0-9A-Za-z]|[=>78DEHMNOZc])`)
	// Pager prompts of the supported CLIs, anywhere in a line.
	pagerRe = regexp.MustCompile(`(?i)(\s*--\s?more\s?--\s*|\s*<--- more --->\s*|\s*-{2,4} more -{2,4}\s*|\s*press any key to continue( \(q to quit\))?\s*|\s*\(more\)\s*$)`)
	// Cursor-left (CSI n D): pagers erase their prompt by moving back over it; emulated as backspaces.
	cursorLeftRe = regexp.MustCompile(`\x1b\[(\d{0,4})D`)
	// A pager prompt at the end of what was read so far: the device waits for a key.
	pagerTailRe = regexp.MustCompile(`(?i)(--\s?more\s?--|<--- more --->|-{2,4} more -{2,4}|press any key to continue( \(q to quit\))?|\(q\)uit|lines \d+-\d+)[^\n]*$`)
)

// cleanTerminal turns raw PTY output into plain text lines.
func cleanTerminal(raw string) string {
	s := cursorLeftRe.ReplaceAllStringFunc(raw, func(m string) string {
		n, err := strconv.Atoi(m[2 : len(m)-1])
		if err != nil || n < 1 {
			n = 1
		}
		return strings.Repeat("\b", min(n, ptyCols))
	})
	s = ansiRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = overwrite(l)
		l = pagerRe.ReplaceAllString(l, "")
		out = append(out, strings.TrimRight(l, " \t"))
	}
	return strings.Join(out, "\n")
}

// overwrite emulates one terminal line: '\r' returns to column 0, '\b' moves left, other control
// characters are dropped, printable characters overwrite what is under the cursor.
func overwrite(line string) string {
	if !strings.ContainsAny(line, "\r\b") && !hasControl(line) {
		return line
	}
	buf := make([]rune, 0, len(line))
	cur := 0
	for _, r := range line {
		switch {
		case r == '\r':
			cur = 0
		case r == '\b':
			if cur > 0 {
				cur--
			}
		case r == '\t':
			buf, cur = put(buf, cur, r)
		case r < 0x20 || r == 0x7f:
			// other control characters carry nothing visible
		default:
			buf, cur = put(buf, cur, r)
		}
	}
	return string(buf)
}

func put(buf []rune, cur int, r rune) ([]rune, int) {
	if cur < len(buf) {
		buf[cur] = r
	} else {
		buf = append(buf, r)
	}
	return buf, cur + 1
}

func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < 0x20 && c != '\t') || c == 0x7f {
			return true
		}
	}
	return false
}

// commandOutput extracts a command's own output from the cleaned text captured between sending it
// and the next prompt: the echoed command line and the trailing prompt are removed.
func commandOutput(cleaned, cmd, prompt string) string {
	lines := strings.Split(cleaned, "\n")
	// Drop the echo: the first line (within the first few) that contains the command.
	for i := 0; i < len(lines) && i < 3; i++ {
		if strings.Contains(lines[i], cmd) {
			lines = lines[i+1:]
			break
		}
	}
	// Drop the trailing prompt (and blank lines before it).
	for len(lines) > 0 {
		last := strings.TrimSpace(lines[len(lines)-1])
		if last == "" || (prompt != "" && last == strings.TrimSpace(prompt)) {
			lines = lines[:len(lines)-1]
			continue
		}
		break
	}
	// Leading blank lines carry nothing.
	for len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}
	return strings.Join(lines, "\n")
}

// lastLine returns the last non-empty line, trimmed on the right.
func lastLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimRight(lines[i], " \t"); strings.TrimSpace(l) != "" {
			return l
		}
	}
	return ""
}

// commandErrorRe recognizes a CLI rejecting a command (unknown, not permitted, syntax).
var commandErrorRe = regexp.MustCompile(`(?im)^\s*(\^\s*$|% ?(invalid|unknown|incomplete|ambiguous|unrecognized|authorization failed|permission denied)|error:|unrecognized command|syntax error|bad command name|invalid syntax|unknown action|command parse error|command fail|.*: (command )?not found$|-?ash: |-?bash: )`)

// looksLikeCommandError: a short output that is mostly a CLI error message.
func looksLikeCommandError(out string) (string, bool) {
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return "", false
	}
	lines := strings.Split(trimmed, "\n")
	if len(lines) > 6 {
		return "", false
	}
	if m := commandErrorRe.FindString(trimmed); m != "" {
		for _, l := range lines {
			if l = strings.TrimSpace(l); l != "" && l != "^" {
				return clip(l, 200), true
			}
		}
		return clip(strings.TrimSpace(m), 200), true
	}
	return "", false
}
