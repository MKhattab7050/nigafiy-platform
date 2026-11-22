//go:build !windows

package userui

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// Linux and macOS: the dialogs are the desktop's own dialog tools, run in the user's session (the
// agent runs there itself, or its session helper does: see internal/desktop).

type unixUI struct {
	mu       sync.Mutex
	banner   *exec.Cmd
	session  string
	lookPath func(string) (string, error)
	goos     string
}

func newPlatformUI() UI { return &unixUI{lookPath: exec.LookPath, goos: runtime.GOOS} }

// Consent runs the dialog tool; the exit status / output says what the person chose.
func (u *unixUI) Consent(ctx context.Context, req ConsentRequest) (ConsentAnswer, error) {
	req = req.Normalize()
	tool, args, err := ConsentCommand(u.goos, req, u.lookPath)
	if err != nil {
		return "", err
	}
	cctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutSeconds+2)*time.Second)
	defer cancel()
	out, runErr := exec.CommandContext(cctx, tool, args...).Output()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	code := 0
	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		code = ee.ExitCode()
	} else if runErr != nil && cctx.Err() == nil {
		return "", runErr
	}
	return InterpretConsent(tool, string(out), code, cctx.Err() != nil), nil
}

func (u *unixUI) ShowBanner(info BannerInfo, onEnd func()) error {
	info = info.Normalize()
	tool, args, err := BannerCommand(u.goos, info, u.lookPath)
	if err != nil {
		return err
	}
	u.HideBanner("")
	cmd := exec.Command(tool, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	u.mu.Lock()
	u.banner, u.session = cmd, info.SessionID
	u.mu.Unlock()
	go func() {
		err := cmd.Wait()
		u.mu.Lock()
		mine := u.banner == cmd
		if mine {
			u.banner = nil
		}
		u.mu.Unlock()
		// The dialog closed by itself (not killed by HideBanner): the person pressed End session.
		if mine && onEnd != nil && BannerEndedByUser(err) {
			onEnd()
		}
	}()
	return nil
}

func (u *unixUI) HideBanner(sessionID string) {
	u.mu.Lock()
	cmd := u.banner
	if cmd != nil && (sessionID == "" || sessionID == u.session) {
		u.banner = nil
	} else {
		cmd = nil
	}
	u.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
