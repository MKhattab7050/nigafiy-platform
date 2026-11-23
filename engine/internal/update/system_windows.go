//go:build windows

package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// CheckAuthenticode reads a file's Authenticode signature with the built-in PowerShell cmdlet
// Get-AuthenticodeSignature. The path is passed in the environment, never in the script text.
func CheckAuthenticode(path string) (Signature, error) {
	script := `$ErrorActionPreference='Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:NIGAFIY_VERIFY_PATH; ` +
		`$t = ''; if ($s.SignerCertificate) { $t = $s.SignerCertificate.Thumbprint }; ` +
		`[pscustomobject]@{ status = [string]$s.Status; thumbprint = [string]$t } | ConvertTo-Json -Compress`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), "NIGAFIY_VERIFY_PATH="+path)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.Output()
	if err != nil {
		return Signature{}, fmt.Errorf("Get-AuthenticodeSignature: %w", err)
	}
	var sig Signature
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &sig); err != nil {
		return Signature{}, fmt.Errorf("Get-AuthenticodeSignature output: %w", err)
	}
	sig.Thumbprint = strings.ToUpper(sig.Thumbprint)
	return sig, nil
}

// WaitExit waits until the process pid has exited (an already gone process counts as exited).
func WaitExit(pid int, timeout time.Duration) error {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil // no such process
		}
		return fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(h)
	ms := uint32(windows.INFINITE)
	if timeout > 0 {
		ms = uint32(timeout / time.Millisecond)
	}
	ev, err := windows.WaitForSingleObject(h, ms)
	if err != nil {
		return err
	}
	if ev == uint32(windows.WAIT_TIMEOUT) {
		return fmt.Errorf("process %d still running after %s", pid, timeout)
	}
	return nil
}

// RunInstaller runs the installer and waits for it. An installer that needs elevation (a per-machine
// installation, run by a standard user's engine) is started through the UAC prompt, which the
// person at the computer sees and must accept: nothing is elevated behind their back.
func RunInstaller(path string, args []string) (int, error) {
	cmd := exec.Command(path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exitErr):
		return exitErr.ExitCode(), nil
	case errors.Is(err, windows.ERROR_ELEVATION_REQUIRED):
		return runElevated(path, args)
	}
	return -1, err
}

func runElevated(path string, args []string) (int, error) {
	// Start-Process -Verb RunAs shows the UAC prompt; -Wait -PassThru returns the exit code. The
	// installer path and its arguments travel in the environment, not in the script text.
	script := `$ErrorActionPreference='Stop'; $p = Start-Process -FilePath $env:NIGAFIY_INSTALLER -ArgumentList $env:NIGAFIY_INSTALLER_ARGS -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), "NIGAFIY_INSTALLER="+path, "NIGAFIY_INSTALLER_ARGS="+strings.Join(args, " "))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	err := cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// StartDetached starts a program that outlives the engine: not in the engine's Job Object, no
// console, its own process group.
func StartDetached(path string, args []string, env []string) (int, error) {
	start := func(flags uint32) (int, error) {
		cmd := exec.Command(path, args...)
		cmd.Env = env
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		if err := cmd.Start(); err != nil {
			return 0, err
		}
		pid := cmd.Process.Pid
		cmd.Process.Release()
		return pid, nil
	}
	base := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS)
	pid, err := start(base | windows.CREATE_BREAKAWAY_FROM_JOB)
	if err != nil && errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// The engine's own job (if any) does not allow breakaway; then it is not a kill-on-close
		// job of ours either, and a plain detached start is enough.
		pid, err = start(base)
	}
	return pid, err
}
