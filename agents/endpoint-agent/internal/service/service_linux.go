//go:build linux

package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
