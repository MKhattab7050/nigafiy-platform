//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/nigafiy/engine/internal/control"
	"github.com/nigafiy/engine/internal/engine"
)

func isWindowsService() (bool, error) { return svc.IsWindowsService() }

// runAsService is the entry point when the Service Control Manager started the process. The
// service's command line is `run --data-dir=… …` (see serviceArgs).
func runAsService(args []string) error {
	if len(args) > 0 && args[0] == "run" {
		args = args[1:]
	}
	cfg, cfgErr := loadConfig(args, "service", io.Discard)
	h := &serviceHandler{run: func(ctx context.Context) error {
		if cfgErr != nil {
			return cfgErr
		}
		return engine.Run(ctx, cfg)
	}}
	return svc.Run(serviceName, h)
}

// serviceHandler adapts engine.Run to the Service Control Manager: Stop and Shutdown cancel the
// engine's context, which stops the Sensor, then the stack, then returns.
type serviceHandler struct {
	run func(ctx context.Context) error
}

const serviceStopHint = 60 * time.Second

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	running := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	status <- running

	for {
		select {
		case err := <-done:
			// The engine ended on its own (POST /v1/shutdown, or it could not start).
			return serviceExit(err, status)
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				cancel()
				checkpoint := uint32(1)
				pending := func() svc.Status {
					return svc.Status{State: svc.StopPending, CheckPoint: checkpoint, WaitHint: uint32(serviceStopHint / time.Millisecond)}
				}
				status <- pending()
				tick := time.NewTicker(5 * time.Second)
				defer tick.Stop()
				for {
					select {
					case err := <-done:
						return serviceExit(err, status)
					case <-tick.C:
						checkpoint++
						status <- pending()
					case r := <-requests:
						if r.Cmd == svc.Interrogate {
							status <- pending()
						}
					}
				}
			}
		}
	}
}

func serviceExit(err error, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StopPending}
	switch {
	case err == nil:
		return false, 0
	case errors.Is(err, engine.ErrAlreadyRunning):
		return true, exitAlreadyRunning
	default:
		return true, exitError
	}
}

func installService(args []string, stderr io.Writer) error {
	cfg, err := loadConfig(args, "service", stderr)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.Abs(exe); err != nil {
		return err
	}
	owner := cfg.OwnerSID
	if owner == "" {
		if owner, err = control.CurrentUserSID(); err != nil {
			return fmt.Errorf("could not read the current user's SID: %w", err)
		}
	}
	m, err := mgr.Connect()
	if err != nil {
		return adminHint(err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("service %s is already installed; run `nigafiy-engine uninstall` first", serviceName)
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName:  serviceDisplayName,
		Description:  serviceDescription,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, serviceArgs(cfg, owner)...)
	if err != nil {
		return adminHint(err)
	}
	defer s.Close()
	// Restart the engine if the service process itself crashes (its children are supervised by
	// the engine).
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.NoAction},
	}, uint32((24 * time.Hour).Seconds())); err != nil {
		fmt.Fprintf(stderr, "warning: could not set the service's recovery actions: %v\n", err)
	}
	return nil
}

func removeService() error {
	m, err := mgr.Connect()
	if err != nil {
		return adminHint(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service %s is not installed: %w", serviceName, err)
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		if err := stopAndWait(s); err != nil {
			return err
		}
	}
	return adminHint(s.Delete())
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return adminHint(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service %s is not installed: %w", serviceName, err)
	}
	defer s.Close()
	return adminHint(s.Start())
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return adminHint(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service %s is not installed: %w", serviceName, err)
	}
	defer s.Close()
	return stopAndWait(s)
}

func stopAndWait(s *mgr.Service) error {
	st, err := s.Control(svc.Stop)
	if err != nil {
		return adminHint(err)
	}
	deadline := time.Now().Add(2 * serviceStopHint)
	for st.State != svc.Stopped {
		if time.Now().After(deadline) {
			return fmt.Errorf("service %s did not stop within %s", serviceName, 2*serviceStopHint)
		}
		time.Sleep(300 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return err
		}
	}
	return nil
}

func adminHint(err error) error {
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return fmt.Errorf("%w (run this from an administrator command prompt)", err)
	}
	return err
}
