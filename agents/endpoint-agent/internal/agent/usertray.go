package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/userui"
)

// The user's side of the tray (Fleet Pro): "End current session" and "Past recordings…".

func (a *Agent) sessionOrShellOpen() bool {
	if a.sessions != nil && a.sessions.Active() != "" {
		return true
	}
	return a.shells != nil && a.shells.Count() > 0
}

// endShellsFromTray: "End current session" in the tray. The remote session was already ended by
// rdstream (as from the banner); every remote shell ends the same way, and the server hears it.
func (a *Agent) endShellsFromTray() {
	if a.shells == nil {
		return
	}
	if n := a.shells.EndAll("user"); n > 0 {
		a.log.Info("the user ended the remote shells from the tray", "shells", n)
	}
}

type userRecording struct {
	ID        string  `json:"id"`
	StartedAt string  `json:"started_at"`
	EndedAt   *string `json:"ended_at"`
	Operator  *string `json:"operator"`
	Reason    *string `json:"reason"`
}

// RecordingsText is the list the person picks from (numbered, newest first, local time).
func RecordingsText(recs []userRecording, loc *time.Location) string {
	var b strings.Builder
	b.WriteString("Recordings of remote support sessions on this computer. Type the number of the one to watch; it opens in your browser.\n")
	b.WriteString("تسجيلات جلسات الدعم عن بُعد على هذا الحاسوب. اكتب رقم التسجيل الذي تريد مشاهدته؛ يُفتح في متصفحك.\n")
	for i, r := range recs {
		when := r.StartedAt
		if t, err := time.Parse(time.RFC3339Nano, r.StartedAt); err == nil {
			when = t.In(loc).Format("2006-01-02 15:04")
		}
		fmt.Fprintf(&b, "\n%d. %s", i+1, when)
		if r.Operator != nil && *r.Operator != "" {
			fmt.Fprintf(&b, " · %s", *r.Operator)
		}
		if r.Reason != nil && *r.Reason != "" {
			fmt.Fprintf(&b, " · %s", *r.Reason)
		}
	}
	return b.String()
}

func (a *Agent) tellUser(id, text string) {
	ask := userui.AskRequest{SessionID: id, ID: id, Operator: "Nigafiy", Text: text, Kind: "ok", TimeoutSeconds: 120}
	_, _, _ = a.deps.Desktop.Tool(context.Background(), desktop.ToolRequest{Op: desktop.ToolAsk, Ask: &ask}, nil)
}

// showRecordings: "Past recordings…" in the tray (shown only when the group allows it). The server
// checks again; the chosen recording opens through a short-lived link on this agent's server.
func (a *Agent) showRecordings(user string) {
	if a.deps.Desktop == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var list struct {
		Allowed    bool            `json:"allowed"`
		Recordings []userRecording `json:"recordings"`
	}
	if err := a.post(ctx, "/recordings", map[string]any{}, true, &list); err != nil {
		a.tellUser("recordings", "The recordings could not be loaded from the server. Try again later. / تعذّر تحميل التسجيلات من الخادم. حاول لاحقًا.")
		return
	}
	if !list.Allowed {
		a.tellUser("recordings", "Your IT team does not let people watch the recordings of this computer. / لا يسمح فريق تقنية المعلومات بمشاهدة تسجيلات هذا الحاسوب.")
		return
	}
	if len(list.Recordings) == 0 {
		a.tellUser("recordings", "No recording of a support session on this computer is kept. / لا يوجد تسجيل محفوظ لجلسة دعم على هذا الحاسوب.")
		return
	}
	ask := userui.AskRequest{SessionID: "recordings", ID: "recordings", Operator: "Nigafiy", Text: RecordingsText(list.Recordings, time.Local), Kind: "text", TimeoutSeconds: 300}
	res, _, err := a.deps.Desktop.Tool(context.Background(), desktop.ToolRequest{Op: desktop.ToolAsk, Ask: &ask}, nil)
	if err != nil || res.Answer == nil || res.Answer.Answer != "text" {
		return
	}
	n, err := strconv.Atoi(strings.TrimSpace(res.Answer.Text))
	if err != nil || n < 1 || n > len(list.Recordings) {
		a.tellUser("recordings", "No recording has that number. / لا يوجد تسجيل بهذا الرقم.")
		return
	}
	var link struct {
		Path string `json:"path"`
	}
	body := map[string]any{"recording_id": list.Recordings[n-1].ID}
	if user != "" {
		body["user"] = user
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel2()
	if err := a.post(ctx2, "/recordings/link", body, true, &link); err != nil || !strings.HasPrefix(link.Path, "/recording-view/") {
		a.tellUser("recordings", "The recording could not be opened. Try again later. / تعذّر فتح التسجيل. حاول لاحقًا.")
		return
	}
	// Only a page of this agent's own server is ever opened.
	url := strings.TrimRight(a.server(), "/") + link.Path
	if _, _, err := a.deps.Desktop.Tool(context.Background(), desktop.ToolRequest{Op: desktop.ToolOpenURL, URL: url}, nil); err != nil {
		a.log.Info("recording link not opened", "reason", err.Error())
		a.tellUser("recordings", "Open this address in your browser within 15 minutes: / افتح هذا العنوان في متصفحك خلال 15 دقيقة:\n"+url)
	}
}
