package engine

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nigafiy/engine/internal/control"
	"github.com/nigafiy/engine/internal/update"
)

// ServiceName is the engine's Windows service (also used by the update helper to start it again).
const ServiceName = "NigafiyEngine"

// helperExeName is the copy of the engine that runs the installer.
const helperExeName = "nigafiy-engine-update.exe"

// shutdownDelay lets the API answer the operator before the engine stops it.
const shutdownDelay = 2 * time.Second

// Replaced in tests.
var (
	startDetached   = update.StartDetached
	checkSig        = update.CheckAuthenticode
	selfExe         = os.Executable
	installRegistry = update.SystemRegistry
	installPackage  = update.PackageReader(update.SystemPackage)
)

// storeManaged is the refusal for the Microsoft Store package (docs/operations/microsoft-store.md).
const storeManaged = "this installation is the Microsoft Store package: the Microsoft Store installs its updates, not the in-app updater"

// msiManaged is the refusal for an MSI-managed installation.
const msiManaged = "this installation is managed by Windows Installer (MSI): updates come from your administrator through Group Policy or Intune, not from the in-app updater"

// updater hands a verified, staged installer to the update helper (`nigafiy-engine update-apply`,
// a copy of this program in <data-dir>/updates/helper) and then shuts the engine down. The helper
// waits for the engine to exit, checks the installer again, runs it silently over the installation
// folder and starts the engine (service) or the desktop app again.
type updater struct {
	e *engine

	mu       sync.Mutex
	applying string // version being handed over

	kindOnce sync.Once
	kind     *update.InstallInfo
}

// install is how this installation was installed, read once from the registry (nil in a source
// checkout).
func (u *updater) install() *update.InstallInfo {
	u.kindOnce.Do(func() {
		dir, err := u.installDir()
		if err != nil {
			return
		}
		info := update.DetectInstallWith(dir, installRegistry(), installPackage)
		u.kind = &info
	})
	return u.kind
}

func newUpdater(e *engine) *updater { return &updater{e: e} }

func (u *updater) doc() *control.UpdateDoc {
	u.mu.Lock()
	defer u.mu.Unlock()
	d := &control.UpdateDoc{State: "idle"}
	if u.applying != "" {
		v := u.applying
		d.State = "applying"
		d.Version = &v
	}
	if last, err := update.ReadResult(update.ResultPath(u.e.cfg.DataDir)); err == nil {
		d.Last = last
	}
	d.Install = u.install()
	return d
}

// installDir is the installed desktop app's folder: the bundle is <install>/resources/backend.
func (u *updater) installDir() (string, error) {
	b := u.e.cfg.BundleDir
	if b == "" {
		return "", fmt.Errorf("%w: this engine runs from a source checkout, not an installed copy; update it with git", control.ErrRefused)
	}
	resources := filepath.Dir(b)
	if !equalFoldPath(filepath.Base(b), "backend") || !equalFoldPath(filepath.Base(resources), "resources") {
		return "", fmt.Errorf("%w: the bundle folder %s is not <install>/resources/backend", control.ErrRefused, b)
	}
	return filepath.Dir(resources), nil
}

func equalFoldPath(a, b string) bool { return strings.EqualFold(a, b) }

// ApplyUpdate is control.Backend.ApplyUpdate.
func (e *engine) ApplyUpdate(req update.Request) (control.UpdateDoc, error) {
	return e.updates.apply(req)
}

func (u *updater) apply(req update.Request) (control.UpdateDoc, error) {
	e := u.e
	if e.stopping.Load() {
		return control.UpdateDoc{}, fmt.Errorf("%w: the engine is shutting down", control.ErrRefused)
	}
	u.mu.Lock()
	busy := u.applying != ""
	u.mu.Unlock()
	if busy {
		return control.UpdateDoc{}, fmt.Errorf("%w: an update is already being installed", control.ErrRefused)
	}
	dir, err := u.installDir()
	if err != nil {
		return control.UpdateDoc{}, err
	}
	if k := u.install(); k != nil && k.Kind == update.KindMSI {
		return control.UpdateDoc{}, fmt.Errorf("%w: %s", control.ErrRefused, msiManaged)
	}
	if k := u.install(); k != nil && k.Kind == update.KindMSIX {
		return control.UpdateDoc{}, fmt.Errorf("%w: %s", control.ErrRefused, storeManaged)
	}
	if err := req.Validate(e.cfg.DataDir); err != nil {
		return control.UpdateDoc{}, errors.Join(control.ErrUpdateRejected, err)
	}
	if err := update.Verify(req, e.cfg.UpdatePublisher, checkSig); err != nil {
		return control.UpdateDoc{}, errors.Join(control.ErrUpdateRejected, err)
	}

	args := []string{
		"update-apply",
		"--data-dir=" + e.cfg.DataDir,
		"--installer=" + req.Installer,
		"--sha256=" + req.SHA256,
		"--version=" + req.Version,
		"--install-dir=" + dir,
		"--wait-pid=" + strconv.Itoa(os.Getpid()),
	}
	if e.cfg.UpdatePublisher != "" {
		args = append(args, "--publisher="+e.cfg.UpdatePublisher)
	}
	switch {
	case e.cfg.Mode == "service":
		args = append(args, "--service="+ServiceName)
	case !isPlainNode(e.cfg.Node) && e.cfg.Node != "":
		// Foreground engine of the installed desktop app: start the app again; it starts the engine.
		args = append(args, "--restart-exe="+e.cfg.Node)
	}

	helper, err := u.copyHelper()
	if err != nil {
		return control.UpdateDoc{}, fmt.Errorf("preparing the update helper: %w", err)
	}
	env := withoutEnv(os.Environ(), "ELECTRON_RUN_AS_NODE")
	pid, err := startDetached(helper, args, env)
	if err != nil {
		return control.UpdateDoc{}, fmt.Errorf("starting the update helper: %w", err)
	}
	u.mu.Lock()
	u.applying = req.Version
	u.mu.Unlock()
	e.log.Printf("update %s: installer verified (sha256 %s); helper started (pid %d); stopping the engine for the installation", req.Version, req.SHA256, pid)
	time.AfterFunc(shutdownDelay, e.Shutdown)
	return *u.doc(), nil
}

// copyHelper copies this program to <data-dir>/updates/helper so that the installer can replace
// the original file.
func (u *updater) copyHelper() (string, error) {
	exe, err := selfExe()
	if err != nil {
		return "", err
	}
	dir := update.HelperDir(u.e.cfg.DataDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, helperExeName)
	in, err := os.Open(exe)
	if err != nil {
		return "", err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	os.Remove(dst)
	if err := os.Rename(tmp, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// afterStop runs at the very end of Run (nothing to do: the helper is already waiting).
func (u *updater) afterStop() {
	u.mu.Lock()
	v := u.applying
	u.mu.Unlock()
	if v != "" {
		u.e.log.Printf("update %s: engine stopped; the update helper installs it now", v)
	}
}
