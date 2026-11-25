package desktop

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
)

// Launcher starts one session helper and returns its pipe (helper's stdout to read, stdin to
// write) and a function that stops it.
type Launcher interface {
	Launch(ctx context.Context) (io.ReadWriteCloser, func(), error)
	// Describe says where helpers are started (for logs and the operator's diagnostics).
	Describe() string
}

// Supervisor is a Desktop backed by a session helper that it (re)starts when needed: on first use,
// after the helper exited (sign-out, crash) and after Restart (the console session changed). An
// active session banner is shown again on the new helper, so a restart never leaves a session
// without its banner.
type Supervisor struct {
	launcher Launcher
	log      *slog.Logger

	mu         sync.Mutex
	client     *HelperClient
	stop       func()
	lastLaunch time.Time
	lastErr    error
	launching  chan struct{}
	banner     *bannerState
	toolEvents func(ToolEvent, []byte)
}

type bannerState struct {
	info  userui.BannerInfo
	onEnd func()
}

func NewSupervisor(l Launcher, log *slog.Logger) *Supervisor {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Supervisor{launcher: l, log: log}
}

const relaunchGap = 2 * time.Second

func (s *Supervisor) get() (*HelperClient, error) {
	for {
		s.mu.Lock()
		if s.client != nil {
			select {
			case <-s.client.Done():
				s.client, s.stop = nil, nil
			default:
				c := s.client
				s.mu.Unlock()
				return c, nil
			}
		}
		if s.launching != nil {
			// Another call is starting the helper (a session opening asks for the banner, the
			// displays and a frame at once): wait for it instead of failing.
			ch := s.launching
			s.mu.Unlock()
			<-ch
			continue
		}
		if !s.lastLaunch.IsZero() && time.Since(s.lastLaunch) < relaunchGap {
			err := s.lastErr
			s.mu.Unlock()
			if err == nil {
				err = ErrHelperGone
			}
			return nil, err
		}
		s.lastLaunch = time.Now()
		ch := make(chan struct{})
		s.launching = ch
		s.mu.Unlock()

		c, b, err := s.launch()
		s.mu.Lock()
		s.launching = nil
		s.mu.Unlock()
		close(ch)
		if err != nil {
			return nil, err
		}
		if b != nil {
			if err := c.ShowBanner(b.info, b.onEnd); err != nil {
				s.log.Warn("session banner could not be shown again on the new helper", "error", err.Error())
			}
		}
		return c, nil
	}
}

// launch starts a helper and checks it answers; the caller holds the launching slot.
func (s *Supervisor) launch() (*HelperClient, *bannerState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	rwc, stop, err := s.launcher.Launch(ctx)
	if err != nil {
		s.mu.Lock()
		s.lastErr = err
		s.mu.Unlock()
		s.log.Warn("session helper could not be started", "where", s.launcher.Describe(), "error", err.Error())
		return nil, nil, err
	}
	c := NewHelperClient(rwc)
	if err := c.Ping(); err != nil {
		stop()
		s.mu.Lock()
		s.lastErr = err
		s.mu.Unlock()
		return nil, nil, err
	}
	s.mu.Lock()
	s.client, s.stop, s.lastErr = c, stop, nil
	b := s.banner
	c.SetToolEvents(s.toolEvents)
	s.mu.Unlock()
	s.log.Info("session helper started", "where", s.launcher.Describe())
	return c, b, nil
}

// Restart stops the current helper; the next call starts one in the (new) active session.
func (s *Supervisor) Restart() {
	s.mu.Lock()
	stop := s.stop
	s.client, s.stop = nil, nil
	s.lastLaunch = time.Time{}
	hasBanner := s.banner != nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
	if hasBanner {
		// A session is open: bring the banner back on the new desktop at once.
		go func() { _, _ = s.get() }()
	}
}

func (s *Supervisor) Displays() ([]remotedesktop.DisplayInfo, error) {
	c, err := s.get()
	if err != nil {
		return nil, err
	}
	return c.Displays()
}

func (s *Supervisor) CaptureFrame(o remotedesktop.CaptureOptions) (remotedesktop.Frame, error) {
	c, err := s.get()
	if err != nil {
		return remotedesktop.Frame{}, err
	}
	return c.CaptureFrame(o)
}

func (s *Supervisor) Grab(stream string, req remotedesktop.GrabRequest) (*remotedesktop.EncodedFrame, error) {
	c, err := s.get()
	if err != nil {
		return nil, err
	}
	return c.Grab(stream, req)
}

func (s *Supervisor) ResetStream(stream string) {
	if c, err := s.get(); err == nil {
		c.ResetStream(stream)
	}
}

func (s *Supervisor) EndStream(stream string) {
	if c, err := s.get(); err == nil {
		c.EndStream(stream)
	}
}

func (s *Supervisor) Input(ev remotedesktop.InputEvent) error {
	c, err := s.get()
	if err != nil {
		return err
	}
	return c.Input(ev)
}

func (s *Supervisor) Consent(ctx context.Context, req userui.ConsentRequest) (userui.ConsentAnswer, error) {
	c, err := s.get()
	if err != nil {
		return "", err
	}
	return c.Consent(ctx, req)
}

func (s *Supervisor) ShowBanner(info userui.BannerInfo, onEnd func()) error {
	c, err := s.get()
	// Remembered even when no helper runs right now: the next helper shows it at start.
	s.mu.Lock()
	s.banner = &bannerState{info: info, onEnd: onEnd}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return c.ShowBanner(info, onEnd)
}

func (s *Supervisor) HideBanner(sessionID string) {
	s.mu.Lock()
	if s.banner != nil && (sessionID == "" || s.banner.info.SessionID == sessionID) {
		s.banner = nil
	}
	c := s.client
	s.mu.Unlock()
	if c != nil {
		c.HideBanner(sessionID)
	}
}

func (s *Supervisor) ClipboardText() (string, error) {
	c, err := s.get()
	if err != nil {
		return "", err
	}
	return c.ClipboardText()
}

func (s *Supervisor) SetClipboardText(t string) error {
	c, err := s.get()
	if err != nil {
		return err
	}
	return c.SetClipboardText(t)
}

func (s *Supervisor) Info() Info {
	c, err := s.get()
	if err != nil {
		return Info{Mode: "session_helper", Backend: "unavailable: " + err.Error()}
	}
	return c.Info()
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	stop := s.stop
	s.client, s.stop, s.banner = nil, nil, nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
	return nil
}

// ---------------------------------------------------------------------------------------------

// ExecLauncher starts the helper as a plain child process (same user). Used by the Linux/macOS
// launchers (with runuser / launchctl in front) and by tests.
type ExecLauncher struct {
	Path string
	Args []string
	Env  []string
	Desc string
}

type pipeRWC struct {
	io.Reader
	io.WriteCloser
	closeR func() error
}

func (p pipeRWC) Close() error {
	_ = p.WriteCloser.Close()
	if p.closeR != nil {
		_ = p.closeR()
	}
	return nil
}

func (l ExecLauncher) Describe() string {
	if l.Desc != "" {
		return l.Desc
	}
	return "child process " + l.Path
}

func (l ExecLauncher) Launch(_ context.Context) (io.ReadWriteCloser, func(), error) {
	if l.Path == "" {
		return nil, nil, errors.New("no helper program")
	}
	cmd := exec.Command(l.Path, l.Args...)
	if l.Env != nil {
		cmd.Env = l.Env
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	go func() { _ = cmd.Wait() }()
	stop := func() {
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
	return pipeRWC{Reader: stdout, WriteCloser: stdin, closeR: stdout.Close}, stop, nil
}

// Targeter is a Launcher that can start the helper in a chosen Windows session ("" = the
// console's, a session id, or "winlogon" = the sign-in screen of the console session).
type Targeter interface {
	SetTarget(session string) (changed bool, err error)
}

// ErrNeedsService: another Windows session or the sign-in screen without the LocalSystem service.
const ErrNeedsService = "user_session_needs_service: another Windows session or the sign-in screen needs the Nigafiy agent installed as a service"

// TargetSession moves the session helper (rdstream.SessionTargeter). Only the service's launcher
// can: anything else refuses a target other than the console's session.
func (s *Supervisor) TargetSession(session string) error {
	t, ok := s.launcher.(Targeter)
	if !ok {
		if session == "" {
			return nil
		}
		return errors.New(ErrNeedsService)
	}
	changed, err := t.SetTarget(session)
	if err != nil {
		return err
	}
	if changed {
		s.log.Info("session helper moves", "to", session)
		s.Restart()
	}
	return nil
}
