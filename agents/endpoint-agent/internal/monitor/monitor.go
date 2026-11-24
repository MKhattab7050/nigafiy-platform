// Package monitor measures what the server's monitoring rules need beyond the heartbeat's own CPU,
// memory and disk figures: the state of named services and the number of matching event-log
// (Windows) or journal (Linux) entries in a time window. The server sends the list with each
// heartbeat answer; the next heartbeat carries the measurements. The server decides what is a
// breach. Values from a rule (log name, provider, text to match) reach the query as data
// (environment variables or separate arguments), never as code.
package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EventQuery is one event-log rule as the server sends it.
type EventQuery struct {
	ID            string `json:"id"`
	Log           string `json:"log"`
	Source        string `json:"source,omitempty"`
	IDs           []int  `json:"ids,omitempty"`
	Level         string `json:"level,omitempty"` // critical | error | warning | any
	Match         string `json:"match,omitempty"`
	WindowMinutes int    `json:"window_minutes"`
}

// Spec is the "monitor" object of the heartbeat answer.
type Spec struct {
	Services []string     `json:"services"`
	Events   []EventQuery `json:"events"`
}

// EventResult: how many entries matched in the window, or why the query could not run.
type EventResult struct {
	Count      int    `json:"count"`
	Sample     string `json:"sample,omitempty"` // "<provider> <id> at <time>" of the newest match; never the message
	Error      string `json:"error,omitempty"`
	MeasuredAt string `json:"measured_at"`
}

// Report is the "monitor" object of the heartbeat.
type Report struct {
	// Services: name → running | stopped | paused | starting | stopping | not_found | unknown.
	Services map[string]string      `json:"services"`
	Events   map[string]EventResult `json:"events"`
}

// eventRefresh: an event query runs at most once a minute (the heartbeat is every 20 s).
const eventRefresh = 60 * time.Second

// Runner runs a program and returns its stdout (tests replace it).
type Runner func(ctx context.Context, env []string, name string, args ...string) (string, error)

// Prober keeps the latest spec and measurements.
type Prober struct {
	GOOS         string
	Run          Runner
	ServiceState func(name string) string
	Now          func() time.Time

	mu      sync.Mutex
	spec    Spec
	events  map[string]EventResult
	ranAt   map[string]time.Time
	running map[string]bool
}

// New returns a prober for this machine.
func New() *Prober {
	return &Prober{GOOS: runtime.GOOS, Run: execRun, ServiceState: serviceState, Now: time.Now}
}

func execRun(ctx context.Context, env []string, name string, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return string(out), fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
	}
	return string(out), err
}

// SetSpec replaces what is measured (from the heartbeat answer). Results of rules no longer
// listed are dropped.
func (p *Prober) SetSpec(s Spec) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.spec = s
	keep := map[string]bool{}
	for _, q := range s.Events {
		keep[q.ID] = true
	}
	for id := range p.events {
		if !keep[id] {
			delete(p.events, id)
			delete(p.ranAt, id)
		}
	}
}

// Report measures the services now and returns the latest event counts, starting a refresh of
// any that are due. Nil when nothing is asked.
func (p *Prober) Report(ctx context.Context) *Report {
	p.mu.Lock()
	spec := p.spec
	p.mu.Unlock()
	if len(spec.Services) == 0 && len(spec.Events) == 0 {
		return nil
	}
	r := &Report{Services: map[string]string{}, Events: map[string]EventResult{}}
	for _, name := range spec.Services {
		r.Services[name] = p.ServiceState(name)
	}
	now := p.Now()
	p.mu.Lock()
	if p.events == nil {
		p.events, p.ranAt, p.running = map[string]EventResult{}, map[string]time.Time{}, map[string]bool{}
	}
	for _, q := range spec.Events {
		if res, ok := p.events[q.ID]; ok {
			r.Events[q.ID] = res
		}
		if !p.running[q.ID] && now.Sub(p.ranAt[q.ID]) >= eventRefresh {
			p.running[q.ID] = true
			go p.refresh(context.WithoutCancel(ctx), q)
		}
	}
	p.mu.Unlock()
	return r
}

func (p *Prober) refresh(ctx context.Context, q EventQuery) {
	res := p.QueryEvents(ctx, q)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running[q.ID] = false
	p.ranAt[q.ID] = p.Now()
	p.events[q.ID] = res
}

// QueryEvents counts the matching entries of one rule now.
func (p *Prober) QueryEvents(ctx context.Context, q EventQuery) EventResult {
	res := EventResult{MeasuredAt: p.Now().UTC().Format(time.RFC3339)}
	if q.WindowMinutes <= 0 || q.WindowMinutes > 1440 {
		q.WindowMinutes = 60
	}
	switch p.GOOS {
	case "windows":
		out, err := p.Run(ctx, WindowsEventEnv(q), "powershell", "-NoProfile", "-NonInteractive", "-Command", windowsEventScript)
		return ParseWindowsEventResult(out, err, res)
	case "linux":
		if len(q.IDs) > 0 {
			res.Error = "event IDs exist on Windows only; this rule cannot be measured from the Linux journal"
			return res
		}
		out, err := p.Run(ctx, nil, "journalctl", JournalArgs(q)...)
		if err != nil && strings.TrimSpace(out) == "" {
			res.Error = clip("journalctl: "+err.Error(), 300)
			return res
		}
		res.Count, res.Sample = CountJournal(out, q.Match)
		return res
	}
	res.Error = "event-log rules are measured on Windows (event log) and Linux (journal) only"
	return res
}

// The rule's values arrive as environment variables and are used as data only.
const windowsEventScript = `$ErrorActionPreference = 'Stop'
try {
  $f = @{ LogName = $env:NIGAFIY_MON_LOG; StartTime = (Get-Date).AddMinutes(-[int]$env:NIGAFIY_MON_WINDOW) }
  if ($env:NIGAFIY_MON_SOURCE) { $f.ProviderName = $env:NIGAFIY_MON_SOURCE }
  if ($env:NIGAFIY_MON_IDS) { $f.Id = @($env:NIGAFIY_MON_IDS.Split(',') | ForEach-Object { [int]$_ }) }
  switch ($env:NIGAFIY_MON_LEVEL) { 'critical' { $f.Level = @(1) } 'error' { $f.Level = @(1, 2) } 'warning' { $f.Level = @(1, 2, 3) } }
  $ev = @()
  try { $ev = @(Get-WinEvent -FilterHashtable $f -MaxEvents 5000) } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
  if ($env:NIGAFIY_MON_MATCH) { $m = $env:NIGAFIY_MON_MATCH; $ev = @($ev | Where-Object { $_.Message -and $_.Message.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
  $s = ''
  if ($ev.Count -gt 0) { $s = '' + $ev[0].ProviderName + ' ' + $ev[0].Id + ' at ' + $ev[0].TimeCreated.ToUniversalTime().ToString('o') }
  @{ ok = $true; count = $ev.Count; sample = $s } | ConvertTo-Json -Compress
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }`

// WindowsEventEnv passes the rule to the script as data.
func WindowsEventEnv(q EventQuery) []string {
	ids := make([]string, 0, len(q.IDs))
	for _, id := range q.IDs {
		ids = append(ids, strconv.Itoa(id))
	}
	level := q.Level
	if level == "any" {
		level = ""
	}
	return []string{
		"NIGAFIY_MON_LOG=" + q.Log,
		"NIGAFIY_MON_WINDOW=" + strconv.Itoa(q.WindowMinutes),
		"NIGAFIY_MON_SOURCE=" + q.Source,
		"NIGAFIY_MON_IDS=" + strings.Join(ids, ","),
		"NIGAFIY_MON_LEVEL=" + level,
		"NIGAFIY_MON_MATCH=" + q.Match,
	}
}

// ParseWindowsEventResult reads the script's JSON.
func ParseWindowsEventResult(out string, err error, res EventResult) EventResult {
	var v struct {
		OK     bool   `json:"ok"`
		Count  int    `json:"count"`
		Sample string `json:"sample"`
		Error  string `json:"error"`
	}
	if jerr := json.Unmarshal([]byte(strings.TrimSpace(out)), &v); jerr != nil {
		why := "no output"
		if err != nil {
			why = err.Error()
		}
		res.Error = clip("Get-WinEvent: "+why, 300)
		return res
	}
	if !v.OK {
		res.Error = clip("Get-WinEvent: "+v.Error, 300)
		return res
	}
	res.Count, res.Sample = v.Count, clip(v.Sample, 200)
	return res
}

// JournalArgs builds the journalctl call: the source is a unit (-u), the level a priority.
func JournalArgs(q EventQuery) []string {
	args := []string{"--no-pager", "-q", "-o", "json", "--since", fmt.Sprintf("-%dmin", q.WindowMinutes)}
	if q.Source != "" {
		args = append(args, "-u", q.Source)
	}
	switch q.Level {
	case "critical":
		args = append(args, "-p", "crit")
	case "error":
		args = append(args, "-p", "err")
	case "warning":
		args = append(args, "-p", "warning")
	}
	return args
}

// CountJournal counts journal JSON lines whose MESSAGE contains match (case-insensitive; empty
// matches all) and describes the newest one without its message.
func CountJournal(out, match string) (int, string) {
	n := 0
	sample := ""
	m := strings.ToLower(match)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e map[string]any
		if json.Unmarshal([]byte(line), &e) != nil {
			continue
		}
		msg, _ := e["MESSAGE"].(string)
		if m != "" && !strings.Contains(strings.ToLower(msg), m) {
			continue
		}
		n++
		unit, _ := e["_SYSTEMD_UNIT"].(string)
		if unit == "" {
			unit, _ = e["SYSLOG_IDENTIFIER"].(string)
		}
		ts := ""
		if us, ok := e["__REALTIME_TIMESTAMP"].(string); ok {
			if v, err := strconv.ParseInt(us, 10, 64); err == nil {
				ts = time.UnixMicro(v).UTC().Format(time.RFC3339)
			}
		}
		sample = clip(strings.TrimSpace(unit+" at "+ts), 200)
	}
	return n, sample
}

func clip(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	if len(s) > max {
		cut := max
		for cut > 0 && (s[cut]&0xC0) == 0x80 {
			cut--
		}
		return s[:cut]
	}
	return s
}
