//go:build !windows && !darwin

package remotedesktop

import "os"

// Backend names the capture/input mechanism of this Linux session.
func Backend() string {
	if os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		return "wayland-portal"
	}
	return "x11"
}

// Permissions: Linux desktops ask through the portal itself (Wayland) or need nothing (X11).
func Permissions() map[string]string { return nil }
