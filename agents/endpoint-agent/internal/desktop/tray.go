package desktop

import (
	"context"
	"os/user"
	"strings"
	"sync"

	"github.com/nigafiy/agent/internal/tray"
	"github.com/nigafiy/agent/internal/userui"
)

// The tray icon of the signed-in user's desktop (Request help, Nigafiy ID, About). The agent asks
// for it with ToolTray after each heartbeat, so it comes back after the helper restarts.
type trayState struct {
	mu   sync.Mutex
	icon *tray.Icon
	// start is tray.Start (tests replace it).
	start func(tray.Options) (*tray.Icon, error)
}

func (l *Local) showTray(info TrayInfo) error {
	l.tray.mu.Lock()
	defer l.tray.mu.Unlock()
	if l.tray.icon == nil {
		start := l.tray.start
		if start == nil {
			start = tray.Start
		}
		icon, err := start(tray.Options{OnRequestHelp: l.requestHelp, OnITActivity: l.requestITActivity, OnRecordings: l.requestRecordings, OnEndSession: l.requestEndSession})
		if err != nil {
			return err
		}
		l.tray.icon = icon
	}
	l.tray.icon.SetInfo(info.NigafiyID, info.Server)
	l.tray.icon.SetMenuState(info.Recordings, info.SessionOpen)
	return nil
}

// requestRecordings: "Past recordings…" (the agent lists them and opens the chosen link).
func (l *Local) requestRecordings() {
	l.tools.emit(ToolEvent{Kind: "recordings_request", User: currentUser()}, nil)
}

// requestEndSession: "End current session" ends the remote session and every remote shell.
func (l *Local) requestEndSession() {
	l.tools.emit(ToolEvent{Kind: "end_session_request", User: currentUser()}, nil)
}

// requestHelp asks the person for a note and hands it to the agent (ToolEvent help_request),
// which sends it to Fleet. Nothing is sent when they close the box or leave it empty.
func (l *Local) requestHelp() {
	tu, err := l.toolUI()
	if err != nil {
		return
	}
	ans, err := tu.Ask(context.Background(), userui.AskRequest{SessionID: "help", ID: "help", Operator: "Nigafiy", Text: tray.HelpPrompt, Kind: "text", TimeoutSeconds: 600})
	note := strings.TrimSpace(ans.Text)
	if err != nil || ans.Answer != "text" || note == "" {
		return
	}
	if len(note) > 500 {
		note = note[:500]
	}
	l.tools.emit(ToolEvent{Kind: "help_request", Text: note, User: currentUser()}, nil)
	l.tray.mu.Lock()
	icon := l.tray.icon
	l.tray.mu.Unlock()
	if icon != nil {
		icon.Notify("Nigafiy", "Your request was sent to IT. · تم إرسال طلبك إلى فريق تقنية المعلومات.")
	}
}

// requestITActivity: "IT activity…" from the tray. The agent fetches the list from the server and
// shows it (ToolEvent it_activity_request).
func (l *Local) requestITActivity() {
	l.tools.emit(ToolEvent{Kind: "it_activity_request", User: currentUser()}, nil)
}

func currentUser() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}

func (l *Local) closeTray() {
	l.tray.mu.Lock()
	icon := l.tray.icon
	l.tray.icon = nil
	l.tray.mu.Unlock()
	if icon != nil {
		icon.Close()
	}
}
