package userui

import (
	"errors"
	"strconv"
	"strings"
)

// Dialog command lines for the chat and the operator's questions on Linux (zenity, kdialog) and
// macOS (osascript). Pure functions, tested on every platform; each text is its own argument.

// AskCommand returns the dialog for a question (or a chat message when chat is true: an optional
// typed reply).
func AskCommand(goos string, r AskRequest, chat bool, lookPath func(string) (string, error)) (string, []string, error) {
	r = r.Normalize()
	kind := r.Kind
	title := AskTitle
	if chat {
		kind, title = "text", ChatTitle
	}
	text := r.Operator + ":\n" + r.Text
	if chat {
		text += "\n\n" + ReplyLabel + " (optional)"
	}
	if goos == "darwin" {
		script := "display dialog " + AppleScriptString(text) + " with title " + AppleScriptString(title)
		switch kind {
		case "yes_no":
			script += " buttons {" + AppleScriptString(NoLabel) + ", " + AppleScriptString(YesLabel) + "} default button " + AppleScriptString(YesLabel)
		case "text":
			script += ` default answer "" buttons {` + AppleScriptString(SendLabel) + "} default button " + AppleScriptString(SendLabel)
		default:
			script += " buttons {" + AppleScriptString(OKLabel) + "} default button " + AppleScriptString(OKLabel)
		}
		script += " giving up after " + strconv.Itoa(r.TimeoutSeconds)
		return "/usr/bin/osascript", []string{"-e", script}, nil
	}
	if p, err := lookPath("zenity"); err == nil {
		args := []string{"--title=" + title, "--no-markup", "--timeout=" + strconv.Itoa(r.TimeoutSeconds)}
		switch kind {
		case "yes_no":
			args = append(args, "--question", "--text="+text, "--ok-label="+YesLabel, "--cancel-label="+NoLabel)
		case "text":
			args = append(args, "--entry", "--text="+text, "--ok-label="+SendLabel)
		default:
			args = append(args, "--info", "--text="+text, "--ok-label="+OKLabel)
		}
		return p, args, nil
	}
	if p, err := lookPath("kdialog"); err == nil {
		switch kind {
		case "yes_no":
			return p, []string{"--title", title, "--yes-label", YesLabel, "--no-label", NoLabel, "--yesno", text}, nil
		case "text":
			return p, []string{"--title", title, "--inputbox", text}, nil
		default:
			return p, []string{"--title", title, "--msgbox", text}, nil
		}
	}
	return "", nil, errors.New("no dialog tool for the session chat: install zenity or kdialog")
}

// InterpretAsk turns the tool's result into an answer. killed: our own timeout ended it.
func InterpretAsk(tool, kind, stdout string, exitCode int, killed bool) AskAnswer {
	if killed {
		return AskAnswer{Answer: "timeout"}
	}
	out := strings.TrimRight(stdout, "\r\n")
	if strings.HasSuffix(tool, "osascript") {
		if strings.Contains(out, "gave up:true") {
			return AskAnswer{Answer: "timeout"}
		}
		if exitCode != 0 {
			return AskAnswer{Answer: "closed"}
		}
		switch kind {
		case "yes_no":
			if strings.Contains(out, "button returned:"+YesLabel) {
				return AskAnswer{Answer: "yes"}
			}
			return AskAnswer{Answer: "no"}
		case "text":
			if i := strings.Index(out, "text returned:"); i >= 0 {
				t := out[i+len("text returned:"):]
				if j := strings.Index(t, ", gave up:"); j >= 0 {
					t = t[:j]
				}
				return AskAnswer{Answer: "text", Text: CleanMultiline(t, MaxChatText)}
			}
			return AskAnswer{Answer: "closed"}
		}
		return AskAnswer{Answer: "ok"}
	}
	if strings.HasSuffix(tool, "zenity") && exitCode == 5 {
		return AskAnswer{Answer: "timeout"}
	}
	switch kind {
	case "yes_no":
		if exitCode == 0 {
			return AskAnswer{Answer: "yes"}
		}
		if exitCode == 1 {
			return AskAnswer{Answer: "no"}
		}
		return AskAnswer{Answer: "closed"}
	case "text":
		if exitCode != 0 {
			return AskAnswer{Answer: "closed"}
		}
		return AskAnswer{Answer: "text", Text: CleanMultiline(out, MaxChatText)}
	}
	if exitCode != 0 {
		return AskAnswer{Answer: "closed"}
	}
	return AskAnswer{Answer: "ok"}
}
