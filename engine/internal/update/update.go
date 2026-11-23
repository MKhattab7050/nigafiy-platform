// Package update applies a staged Nigafiy update: it runs the release's NSIS installer silently
// over the existing installation once the engine (and everything it supervises) has stopped, then
// starts the engine again.
//
// The download and the signed-manifest check happen in the API (apps/api/src/modules/platform).
// This package re-checks the installer itself before running it: it must sit in the staging folder,
// its SHA-256 must match the one from the signed manifest, and, when a publisher is configured, its
// Authenticode signature must be valid and made by that publisher's certificate.
package update

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// StagingDir is where the API stages downloaded installers: <data-dir>/updates/staged.
func StagingDir(dataDir string) string { return filepath.Join(dataDir, "updates", "staged") }

// ResultPath is where the outcome of the last installation is written.
func ResultPath(dataDir string) string { return filepath.Join(dataDir, "updates", "last-install.json") }

// HelperDir holds the copy of the engine that runs the installer (the installer replaces the
// engine's own file, which cannot happen while it runs).
func HelperDir(dataDir string) string { return filepath.Join(dataDir, "updates", "helper") }

var (
	sha256Re     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	thumbprintRe = regexp.MustCompile(`^[0-9A-F]{40}$`)
	versionRe    = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// NormalizeThumbprint upper-cases a SHA-1 certificate thumbprint and drops spaces and colons.
// Empty input gives "", anything that is not 40 hex digits an error.
func NormalizeThumbprint(s string) (string, error) {
	t := strings.ToUpper(strings.NewReplacer(" ", "", ":", "").Replace(strings.TrimSpace(s)))
	if t == "" {
		return "", nil
	}
	if !thumbprintRe.MatchString(t) {
		return "", fmt.Errorf("publisher thumbprint %q must be 40 hexadecimal digits (SHA-1)", s)
	}
	return t, nil
}

// Request is what the API asks the engine to install.
type Request struct {
	Installer string `json:"installer"` // absolute path inside StagingDir
	SHA256    string `json:"sha256"`    // lower-case hex, from the signed manifest
	Version   string `json:"version"`   // x.y.z, from the signed manifest
}

// Validate checks the request's form and that the installer is a regular .exe file directly in
// the staging folder (no other folder, no link).
func (r Request) Validate(dataDir string) error {
	if !sha256Re.MatchString(r.SHA256) {
		return errors.New("sha256 must be 64 lower-case hexadecimal digits")
	}
	if !versionRe.MatchString(r.Version) {
		return errors.New("version must look like 1.2.3")
	}
	if !filepath.IsAbs(r.Installer) {
		return errors.New("installer path must be absolute")
	}
	staging, err := filepath.Abs(StagingDir(dataDir))
	if err != nil {
		return err
	}
	clean := filepath.Clean(r.Installer)
	if !strings.EqualFold(filepath.Dir(clean), staging) {
		return fmt.Errorf("installer must be in %s", staging)
	}
	if !strings.EqualFold(filepath.Ext(clean), ".exe") {
		return errors.New("installer must be an .exe file")
	}
	info, err := os.Lstat(clean)
	if err != nil {
		return fmt.Errorf("installer: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("installer is not a regular file")
	}
	return nil
}

// HashFile is the lower-case hex SHA-256 of a file.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Signature is what Authenticode says about a file.
type Signature struct {
	Status     string `json:"status"`     // "Valid", "NotSigned", "HashMismatch", "UnknownError", ...
	Thumbprint string `json:"thumbprint"` // signer certificate SHA-1, upper-case; "" when unsigned
}

// SignatureChecker reads a file's Authenticode signature.
type SignatureChecker func(path string) (Signature, error)

// Verify checks the installer before it is run: its hash, then (when publisher is set) that its
// Authenticode signature is valid and made by that certificate.
func Verify(req Request, publisher string, check SignatureChecker) error {
	got, err := HashFile(req.Installer)
	if err != nil {
		return fmt.Errorf("reading the installer: %w", err)
	}
	if got != req.SHA256 {
		return fmt.Errorf("installer SHA-256 %s does not match the signed manifest (%s)", got, req.SHA256)
	}
	if publisher == "" {
		return nil
	}
	if check == nil {
		return errors.New("a publisher is configured but signatures cannot be checked on this system")
	}
	sig, err := check(req.Installer)
	if err != nil {
		return fmt.Errorf("checking the installer's signature: %w", err)
	}
	if sig.Status != "Valid" {
		return fmt.Errorf("installer signature is %s, not Valid (the publisher certificate must be trusted on this computer)", sig.Status)
	}
	if !strings.EqualFold(sig.Thumbprint, publisher) {
		return fmt.Errorf("installer is signed by %s, not by the configured publisher %s", sig.Thumbprint, publisher)
	}
	return nil
}

// InstallerArgs runs an electron-builder NSIS installer silently over installDir, for all users
// when the installation is per-machine (under Program Files) and for the current user otherwise, so
// a silent update never switches the installation mode. /D= must be the last argument and is not
// quoted (NSIS reads the rest of the command line as the folder).
func InstallerArgs(installDir string, perMachine bool) []string {
	mode := "/currentuser"
	if perMachine {
		mode = "/allusers"
	}
	return []string{"/S", mode, "--updated", "/D=" + installDir}
}

// PerMachine reports whether installDir is inside one of the Program Files folders.
func PerMachine(installDir string, programFiles ...string) bool {
	dir := strings.ToLower(filepath.Clean(installDir)) + string(filepath.Separator)
	for _, pf := range programFiles {
		if pf == "" {
			continue
		}
		if strings.HasPrefix(dir, strings.ToLower(filepath.Clean(pf))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// Result is the outcome of the last installation (ResultPath).
type Result struct {
	Version    string    `json:"version"`
	OK         bool      `json:"ok"`
	ExitCode   *int      `json:"exit_code"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Restarted  bool      `json:"restarted"`
}

// WriteResult writes r atomically.
func WriteResult(path string, r Result) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ReadResult reads the last result; (nil, nil) when there is none.
func ReadResult(path string) (*Result, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) > 64<<10 {
		return nil, errors.New("result file too large")
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Plan is everything the helper needs to install and restart.
type Plan struct {
	DataDir    string
	Request    Request
	InstallDir string
	PerMachine bool // the installation is under Program Files: install for all users
	Publisher  string
	WaitPid    int           // the engine that handed over; the installer runs once it has exited
	WaitFor    time.Duration // how long to wait for it
	// Restart: exactly one of these. ServiceName starts the Windows service again; RestartExe
	// starts the desktop app (which starts the engine).
	ServiceName string
	RestartExe  string
}

// Deps are the system calls Apply makes; tests replace them.
type Deps struct {
	WaitExit     func(pid int, timeout time.Duration) error
	RunInstaller func(path string, args []string) (exitCode int, err error)
	CheckSig     SignatureChecker
	StartService func(name string) error
	StartExe     func(path string) error
	Now          func() time.Time
	Logf         func(format string, args ...any)
}

// Apply waits for the engine to exit, re-verifies the installer, runs it silently, records the
// result and restarts the engine (service) or the desktop app. It always tries to restart, also
// after a failed installation, so the computer is not left without its engine.
func Apply(p Plan, d Deps) Result {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	res := Result{Version: p.Request.Version, StartedAt: d.Now().UTC()}
	finish := func() Result {
		res.FinishedAt = d.Now().UTC()
		if p.ServiceName != "" || p.RestartExe != "" {
			var err error
			if p.ServiceName != "" {
				d.Logf("starting the service %s", p.ServiceName)
				err = d.StartService(p.ServiceName)
			} else {
				d.Logf("starting %s", p.RestartExe)
				err = d.StartExe(p.RestartExe)
			}
			if err != nil {
				d.Logf("restart failed: %v", err)
				if res.Error == "" {
					res.Error = "installed, but the restart failed: " + err.Error()
				} else {
					res.Error += "; the restart also failed: " + err.Error()
				}
			} else {
				res.Restarted = true
			}
		}
		if err := WriteResult(ResultPath(p.DataDir), res); err != nil {
			d.Logf("could not write the result: %v", err)
		}
		return res
	}
	fail := func(err error) Result {
		res.Error = err.Error()
		d.Logf("update to %s not installed: %v", p.Request.Version, err)
		return finish()
	}

	if p.WaitPid > 0 {
		d.Logf("waiting for the engine (pid %d) to stop", p.WaitPid)
		if err := d.WaitExit(p.WaitPid, p.WaitFor); err != nil {
			// Never run the installer over a running engine.
			res.Error = fmt.Sprintf("the engine did not stop: %v", err)
			d.Logf("%s", res.Error)
			res.FinishedAt = d.Now().UTC()
			WriteResult(ResultPath(p.DataDir), res)
			return res
		}
	}
	if err := p.Request.Validate(p.DataDir); err != nil {
		return fail(err)
	}
	if err := Verify(p.Request, p.Publisher, d.CheckSig); err != nil {
		return fail(err)
	}
	if p.InstallDir == "" || !filepath.IsAbs(p.InstallDir) {
		return fail(errors.New("no installation folder"))
	}
	args := InstallerArgs(p.InstallDir, p.PerMachine)
	d.Logf("running %s %s", p.Request.Installer, strings.Join(args, " "))
	code, err := d.RunInstaller(p.Request.Installer, args)
	if err != nil {
		return fail(fmt.Errorf("running the installer: %w", err))
	}
	res.ExitCode = &code
	if code != 0 {
		return fail(fmt.Errorf("the installer exited with code %d", code))
	}
	res.OK = true
	d.Logf("update %s installed", p.Request.Version)
	return finish()
}
