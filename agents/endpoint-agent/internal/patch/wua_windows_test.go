//go:build windows

package patch

import (
	"context"
	"os"
	"testing"
	"time"
	"unsafe"
)

func TestVariantLayout(t *testing.T) {
	want := uintptr(16)
	if unsafe.Sizeof(uintptr(0)) == 8 {
		want = 24
	}
	if unsafe.Sizeof(variant{}) != want {
		t.Fatalf("VARIANT is %d bytes, want %d", unsafe.Sizeof(variant{}), want)
	}
	// DECIMAL 123456789 with scale 0.
	var v variant
	v.VT = vtDecimal
	v.Val = 123456789
	if v.int() != 123456789 {
		t.Fatalf("decimal: %d", v.int())
	}
}

// TestLiveWUAScan reads (never installs) the updates this computer is missing through the real
// Windows Update Agent. It contacts Windows Update, so it runs only with NIGAFIY_LIVE_WUA=1.
func TestLiveWUAScan(t *testing.T) {
	if os.Getenv("NIGAFIY_LIVE_WUA") != "1" {
		t.Skip("set NIGAFIY_LIVE_WUA=1 to search Windows Update for real (read-only)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	st := New().Scan(ctx)
	t.Logf("source=%s install_supported=%v reboot_pending=%v error=%q updates=%d", st.Source, st.InstallSupported, st.RebootPending, st.Error, len(st.Updates))
	for _, u := range st.Updates {
		t.Logf("  %s %s [%s/%s] %d bytes reboot=%v: %s", u.ID, u.KB, u.Classification, u.Severity, u.SizeBytes, u.RebootRequired, u.Title)
	}
	if st.Error != "" {
		t.Fatalf("scan failed: %s", st.Error)
	}
}
