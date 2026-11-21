package configbackup

import (
	"context"
	"io"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// shell is an interactive CLI session on a pseudo-terminal: most network CLIs only behave
// normally (prompt, enable, pager control) on one.
type shell struct {
	session *ssh.Session
	stdin   io.WriteCloser
	chunks  chan []byte
	opts    Options
	closed  bool
}

const (
	ptyRows      = 512
	ptyCols      = 511
	loginQuiet   = 1200 * time.Millisecond
	enableQuiet  = 800 * time.Millisecond
	tailWindow   = 1024
	maxLoginKick = 3
)

var (
	passwordPromptRe = regexp.MustCompile(`(?i)(password|secret)\s*:\s*$`)
	anyKeyRe         = regexp.MustCompile(`(?i)press any key|press return|hit enter`)
)

func openShell(ctx context.Context, client *ssh.Client, opts Options) (*shell, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, ctxErr(ctx, fail(ErrProtocol, "the device refused a session: %s", clip(err.Error(), 160)))
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}
	if err := session.RequestPty("vt100", ptyRows, ptyCols, modes); err != nil {
		_ = session.Close()
		return nil, ctxErr(ctx, fail(ErrProtocol, "the device refused a terminal: %s", clip(err.Error(), 160)))
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, fail(ErrProtocol, "cannot open the session input")
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, fail(ErrProtocol, "cannot open the session output")
	}
	if err := session.Shell(); err != nil {
		_ = session.Close()
		return nil, ctxErr(ctx, fail(ErrProtocol, "the device refused an interactive shell: %s", clip(err.Error(), 160)))
	}
	sh := &shell{session: session, stdin: stdin, chunks: make(chan []byte, 64), opts: opts}
	go func() {
		defer close(sh.chunks)
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				sh.chunks <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return sh, nil
}

func (s *shell) close() {
	if s.closed {
		return
	}
	s.closed = true
	_ = s.stdin.Close()
	_ = s.session.Close()
	// Drain so the reader goroutine can finish.
	go func() {
		for range s.chunks {
		}
	}()
}

func (s *shell) write(text string) error {
	if _, err := io.WriteString(s.stdin, text); err != nil {
		return fail(ErrProtocol, "the device closed the session")
	}
	return nil
}

func tail(raw []byte) string {
	if len(raw) > tailWindow {
		raw = raw[len(raw)-tailWindow:]
	}
	return string(raw)
}

// read collects output until done reports true on the cleaned tail, or — with quiet > 0 — until the
// device has been silent for that long after sending something. A pager prompt is answered with a
// space. Output is bounded; a device silent for opts.Idle is a timeout.
func (s *shell) read(ctx context.Context, quiet time.Duration, done func(cleanTail string) bool) ([]byte, error) {
	var raw []byte
	limit := 2 * s.opts.MaxOutput // raw terminal output carries escapes and echo
	idle := time.NewTimer(s.opts.Idle)
	defer idle.Stop()
	var quietTimer *time.Timer
	var quietC <-chan time.Time
	defer func() {
		if quietTimer != nil {
			quietTimer.Stop()
		}
	}()
	pagerAnsweredAt := -1
	for {
		select {
		case b, ok := <-s.chunks:
			if !ok {
				return raw, fail(ErrProtocol, "the device closed the session")
			}
			raw = append(raw, b...)
			if len(raw) > limit {
				return raw, fail(ErrOutputTooLarge, "the device sent more than %d bytes", limit)
			}
			idle.Reset(s.opts.Idle)
			cleanTail := cleanTerminal(tail(raw))
			if len(raw) > pagerAnsweredAt && pagerTailRe.MatchString(screenLastLine(tail(raw))) {
				pagerAnsweredAt = len(raw)
				if err := s.write(" "); err != nil {
					return raw, err
				}
				continue
			}
			if done != nil && done(cleanTail) {
				return raw, nil
			}
			if quiet > 0 {
				if quietTimer == nil {
					quietTimer = time.NewTimer(quiet)
				} else {
					quietTimer.Reset(quiet)
				}
				quietC = quietTimer.C
			}
		case <-quietC:
			return raw, nil
		case <-idle.C:
			return raw, fail(ErrTimeout, "the device stopped answering for %s", s.opts.Idle)
		case <-ctx.Done():
			return raw, fail(ErrTimeout, "the backup did not finish within its time budget")
		}
	}
}

// learnPrompt reads the login output and returns the device's prompt and the text before it.
func (s *shell) learnPrompt(ctx context.Context) (prompt, login string, err error) {
	var all []byte
	quickIdle := s.opts
	for kick := 0; kick <= maxLoginKick; kick++ {
		sub := *s
		sub.opts = quickIdle
		if kick == 0 {
			sub.opts.Idle = minDuration(s.opts.Idle, 8*time.Second)
		} else {
			sub.opts.Idle = minDuration(s.opts.Idle, 5*time.Second)
		}
		raw, err := sub.read(ctx, loginQuiet, nil)
		all = append(all, raw...)
		if err != nil && KindOf(err) != ErrTimeout {
			return "", "", err
		}
		if ctx.Err() != nil {
			return "", "", fail(ErrTimeout, "the backup did not finish within its time budget")
		}
		text := cleanTerminal(string(all))
		ll := lastLine(text)
		switch {
		case ll != "" && anyKeyRe.MatchString(ll):
			if err := s.write("\n"); err != nil {
				return "", "", err
			}
		case ll != "" && looksLikePrompt(ll):
			login = strings.TrimSuffix(strings.TrimRight(text, " \n"), ll)
			return ll, clip(login, maxBannerBytes), nil
		default:
			// Nothing recognisable yet: an empty line makes most CLIs print their prompt.
			if err := s.write("\n"); err != nil {
				return "", "", err
			}
		}
	}
	return "", "", fail(ErrProtocol, "the device did not show a command prompt after login")
}

// screenLastLine is the last visible line of raw terminal output, pager prompts included.
func screenLastLine(t string) string {
	t = strings.ReplaceAll(ansiRe.ReplaceAllString(t, ""), "\r\n", "\n")
	lines := strings.Split(t, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(overwrite(lines[i])); l != "" {
			return l
		}
	}
	return ""
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

var promptEndRe = regexp.MustCompile(`[>#$%\]]$`)

func looksLikePrompt(line string) bool {
	line = strings.TrimSpace(line)
	return len(line) <= 120 && (promptFamily(line) != "" || promptEndRe.MatchString(line)) && !passwordPromptRe.MatchString(line)
}

// run sends one command and returns its output (without echo and prompt).
func (s *shell) run(ctx context.Context, cmd, prompt string) (string, error) {
	if err := s.write(cmd + "\n"); err != nil {
		return "", err
	}
	want := strings.TrimSpace(prompt)
	raw, err := s.read(ctx, 0, func(cleanTail string) bool { return strings.TrimSpace(lastLine(cleanTail)) == want })
	if err != nil {
		return "", err
	}
	return commandOutput(cleanTerminal(string(raw)), cmd, prompt), nil
}

// enable enters privileged mode with the enable secret and returns the new prompt.
func (s *shell) enable(ctx context.Context, secret string) (string, error) {
	if err := s.write("enable\n"); err != nil {
		return "", err
	}
	raw, err := s.read(ctx, 0, func(cleanTail string) bool {
		ll := lastLine(cleanTail)
		return passwordPromptRe.MatchString(ll) || strings.HasSuffix(strings.TrimSpace(ll), "#")
	})
	if err != nil {
		return "", err
	}
	if ll := lastLine(cleanTerminal(string(raw))); strings.HasSuffix(strings.TrimSpace(ll), "#") {
		return strings.TrimSpace(ll), nil // no secret asked
	}
	if err := s.write(secret + "\n"); err != nil {
		return "", err
	}
	raw, err = s.read(ctx, enableQuiet, func(cleanTail string) bool {
		ll := strings.TrimSpace(lastLine(cleanTail))
		return passwordPromptRe.MatchString(ll) || promptFamily(ll) != ""
	})
	if err != nil {
		return "", err
	}
	ll := strings.TrimSpace(lastLine(cleanTerminal(string(raw))))
	if !strings.HasSuffix(ll, "#") {
		return "", fail(ErrAuthFailed, "the device rejected the enable secret")
	}
	return ll, nil
}
