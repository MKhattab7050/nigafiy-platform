package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/userui"
)

type trayDesktop struct {
	desktop.Desktop
	answers []userui.AskAnswer
	asked   []userui.AskRequest
	opened  []string
}

func (d *trayDesktop) Tool(_ context.Context, req desktop.ToolRequest, _ []byte) (desktop.ToolResult, []byte, error) {
	if req.Op == desktop.ToolOpenURL {
		d.opened = append(d.opened, req.URL)
		return desktop.ToolResult{}, nil, nil
	}
	d.asked = append(d.asked, *req.Ask)
	a := userui.AskAnswer{Answer: "ok"}
	if len(d.answers) > 0 {
		a, d.answers = d.answers[0], d.answers[1:]
	}
	return desktop.ToolResult{Answer: &a}, nil, nil
}

func TestPastRecordingsOpensOnlyTheServersOwnLink(t *testing.T) {
	allowed := true
	linkPath := "/recording-view/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
	var linked []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agent/recordings":
			_ = json.NewEncoder(w).Encode(map[string]any{"allowed": allowed, "recordings": []map[string]any{
				{"id": "r1", "started_at": "2026-11-24T09:00:00Z", "operator": "tech@corp.example", "reason": "Printer"},
				{"id": "r2", "started_at": "2026-11-23T09:00:00Z", "operator": nil, "reason": nil},
			}})
		case "/api/v1/agent/recordings/link":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			linked = append(linked, b)
			_ = json.NewEncoder(w).Encode(map[string]any{"path": linkPath})
		}
	}))
	defer srv.Close()
	d := &trayDesktop{answers: []userui.AskAnswer{{Answer: "text", Text: " 2 "}}}
	a := &Agent{log: slog.New(slog.NewTextHandler(io.Discard, nil)), addrs: fixedServer(srv.URL), httpClient: srv.Client(), deps: Deps{Desktop: d}}
	a.showRecordings(`CORP\sami`)
	if len(linked) != 1 || linked[0]["recording_id"] != "r2" || linked[0]["user"] != `CORP\sami` {
		t.Fatalf("linked %v", linked)
	}
	if len(d.opened) != 1 || d.opened[0] != srv.URL+linkPath {
		t.Fatalf("opened %v", d.opened)
	}
	if d.asked[0].Kind != "text" || !strings.Contains(d.asked[0].Text, "1. 2026-11-24") || !strings.Contains(d.asked[0].Text, "tech@corp.example · Printer") {
		t.Fatalf("list %q", d.asked[0].Text)
	}
	// A path that is not a recording page is never opened.
	linkPath = "https://evil.example/x"
	d.answers = []userui.AskAnswer{{Answer: "text", Text: "1"}}
	a.showRecordings("")
	if len(d.opened) != 1 {
		t.Fatalf("opened a foreign address: %v", d.opened)
	}
	// Not allowed (the group changed): a message, nothing opened.
	allowed = false
	d.asked = nil
	a.showRecordings("")
	if len(d.asked) != 1 || d.asked[0].Kind != "ok" || !strings.Contains(d.asked[0].Text, "does not let people watch") {
		t.Fatalf("not allowed: %+v", d.asked)
	}
	if RecordingsText(nil, time.UTC) == "" {
		t.Fatal("empty text")
	}
}
