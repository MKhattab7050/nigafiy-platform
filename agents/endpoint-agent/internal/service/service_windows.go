//go:build windows

package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/lan-detective/endpoint-agent/internal/desktop"
)

// DefaultName is the Windows service name.
func DefaultName() string { return "NigafiyEndpointAgent" }

// DefaultStateDir: %ProgramData%\Nigafiy\EndpointAgent.
func DefaultStateDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "Nigafiy", "EndpointAgent")
}

// stateDirSDDL: SYSTEM and Administrators only, not inherited from %ProgramData% (whose default
// ACL lets every user read). The credential in it is the endpoint's identity; the session helper,
// which runs as the signed-in user, cannot read it.
const stateDirSDDL = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// PrepareStateDir creates the state directory with an ACL that only SYSTEM and Administrators
// can use.
func PrepareStateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(stateDirSDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// IsPrivileged: this process runs with an elevated (administrator) token.
func IsPrivileged() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// InService: this process was started by the Service Control Manager.
func InService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// Install registers the service: automatic (delayed) start as LocalSystem, restarted by the SCM
// after a crash. It refuses when a service of that name exists.
func Install(spec Spec, start bool) error {
	if err := ValidName(spec.Name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("open the service manager: %w", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(spec.Name); err == nil {
		s.Close()
		return fmt.Errorf("a service named %s is already installed (uninstall it first)", spec.Name)
	}
	s, err := m.CreateService(spec.Name, spec.Exe, mgr.Config{
		DisplayName:      DisplayName,
		Description:      Description,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ErrorControl:     mgr.ErrorNormal,
	}, spec.Args...)
	if err != nil {
		return fmt.Errorf("create the service: %w", err)
	}
	defer s.Close()
	err = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 2 * time.Minute},
	}, uint32((24 * time.Hour).Seconds()))
	if err != nil {
		_ = s.Delete()
		return fmt.Errorf("set the service's restart policy: %w", err)
	}
	if start {
		if err := s.Start(); err != nil {
			return fmt.Errorf("the service was installed but did not start: %w", err)
		}
	}
	return nil
}

// Uninstall stops the service (waiting up to 30 s) and removes it.
func Uninstall(name string) error {
	if err := ValidName(name); err != nil {
		return err
	}
	if !IsPrivileged() {
		return ErrNotPrivileged
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("open the service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("no service named %s is installed", name)
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err == nil {
			deadline := time.Now().Add(30 * time.Second)
			for time.Now().Before(deadline) {
				if st, err := s.Query(); err != nil || st.State == svc.Stopped {
					break
				}
				time.Sleep(300 * time.Millisecond)
			}
		}
	}
	if err := s.Delete(); err != nil {
		return fmt.Errorf("remove the service: %w", err)
	}
	return nil
}

// HelperLauncher: in the service (session 0, LocalSystem), the helper is started in the active
// console session with the signed-in user's token; run from a prompt, it is a plain child process
// in this session.
func HelperLauncher(exe string, log *slog.Logger) desktop.Launcher {
	if InService() {
		return &WTSLauncher{Exe: exe, Args: HelperArgs(), Log: log}
	}
	return desktop.ExecLauncher{Path: exe, Args: HelperArgs(), Desc: "child process in this desktop session"}
}

// Session-change events that can move the console to another user or session.
const (
	wtsConsoleConnect    = 0x1
	wtsConsoleDisconnect = 0x2
	wtsSessionLogon      = 0x5
	wtsSessionLogoff     = 0x6
)

// restartWanted: the session-change events after which the helper may be in the wrong session.
func restartWanted(event uint32) bool {
	switch event {
	case wtsConsoleConnect, wtsConsoleDisconnect, wtsSessionLogon, wtsSessionLogoff:
		return true
	}
	return false
}

type handler struct {
	run       func(ctx context.Context) error
	onSession func(event uint32)
	log       *slog.Logger
}

func (h *handler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange
	s <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	s <- svc.Status{State: svc.Running, Accepts: accepts}
	for {
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				h.log.Error("endpoint agent stopped with an error", "error", err.Error())
				// A service-specific exit code makes the SCM apply the restart policy.
				return true, 1
			}
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(20 * time.Second):
					h.log.Warn("the agent did not stop within 20 seconds")
				}
				return false, 0
			case svc.SessionChange:
				if h.onSession != nil {
					h.onSession(c.EventType)
				}
			}
		}
	}
}

// Run runs the agent: under the Service Control Manager when started by it (stop, shutdown and
// session-change events), otherwise in the foreground until Ctrl+C.
func Run(name string, log *slog.Logger, sup *desktop.Supervisor, l desktop.Launcher, run func(ctx context.Context) error) error {
	watched := func(ctx context.Context) error {
		go Watch(ctx, sup, l, 10*time.Second, log)
		return run(ctx)
	}
	if !InService() {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return watched(ctx)
	}
	h := &handler{run: watched, log: log, onSession: func(event uint32) {
		if !restartWanted(event) || sup == nil {
			return
		}
		if t, ok := l.(SessionTracker); ok && !t.Stale() {
			return
		}
		log.Info("console session changed; restarting the session helper", "event", event)
		sup.Restart()
	}}
	return svc.Run(name, h)
}
