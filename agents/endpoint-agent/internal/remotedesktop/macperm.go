package remotedesktop

import (
	"encoding/json"
	"strings"
)

// macOS privacy permissions, read without cgo through the JavaScript-for-Automation bridge of
// osascript (it can call CoreGraphics and ApplicationServices functions):
//   CGPreflightScreenCaptureAccess() — Screen Recording (needed to capture the screen)
//   AXIsProcessTrusted()             — Accessibility (needed to inject mouse and keyboard)
// macOS attributes both to the responsible process (the agent), so the answer is the agent's.

// MacPermissionScript is the JXA program; it prints {"screen_recording":bool,"accessibility":bool}.
const MacPermissionScript = `ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices'); ` +
	`JSON.stringify({screen_recording: !!$.CGPreflightScreenCaptureAccess(), accessibility: !!$.AXIsProcessTrusted()})`

// ParseMacPermissions reads the script's output; anything unreadable is "unknown", never "granted".
func ParseMacPermissions(out string, err error) map[string]string {
	res := map[string]string{"screen_recording": "unknown", "accessibility": "unknown"}
	if err != nil {
		return res
	}
	var v map[string]bool
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &v) != nil {
		return res
	}
	for _, k := range []string{"screen_recording", "accessibility"} {
		if b, ok := v[k]; ok {
			if b {
				res[k] = "granted"
			} else {
				res[k] = "denied"
			}
		}
	}
	return res
}
