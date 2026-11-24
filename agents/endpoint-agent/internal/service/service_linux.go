//go:build linux

package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DefaultName is the systemd unit name (without .service).
func DefaultName() string { return "nigafiy-endpoint-agent" }

// DefaultStateDir: /var/lib/nigafiy/endpoint-agent.
func DefaultStateDir() string { return "/var/lib/nigafiy/endpoint-agent" }

var unitDir = "/etc/systemd/system"

func unitPath(name string) string { return filepath.Join(unitDir, name+".service") }

// systemdQuote quotes one ExecStart word: double quotes with \ and " escaped, % and $ doubled
// (systemd's specifier and variable expansion).
func systemdQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, `$`, `$$`)
	return `"` + r.Replace(s) + `"`
}

// UnitFile is the systemd unit for spec.
func UnitFile(spec Spec) string {
	words := []string{systemdQuote(spec.Exe)}
	for _, a := range spec.Args {
		words = append(words, systemdQuote(a))
	}
	return fmt.Sprintf(`[Unit]
Description=%s
Documentation=https://nigafiy.com/docs/endpoint-agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=%s
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`, DisplayName, strings.Join(words, " "))
}

// Install writes the unit and enables it (and starts it when start is set).
func Install(spec Spec, start bool) error {
	if err := ValidName(spec.Name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	p := unitPath(spec.Name)
	if _, err := os.Stat(p); err == nil {
		return fmt.Errorf("%s already exists (uninstall first)", p)
	}
	if err := os.WriteFile(p, []byte(UnitFile(spec)), 0o644); err != nil {
		return err
	}
	if err := runTool("systemctl", "daemon-reload"); err != nil {
		return err
	}
	args := []string{"enable"}
	if start {
		args = append(args, "--now")
	}
	return runTool("systemctl", append(args, spec.Name+".service")...)
}

// Uninstall stops and disables the unit and removes its file.
func Uninstall(name string) error {
	if err := ValidName(name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	p := unitPath(name)
	if _, err := os.Stat(p); err != nil {
		return fmt.Errorf("no unit %s is installed", p)
	}
	_ = runTool("systemctl", "disable", "--now", name+".service")
	if err := os.Remove(p); err != nil {
		return err
	}
	return runTool("systemctl", "daemon-reload")
}

// DefaultInstallDir: /opt/nigafiy-agent (install copies the agent there).
func DefaultInstallDir() string { return "/opt/nigafiy-agent" }

// Exists reports whether the unit file is installed.
func Exists(name string) (bool, error) { return SystemController{}.Exists(name) }

// SystemController is systemd (Controller for the in-place upgrade).
type SystemController struct{}

func (SystemController) Exists(name string) (bool, error) {
	_, err := os.Stat(unitPath(name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// BinaryPath is the first word of the unit's ExecStart (as UnitFile writes it).
func (SystemController) BinaryPath(name string) (string, error) {
	raw, err := os.ReadFile(unitPath(name))
	if err != nil {
		return "", err
	}
	return ExecStartBinary(string(raw))
}

func (SystemController) Stop(name string, _ time.Duration) error {
	// systemctl stop waits for the unit to stop (TimeoutStopSec in the unit).
	return runTool("systemctl", "stop", name+".service")
}

func (SystemController) Start(name string) error {
	return runTool("systemctl", "start", name+".service")
}

func (SystemController) Running(name string) (bool, error) {
	out, err := exec.Command("systemctl", "is-active", name+".service").Output()
	if strings.TrimSpace(string(out)) == "active" {
		return true, nil
	}
	if _, ok := err.(*exec.ExitError); ok {
		return false, nil
	}
	return false, err
}

// ExecStartBinary reads the program from a unit file's ExecStart line: the first word, unquoted
// the way systemdQuote quoted it.
func ExecStartBinary(unit string) (string, error) {
	for _, line := range strings.Split(unit, "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if !strings.HasPrefix(v, `"`) {
			if f := strings.Fields(v); len(f) > 0 {
				return f[0], nil
			}
			break
		}
		var b strings.Builder
		for i := 1; i < len(v); i++ {
			switch c := v[i]; {
			case c == '\\' && i+1 < len(v):
				i++
				b.WriteByte(v[i])
			case c == '"':
				return strings.NewReplacer("%%", "%", "$$", "$").Replace(b.String()), nil
			default:
				b.WriteByte(c)
			}
		}
		return "", errors.New("unterminated quote in ExecStart")
	}
	return "", errors.New("the unit has no ExecStart line")
}
