//go:build !windows

package update

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

// CheckAuthenticode is Windows only.
func CheckAuthenticode(string) (Signature, error) {
	return Signature{}, errors.New("Authenticode signatures can only be checked on Windows")
}

// WaitExit polls until pid has exited.
func WaitExit(pid int, timeout time.Duration) error {
	end := time.Now().Add(timeout)
	for {
		if err := syscall.Kill(pid, 0); err != nil {
			return nil
		}
		if timeout > 0 && time.Now().After(end) {
			return fmt.Errorf("process %d still running after %s", pid, timeout)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// RunInstaller is Windows only: the update installer is an NSIS installer.
func RunInstaller(string, []string) (int, error) {
	return -1, errors.New("installing updates is only supported on Windows")
}

// StartDetached starts a program in its own session.
func StartDetached(path string, args []string, env []string) (int, error) {
	cmd := exec.Command(path, args...)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	cmd.Process.Release()
	return pid, nil
}
