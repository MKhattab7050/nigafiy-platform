//go:build windows

package filemgr

import (
	"strings"
	"testing"
)

// The agent service runs as SYSTEM: its home is under System32\config, which the guards forbid.
func TestWindowsHomeAvoidsForbiddenProfile(t *testing.T) {
	t.Setenv("USERPROFILE", `C:\Windows\System32\config\systemprofile`)
	h := windowsHome()
	if h == "" || isForbiddenCredentialPath(h) {
		t.Fatalf("home %q is empty or forbidden", h)
	}
	if !strings.HasSuffix(strings.ToLower(h), `\users`) {
		t.Fatalf("home %q, want the Users folder", h)
	}
}
