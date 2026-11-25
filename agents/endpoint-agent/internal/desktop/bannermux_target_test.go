package desktop

import (
	"image"
	"strings"
	"testing"

	"github.com/nigafiy/agent/internal/remotedesktop"
)

// targeting is a desktop that can move to another Windows session (as the service's Supervisor).
type targeting struct {
	Desktop
	got []string
}

func (t *targeting) TargetSession(s string) error {
	t.got = append(t.got, s)
	return nil
}

type sessionTargeter interface{ TargetSession(string) error }

// The real agent wraps its desktop in a BannerMux: switching Windows user sessions (and the
// sign-in screen) must still reach the wrapped desktop.
func TestBannerMuxPassesSessionTargetingThrough(t *testing.T) {
	inner := &targeting{Desktop: NewLocalWith(nil, func(int) (*image.RGBA, []remotedesktop.DisplayInfo, int, string, error) {
		return image.NewRGBA(image.Rect(0, 0, 8, 8)), nil, 0, "test", nil
	})}
	var d Desktop = NewBannerMux(inner)
	st, ok := d.(sessionTargeter)
	if !ok {
		t.Fatal("BannerMux hides TargetSession")
	}
	if err := st.TargetSession("winlogon"); err != nil {
		t.Fatal(err)
	}
	if err := st.TargetSession(""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(inner.got, ",") != "winlogon," {
		t.Fatalf("wrapped desktop got %q", inner.got)
	}

	// A desktop that cannot switch sessions: the console's session is fine, any other is refused
	// with the same code as before.
	plain, ok := Desktop(NewBannerMux(noVideo{inner.Desktop})).(sessionTargeter)
	if !ok {
		t.Fatal("BannerMux hides TargetSession")
	}
	if err := plain.TargetSession(""); err != nil {
		t.Fatalf("back to the console: %v", err)
	}
	if err := plain.TargetSession("3"); err == nil || !strings.HasPrefix(err.Error(), "user_session_needs_service:") {
		t.Fatalf("another session without the service: %v", err)
	}
}
