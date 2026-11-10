// Package control executes the closed allow-list of remote administration actions on an enrolled
// endpoint: terminating a process, starting/stopping/restarting a service, power actions, and
// displaying an administrator message. No arbitrary command execution exists here.
package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,160}$`)

type Command struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

type Result struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Runner executes validated control actions. Exec can be overridden in unit tests.
type Runner struct {
	Exec func(ctx context.Context, name string, args ...string) (string, error)
}

func DefaultRunner() Runner {
	return Runner{
		Exec: func(ctx context.Context, name string, args ...string) (string, error) {
			c, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			out, err := exec.CommandContext(c, name, args...).CombinedOutput()
			text := strings.TrimSpace(string(out))
			if len(text) > 1000 {
				text = text[:1000]
			}
			return text, err
		},
	}
}

func (r Runner) Execute(ctx context.Context, cmd Command) Result {
	switch cmd.Kind {
	case "refresh_inventory":
		return Result{ID: cmd.ID, OK: true, Output: "Inventory refresh triggered"}

	case "kill_process":
		var p struct {
			PID  int    `json:"pid"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.PID <= 4 {
			return Result{ID: cmd.ID, OK: false, Error: "A valid process PID (> 4) is required"}
		}
		if runtime.GOOS == "windows" && r.Exec != nil {
			out, err := r.Exec(ctx, "taskkill", "/PID", strconv.Itoa(p.PID), "/F")
			if err != nil {
				return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
			}
			return Result{ID: cmd.ID, OK: true, Output: firstNonEmpty(out, fmt.Sprintf("Terminated PID %d", p.PID))}
		}
		if r.Exec != nil {
			out, err := r.Exec(ctx, "kill", "-9", strconv.Itoa(p.PID))
			if err != nil {
				return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
			}
			return Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Terminated PID %d", p.PID)}
		}
		proc, err := os.FindProcess(p.PID)
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		if err := proc.Kill(); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		return Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Terminated PID %d", p.PID)}

	case "service_action":
		var p struct {
			Service string `json:"service"`
			Action  string `json:"action"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid service_action payload"}
		}
		if !serviceNamePattern.MatchString(p.Service) {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid service name"}
		}
		if p.Action != "start" && p.Action != "stop" && p.Action != "restart" {
			return Result{ID: cmd.ID, OK: false, Error: "Unsupported service action"}
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		var out string
		var err error
		if runtime.GOOS == "windows" {
			psCmd := map[string]string{"start": "Start-Service", "stop": "Stop-Service", "restart": "Restart-Service"}[p.Action]
			out, err = r.Exec(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd, "-Name", p.Service, "-Force")
		} else {
			out, err = r.Exec(ctx, "systemctl", p.Action, p.Service)
		}
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
		}
		return Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Service %s: %s completed", p.Service, p.Action)}

	case "power_action":
		var p struct {
			Action string `json:"action"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid power_action payload"}
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		var out string
		var err error
		switch p.Action {
		case "lock":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "rundll32.exe", "user32.dll,LockWorkStation")
			} else {
				out, err = r.Exec(ctx, "loginctl", "lock-sessions")
			}
		case "logoff":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "shutdown", "/l")
			} else {
				err = errors.New("logoff is only supported on Windows workstations")
			}
		case "restart":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "shutdown", "/r", "/t", "5", "/c", "Restart requested by IT administrator (LAN Detective)")
			} else {
				out, err = r.Exec(ctx, "shutdown", "-r", "+1", "Restart requested by IT administrator")
			}
		case "shutdown":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "shutdown", "/s", "/t", "5", "/c", "Shutdown requested by IT administrator (LAN Detective)")
			} else {
				out, err = r.Exec(ctx, "shutdown", "-h", "+1", "Shutdown requested by IT administrator")
			}
		default:
			return Result{ID: cmd.ID, OK: false, Error: "Unsupported power action"}
		}
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
		}
		return Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Power action '%s' executed", p.Action)}

	case "notify_user":
		var p struct {
			Title   string `json:"title"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil || strings.TrimSpace(p.Message) == "" {
			return Result{ID: cmd.ID, OK: false, Error: "Message is required"}
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		full := strings.TrimSpace(p.Title + ": " + p.Message)
		if len(full) > 500 {
			full = full[:500]
		}
		var out string
		var err error
		if runtime.GOOS == "windows" {
			out, err = r.Exec(ctx, "msg", "*", "/TIME:60", full)
		} else {
			out, err = r.Exec(ctx, "wall", full)
		}
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
		}
		return Result{ID: cmd.ID, OK: true, Output: "Message delivered to user session"}
	}

	return Result{ID: cmd.ID, OK: false, Error: fmt.Sprintf("Unsupported command kind %q", cmd.Kind)}
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	return strings.TrimSpace(b)
}

