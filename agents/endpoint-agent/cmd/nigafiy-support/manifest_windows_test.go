//go:build windows && amd64

package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/nigafiy/agent/internal/winres"
	"golang.org/x/sys/windows"
)

// The committed rsrc_windows_amd64.syso must be the one the manifest gives (rerun go generate).
func TestManifestObjectIsUpToDate(t *testing.T) {
	m, err := os.ReadFile("nigafiy-support.manifest")
	if err != nil {
		t.Fatal(err)
	}
	want, err := winres.ManifestObject(m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("rsrc_windows_amd64.syso")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("rsrc_windows_amd64.syso is out of date: run go generate ./cmd/nigafiy-support")
	}
}

// The .syso is linked into this test program as it is into nigafiy-support.exe, so Windows
// applies the manifest to this process: it must start per-monitor (v2) DPI aware, which is what
// the Windows App Certification Kit's DPIAwarenessValidation looks for and what the screen
// capture expects (physical pixels on every monitor).
func TestManifestMakesTheProcessPerMonitorV2DPIAware(t *testing.T) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	getCtx := user32.NewProc("GetThreadDpiAwarenessContext")
	getAwareness := user32.NewProc("GetAwarenessFromDpiAwarenessContext")
	equal := user32.NewProc("AreDpiAwarenessContextsEqual")
	if getCtx.Find() != nil || getAwareness.Find() != nil || equal.Find() != nil {
		t.Skip("Windows before 10 1607: no DPI awareness context API")
	}
	ctx, _, _ := getCtx.Call()
	awareness, _, _ := getAwareness.Call(ctx)
	if awareness != 2 { // DPI_AWARENESS_PER_MONITOR_AWARE
		t.Fatalf("DPI awareness %d, want 2 (per monitor): the manifest was not applied", awareness)
	}
	perMonitorV2 := ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (DPI_AWARENESS_CONTEXT)-4
	if same, _, _ := equal.Call(ctx, perMonitorV2); same == 0 {
		t.Fatal("DPI awareness context is not PerMonitorV2")
	}
}
