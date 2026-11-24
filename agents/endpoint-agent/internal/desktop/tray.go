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
		icon, err := start(tray.Options{OnRequestHelp: l.requestHelp})
		if err != nil {
			return err
		}
		l.tray.icon = icon
	}
	l.tray.icon.SetInfo(info.NigafiyID, info.Server)
	return nil
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
