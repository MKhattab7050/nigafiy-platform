// Package control executes the closed allow-list of remote administration actions on an enrolled
// endpoint: terminating a process, starting/stopping/restarting a service, power actions,
// displaying an administrator message, remote file operations, remote desktop capture/input,
// software package actions, system log retrieval, and approved IT diagnostics.
// No arbitrary shell text execution exists here.
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

	"github.com/lan-detective/endpoint-agent/internal/filemgr"
	"github.com/lan-detective/endpoint-agent/internal/remotedesktop"
)

var (
	serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,160}$`)
	packageIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_.:+-]{1,160}$`)
	dnsTargetPattern   = regexp.MustCompile(`^[A-Za-z0-9.-]{1,180}$`)
)

type Command struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

type Result struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Output string          `json:"output,omitempty"`
	Error  string          `json:"error,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// Runner executes validated control actions. Exec can be overridden in unit tests.
type Runner struct {
	Exec func(ctx context.Context, name string, args ...string) (string, error)
}

func DefaultRunner() Runner {
	return Runner{
		Exec: func(ctx context.Context, name string, args ...string) (string, error) {
			c, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			out, err := exec.CommandContext(c, name, args...).CombinedOutput()
			text := strings.TrimSpace(string(out))
			if len(text) > 16000 {
				text = text[:16000]
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
		} else if runtime.GOOS == "darwin" {
			lcAction := map[string]string{"start": "start", "stop": "stop", "restart": "kickstart"}[p.Action]
			out, err = r.Exec(ctx, "launchctl", lcAction, p.Service)
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
			} else if runtime.GOOS == "darwin" {
				out, err = r.Exec(ctx, "pmset", "displaysleepnow")
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

	case "fs_op":
		var req filemgr.Request
		if err := json.Unmarshal(cmd.Payload, &req); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid file manager request payload"}
		}
		res, err := filemgr.Execute(req)
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		raw, _ := json.Marshal(res)
		msg := res.Message
		if msg == "" {
			msg = fmt.Sprintf("File operation '%s' completed", req.Op)
		}
		return Result{ID: cmd.ID, OK: true, Output: msg, Data: raw}

	case "rd_capture":
		var opts remotedesktop.CaptureOptions
		_ = json.Unmarshal(cmd.Payload, &opts)
		frame, err := remotedesktop.CaptureFrame(opts)
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		raw, _ := json.Marshal(frame)
		return Result{
			ID:     cmd.ID,
			OK:     true,
			Output: fmt.Sprintf("Captured frame %dx%d (%d bytes, %s)", frame.Width, frame.Height, frame.ByteLength, frame.CaptureMode),
			Data:   raw,
		}

	case "rd_input":
		var ev remotedesktop.InputEvent
		if err := json.Unmarshal(cmd.Payload, &ev); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid remote desktop input payload"}
		}
		if err := remotedesktop.InjectInput(ev); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		return Result{ID: cmd.ID, OK: true, Output: fmt.Sprintf("Input '%s' delivered", ev.Kind)}

	case "software_action":
		var p struct {
			Action    string `json:"action"` // install | upgrade | uninstall
			PackageID string `json:"package_id"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid software_action payload"}
		}
		if !packageIDPattern.MatchString(p.PackageID) {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid package identifier"}
		}
		if p.Action != "install" && p.Action != "upgrade" && p.Action != "uninstall" {
			return Result{ID: cmd.ID, OK: false, Error: "Unsupported software action"}
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		var out string
		var err error
		if runtime.GOOS == "windows" {
			args := []string{p.Action, "--id", p.PackageID, "--silent", "--accept-package-agreements", "--accept-source-agreements"}
			if p.Action == "uninstall" {
				args = []string{"uninstall", "--id", p.PackageID, "--silent"}
			}
			out, err = r.Exec(ctx, "winget", args...)
		} else if runtime.GOOS == "darwin" {
			out, err = r.Exec(ctx, "brew", p.Action, p.PackageID)
		} else {
			aptCmd := map[string]string{"install": "install", "upgrade": "install", "uninstall": "remove"}[p.Action]
			out, err = r.Exec(ctx, "apt-get", aptCmd, "-y", p.PackageID)
		}
		if err != nil {
			return Result{ID: cmd.ID, OK: false, Error: firstNonEmpty(out, err.Error())}
		}
		return Result{ID: cmd.ID, OK: true, Output: firstNonEmpty(out, fmt.Sprintf("Software %s (%s) completed", p.Action, p.PackageID))}

	case "fetch_logs":
		var p struct {
			Source string `json:"source"` // system | application | security
			Lines  int    `json:"lines"`
		}
		_ = json.Unmarshal(cmd.Payload, &p)
		if p.Lines <= 0 || p.Lines > 200 {
			p.Lines = 60
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		var out string
		var err error
		if runtime.GOOS == "windows" {
			logName := "System"
			if strings.EqualFold(p.Source, "application") {
				logName = "Application"
			} else if strings.EqualFold(p.Source, "security") {
				logName = "Security"
			}
			script := fmt.Sprintf("Get-WinEvent -LogName %s -MaxEvents %d -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | Format-Table -AutoSize -Wrap | Out-String -Width 200", logName, p.Lines)
			out, err = r.Exec(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
		} else if runtime.GOOS == "darwin" {
			out, err = r.Exec(ctx, "log", "show", "--last", "15m", "--style", "compact")
		} else {
			out, err = r.Exec(ctx, "journalctl", "-n", strconv.Itoa(p.Lines), "--no-pager", "-o", "short-iso")
		}
		if err != nil && out == "" {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		raw, _ := json.Marshal(map[string]any{"source": p.Source, "logs": out})
		return Result{ID: cmd.ID, OK: true, Output: out, Data: raw}

	case "diagnostic_command":
		var p struct {
			Tool   string `json:"tool"` // ipconfig | route | arp | nslookup | whoami | systeminfo | netstat | gpresult | df | uptime
			Target string `json:"target,omitempty"`
		}
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return Result{ID: cmd.ID, OK: false, Error: "Invalid diagnostic_command payload"}
		}
		if r.Exec == nil {
			return Result{ID: cmd.ID, OK: false, Error: "Execution disabled"}
		}
		var out string
		var err error
		switch p.Tool {
		case "ipconfig":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "ipconfig", "/all")
			} else if runtime.GOOS == "darwin" {
				out, err = r.Exec(ctx, "ifconfig", "-a")
			} else {
				out, err = r.Exec(ctx, "ip", "addr")
			}
		case "route":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "route", "print")
			} else if runtime.GOOS == "darwin" {
				out, err = r.Exec(ctx, "netstat", "-rn")
			} else {
				out, err = r.Exec(ctx, "ip", "route")
			}
		case "arp":
			out, err = r.Exec(ctx, "arp", "-a")
		case "nslookup":
			target := strings.TrimSpace(p.Target)
			if target == "" {
				target = "localhost"
			}
			if !dnsTargetPattern.MatchString(target) {
				return Result{ID: cmd.ID, OK: false, Error: "Invalid DNS target"}
			}
			out, err = r.Exec(ctx, "nslookup", target)
		case "whoami":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "whoami", "/all")
			} else {
				out, err = r.Exec(ctx, "id")
			}
		case "systeminfo":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "systeminfo")
			} else {
				out, err = r.Exec(ctx, "uname", "-a")
			}
		case "netstat":
			out, err = r.Exec(ctx, "netstat", "-ano")
		case "gpresult":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "gpresult", "/r")
			} else {
				return Result{ID: cmd.ID, OK: false, Error: "gpresult is only supported on Windows"}
			}
		case "df":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String")
			} else {
				out, err = r.Exec(ctx, "df", "-h")
			}
		case "uptime":
			if runtime.GOOS == "windows" {
				out, err = r.Exec(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", "(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | Format-List | Out-String")
			} else {
				out, err = r.Exec(ctx, "uptime")
			}
		default:
			return Result{ID: cmd.ID, OK: false, Error: fmt.Sprintf("Unsupported diagnostic tool %q", p.Tool)}
		}
		if err != nil && out == "" {
			return Result{ID: cmd.ID, OK: false, Error: err.Error()}
		}
		raw, _ := json.Marshal(map[string]any{"tool": p.Tool, "output": out})
		return Result{ID: cmd.ID, OK: true, Output: out, Data: raw}
	}

	return Result{ID: cmd.ID, OK: false, Error: fmt.Sprintf("Unsupported command kind %q", cmd.Kind)}
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	return strings.TrimSpace(b)
}
