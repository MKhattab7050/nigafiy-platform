package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Controller is the part of the operating system's service manager the in-place upgrade uses.
// The real ones are the Windows Service Control Manager, systemd and launchd (SystemController);
// tests use a fake, so no real service is ever touched by them.
type Controller interface {
	// Exists reports whether a service of that name is installed.
	Exists(name string) (bool, error)
	// BinaryPath is the program the installed service starts.
	BinaryPath(name string) (string, error)
	// Stop stops the service and waits until it has stopped (at most timeout).
	Stop(name string, timeout time.Duration) error
	// Start starts the service.
	Start(name string) error
	// Running reports whether the service manager reports it running.
	Running(name string) (bool, error)
}

// HealthFile is the agent's own health marker in its state directory: written by the running
// agent when it starts (after its stored credential was loaded) and after every heartbeat the
// server accepted. The upgrade waits for the new version's marker.
const HealthFile = "health.json"

// Health is the content of HealthFile.
type Health struct {
	Version   string    `json:"version"`
	PID       int       `json:"pid"`
	StartedAt time.Time `json:"started_at"`
	// LastHeartbeatAt is the last heartbeat the server accepted (zero before the first one).
	LastHeartbeatAt time.Time `json:"last_heartbeat_at"`
}

// WriteHealth writes the marker atomically (temporary file, then rename).
func WriteHealth(stateDir string, h Health) error {
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	p := filepath.Join(stateDir, HealthFile)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// ReadHealth reads the marker.
func ReadHealth(stateDir string) (Health, error) {
	var h Health
	raw, err := os.ReadFile(filepath.Join(stateDir, HealthFile))
	if err != nil {
		return h, err
	}
	err = json.Unmarshal(raw, &h)
	return h, err
}

// Upgrade replaces the binary of an installed agent service with this one, in place:
//
//  1. checks that the service exists, that this program is not the installed file itself and
//     that the endpoint is enrolled (credential.json in the state directory): an upgrade never
//     enrolls, and the credential is never touched;
//  2. stops the service;
//  3. renames the installed binary to <name>.previous<ext> (the rollback copy) and copies this
//     program into its place;
//  4. starts the service and waits until the service manager reports it running AND the new
//     version has written its health marker (started after step 2), within Timeout;
//  5. otherwise rolls back: stops it, puts the previous binary back, starts it again, and returns
//     an error that says so.
//
// The service's command line (server, pin, state directory) is not changed.
type Upgrade struct {
	Name string
	// NewExe is the new agent binary (the running program).
	NewExe string
	// Version is NewExe's version: the health marker must name it.
	Version string
	// StateDir holds the credential and the health marker.
	StateDir string
	// InstallDir, when set, must be the folder of the binary the service runs.
	InstallDir string
	Ctl        Controller
	// Timeout for the new version to come up (default 90 s); StopTimeout for each stop (30 s).
	Timeout     time.Duration
	StopTimeout time.Duration
	// Poll interval while waiting (default 1 s).
	Poll time.Duration
	Out  io.Writer
	// Now and Sleep are replaced in tests.
	Now   func() time.Time
	Sleep func(time.Duration)
	// Copy is CopyFile unless a test replaces it.
	Copy func(src, dst string) error
}

// ErrRolledBack: the new version did not come up and the previous one was put back.
var ErrRolledBack = errors.New("the new version did not come up; the previous version was put back")

// Result describes a finished upgrade.
type Result struct {
	Binary   string
	Previous string
	// Heartbeat is true when the new version already had a heartbeat accepted by the server.
	Heartbeat bool
}

func (u *Upgrade) defaults() {
	if u.Timeout == 0 {
		u.Timeout = 90 * time.Second
	}
	if u.StopTimeout == 0 {
		u.StopTimeout = 30 * time.Second
	}
	if u.Poll == 0 {
		u.Poll = time.Second
	}
	if u.Out == nil {
		u.Out = io.Discard
	}
	if u.Now == nil {
		u.Now = time.Now
	}
	if u.Sleep == nil {
		u.Sleep = time.Sleep
	}
	if u.Copy == nil {
		u.Copy = CopyFile
	}
}

// Run performs the upgrade.
func (u *Upgrade) Run() (Result, error) {
	u.defaults()
	var res Result
	if err := ValidName(u.Name); err != nil {
		return res, err
	}
	ok, err := u.Ctl.Exists(u.Name)
	if err != nil {
		return res, err
	}
	if !ok {
		return res, fmt.Errorf("no service named %s is installed: use install for a first installation", u.Name)
	}
	target, err := u.Ctl.BinaryPath(u.Name)
	if err != nil {
		return res, fmt.Errorf("read the service's program path: %w", err)
	}
	if u.InstallDir != "" && !SamePath(filepath.Dir(target), u.InstallDir) {
		return res, fmt.Errorf("the %s service runs %s, which is not in %s; run the upgrade with -install-dir %q", u.Name, target, u.InstallDir, filepath.Dir(target))
	}
	if SamePath(u.NewExe, target) {
		return res, fmt.Errorf("this program is the installed binary %s: run the upgrade from the new version's file", target)
	}
	if _, err := os.Stat(filepath.Join(u.StateDir, "credential.json")); err != nil {
		return res, fmt.Errorf("this endpoint has no stored credential in %s, so there is nothing to upgrade in place (an upgrade never enrolls): uninstall the service and install with a new enrollment token", u.StateDir)
	}
	previous := PreviousName(target)
	res.Binary, res.Previous = target, previous

	began := u.Now()
	fmt.Fprintf(u.Out, "Stopping the %s service\n", u.Name)
	if err := u.Ctl.Stop(u.Name, u.StopTimeout); err != nil {
		return res, fmt.Errorf("stop the service: %w", err)
	}
	restartOld := func(cause error) error {
		if err := u.Ctl.Start(u.Name); err != nil {
			return fmt.Errorf("%w; starting the unchanged service again also failed: %v", cause, err)
		}
		return cause
	}
	_ = os.Remove(previous)
	if err := os.Rename(target, previous); err != nil {
		return res, restartOld(fmt.Errorf("keep the installed binary as %s: %w", previous, err))
	}
	if err := u.Copy(u.NewExe, target); err != nil {
		if rerr := os.Rename(previous, target); rerr != nil {
			return res, fmt.Errorf("copy the new binary: %w; putting the previous one back failed too: %v (it is %s)", err, rerr, previous)
		}
		return res, restartOld(fmt.Errorf("copy the new binary: %w", err))
	}
	fmt.Fprintf(u.Out, "Starting the %s service (version %s)\n", u.Name, u.Version)
	startErr := u.Ctl.Start(u.Name)
	var hb bool
	var why string
	if startErr != nil {
		why = "the service did not start: " + startErr.Error()
	} else {
		hb, why = u.waitHealthy(began)
	}
	if why == "" {
		res.Heartbeat = hb
		return res, nil
	}

	fmt.Fprintf(u.Out, "The new version did not come up (%s); putting the previous version back\n", why)
	_ = u.Ctl.Stop(u.Name, u.StopTimeout)
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return res, fmt.Errorf("%w (%s), but the new binary could not be removed: %v; the previous one is %s", ErrRolledBack, why, err, previous)
	}
	if err := os.Rename(previous, target); err != nil {
		return res, fmt.Errorf("the new version did not come up (%s) and the previous binary could not be put back: %v; it is %s", why, err, previous)
	}
	if err := u.Ctl.Start(u.Name); err != nil {
		return res, fmt.Errorf("%w (%s), but the previous version did not start either: %v", ErrRolledBack, why, err)
	}
	return res, fmt.Errorf("%w (%s)", ErrRolledBack, why)
}

// waitHealthy waits for "running" from the service manager and a health marker of the new
// version that was written after the upgrade began. why is "" on success.
func (u *Upgrade) waitHealthy(began time.Time) (heartbeat bool, why string) {
	deadline := u.Now().Add(u.Timeout)
	running := false
	for {
		r, err := u.Ctl.Running(u.Name)
		running = err == nil && r
		if running {
			if h, err := ReadHealth(u.StateDir); err == nil && h.Version == u.Version && h.PID > 0 && !h.StartedAt.Before(began.Add(-2*time.Second)) {
				return !h.LastHeartbeatAt.IsZero() && !h.LastHeartbeatAt.Before(h.StartedAt), ""
			}
		}
		if !u.Now().Before(deadline) {
			break
		}
		u.Sleep(u.Poll)
	}
	if !running {
		return false, fmt.Sprintf("the service manager does not report it running after %s", u.Timeout)
	}
	return false, fmt.Sprintf("version %s did not write its health marker within %s", u.Version, u.Timeout)
}
