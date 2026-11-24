package monitor

import "strings"

// SystemctlState maps `systemctl is-active` output (it exits non-zero for anything but active).
func SystemctlState(out string) string {
	switch strings.TrimSpace(out) {
	case "active", "reloading":
		return "running"
	case "inactive", "failed", "dead":
		return "stopped"
	case "activating":
		return "starting"
	case "deactivating":
		return "stopping"
	case "unknown", "":
		// systemctl prints "inactive" for unknown units on old versions and nothing when it fails.
		return "not_found"
	}
	return "unknown"
}

// LaunchctlState maps `launchctl list <label>`: an error means launchd has no such job; a "PID"
// line means it runs.
func LaunchctlState(out string, err error) string {
	if err != nil {
		if strings.Contains(out, "Could not find service") || strings.TrimSpace(out) == "" {
			return "not_found"
		}
		return "unknown"
	}
	if strings.Contains(out, "\"PID\" = ") {
		return "running"
	}
	return "stopped"
}
