//go:build !windows

package userui

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// Linux and macOS: the chat and the questions use the desktop's dialog tools. The privacy screen,
// the annotation overlay and Ctrl+Alt+Shift+E need native windows and a global hotkey that the
// dialog tools cannot provide without cgo, so they are refused with the reason.

var errNoPrivacy = fmt.Errorf("the privacy screen is supported on Windows only: %w", ErrToolUnsupported)
var errNoOverlay = fmt.Errorf("annotations and the laser pointer are supported on Windows only: %w", ErrToolUnsupported)

func (u *unixUI) PrivacyScreen(_ string, on bool, _ BannerInfo) (PrivacyResult, error) {
	if !on {
		return PrivacyResult{}, nil
	}
	return PrivacyResult{}, errNoPrivacy
}

func (u *unixUI) runAsk(ctx context.Context, r AskRequest, chat bool) (AskAnswer, error) {
	r = r.Normalize()
	tool, args, err := AskCommand(u.goos, r, chat, u.lookPath)
	if err != nil {
		return AskAnswer{}, err
	}
	cctx, cancel := context.WithTimeout(ctx, time.Duration(r.TimeoutSeconds+2)*time.Second)
	defer cancel()
	out, runErr := exec.CommandContext(cctx, tool, args...).Output()
	if ctx.Err() != nil {
		return AskAnswer{}, ctx.Err()
	}
	code := 0
	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		code = ee.ExitCode()
	} else if runErr != nil && cctx.Err() == nil {
		return AskAnswer{}, runErr
	}
	kind := r.Kind
	if chat {
		kind = "text"
	}
	return InterpretAsk(tool, kind, string(out), code, cctx.Err() != nil), nil
}

// Chat: each operator message is a dialog with an optional reply.
func (u *unixUI) Chat(sessionID string, line ChatLine, onReply func(string)) error {
	if _, _, err := AskCommand(u.goos, AskRequest{}, true, u.lookPath); err != nil {
		return err
	}
	go func() {
		a, err := u.runAsk(context.Background(), AskRequest{SessionID: sessionID, Operator: line.From, Text: line.Text, TimeoutSeconds: 600}, true)
		if err == nil && a.Answer == "text" && a.Text != "" && onReply != nil {
			onReply(a.Text)
		}
	}()
	return nil
}

func (u *unixUI) CloseChat(string) {}

func (u *unixUI) Ask(ctx context.Context, r AskRequest) (AskAnswer, error) {
	return u.runAsk(ctx, r, false)
}

func (u *unixUI) Overlay(string, OverlayOp) error { return errNoOverlay }
func (u *unixUI) CloseOverlay(string)             {}
func (u *unixUI) EndHotkey() string               { return "unsupported" }

var _ ToolUI = (*unixUI)(nil)
