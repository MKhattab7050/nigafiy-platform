//go:build !windows && !linux

package smart

import "context"

// ReadWiFi is not available on this platform: macOS only reveals SSIDs and BSSIDs to apps the
// user has granted location access, which a background collector does not have.
func ReadWiFi(context.Context) (WiFiReport, error) {
	return WiFiReport{}, &WiFiError{Kind: "not_supported", Message: "the Wi-Fi analyzer runs on Windows and Linux collectors"}
}
