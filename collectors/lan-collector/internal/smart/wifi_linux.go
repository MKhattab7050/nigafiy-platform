//go:build linux

package smart

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Linux: NetworkManager's nmcli in terse mode (machine-readable, not translated). The list is
// NetworkManager's cached scan; `--rescan no` makes sure no scan is triggered.
func ReadWiFi(ctx context.Context) (WiFiReport, error) {
	path, err := exec.LookPath("nmcli")
	if err != nil {
		return WiFiReport{}, &WiFiError{Kind: "not_supported", Message: "NetworkManager (nmcli) is not installed; the Wi-Fi analyzer reads Wi-Fi through it on Linux"}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-t", "-f", "IN-USE,SSID,BSSID,FREQ,SIGNAL,SECURITY,RATE", "device", "wifi", "list", "--rescan", "no")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "LANG=C")
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && strings.Contains(strings.ToLower(string(exit.Stderr)), "no wi-fi device") {
			return WiFiReport{}, ErrNoWiFi
		}
		return WiFiReport{}, &WiFiError{Kind: "command_failed", Message: cleanText("nmcli failed: "+err.Error(), 300)}
	}
	r, err := ParseNmcliWifi(string(out))
	if err != nil {
		return r, &WiFiError{Kind: "protocol", Message: err.Error()}
	}
	if !r.Connected && len(r.Networks) == 0 {
		return r, ErrNoWiFi
	}
	return r, nil
}
