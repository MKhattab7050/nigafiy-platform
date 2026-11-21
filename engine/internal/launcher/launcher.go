// Package launcher is the per-program Nigafiy launcher (Milestone 4, spec §6.2): a tiny executable
// per program (nigafiy-radar.exe, nigafiy-guard.exe, …) that finds the one Nigafiy desktop runtime
// and starts it with `--program=<id>`, forwarding a nigafiy:// link when the launcher was opened by
// one. The runtime then opens or focuses that program's window, with its own taskbar identity.
//
// The runtime is found, in order, from the NIGAFIY_RUNTIME environment variable, the registry value
// HKCU then HKLM `Software\Nigafiy\Runtime` `Path` (written by the Milestone 5 installers), and
// finally `..\runtime\Nigafiy.exe` next to the launcher. Nothing here writes to the registry.
package launcher

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Programs are the Nigafiy program ids, in the order of the shared program table
// (packages/shared-types/src/programs.ts; scripts/build-launchers.mjs builds one launcher per id
// from that table and checks each binary reports the id it was built for).
var Programs = []string{"hub", "radar", "watch", "guard", "fleet", "mind", "toolbox"}

// RuntimeEnv overrides where the runtime is (a full path to its executable).
const RuntimeEnv = "NIGAFIY_RUNTIME"

// RegistryKey and RegistryValue locate the runtime when the installers have registered it.
const (
	RegistryKey   = `Software\Nigafiy\Runtime`
	RegistryValue = "Path"
)

// RuntimeName is the runtime executable the installers place in `runtime\`.
const RuntimeName = "Nigafiy.exe"

// ErrUnknownProgram is returned for a program id that is not one of Programs.
var ErrUnknownProgram = errors.New("unknown Nigafiy program")

// ErrNoRuntime is returned when no candidate runtime exists.
var ErrNoRuntime = errors.New("the Nigafiy desktop runtime was not found")

// ValidProgram reports whether id is a Nigafiy program.
func ValidProgram(id string) bool {
	for _, p := range Programs {
		if p == id {
			return true
		}
	}
	return false
}

// AppUserModelID is the taskbar identity of a program's window: Nigafiy.Radar.
func AppUserModelID(id string) string {
	if !ValidProgram(id) {
		id = "hub"
	}
	return "Nigafiy." + strings.ToUpper(id[:1]) + id[1:]
}

// Env reads an environment variable (os.Getenv in production, a map in tests).
type Env func(key string) string

// Registry reads the runtime path the installers registered: "" with a nil error when absent.
type Registry func() (string, error)

// Locator finds the runtime.
type Locator struct {
	// Exe is the launcher's own executable path.
	Exe      string
	Env      Env
	Registry Registry
	// Stat checks a candidate (os.Stat by default).
	Stat func(name string) (fs.FileInfo, error)
}

// Candidate is one place the runtime may be, with where it came from.
type Candidate struct {
	Path   string
	Source string
}

// Candidates lists where the runtime may be, in the order they are tried.
func (l Locator) Candidates() []Candidate {
	var out []Candidate
	if l.Env != nil {
		if v := strings.TrimSpace(l.Env(RuntimeEnv)); v != "" {
			out = append(out, Candidate{Path: v, Source: "env " + RuntimeEnv})
		}
	}
	if l.Registry != nil {
		if v, err := l.Registry(); err == nil && strings.TrimSpace(v) != "" {
			out = append(out, Candidate{Path: strings.TrimSpace(v), Source: "registry " + RegistryKey})
		}
	}
	if l.Exe != "" {
		out = append(out, Candidate{Path: filepath.Join(filepath.Dir(l.Exe), "..", "runtime", RuntimeName), Source: "next to the launcher"})
	}
	return out
}

// Find returns the first candidate that is an existing regular file.
func (l Locator) Find() (string, error) {
	stat := l.Stat
	if stat == nil {
		stat = os.Stat
	}
	var tried []string
	for _, c := range l.Candidates() {
		p := filepath.Clean(c.Path)
		if !filepath.IsAbs(p) {
			tried = append(tried, fmt.Sprintf("%s (%s): not an absolute path", c.Path, c.Source))
			continue
		}
		info, err := stat(p)
		if err == nil && info.Mode().IsRegular() {
			return p, nil
		}
		tried = append(tried, fmt.Sprintf("%s (%s)", p, c.Source))
	}
	return "", fmt.Errorf("%w; looked in: %s", ErrNoRuntime, strings.Join(tried, "; "))
}

var linkRe = regexp.MustCompile(`^(?i)nigafiy://[a-z]+(/[A-Za-z0-9._~/-]*)?(\?[A-Za-z0-9._~\-=&%+]*)?$`)

// Args is the runtime's command line for a program: `--program=<id>`, then any nigafiy:// link
// the launcher was given (only well-formed ones; the runtime parses them strictly again).
// Every other argument is dropped, so a launcher cannot be used to pass switches to the runtime.
func Args(program string, given []string) ([]string, error) {
	if !ValidProgram(program) {
		return nil, fmt.Errorf("%w: %q", ErrUnknownProgram, program)
	}
	args := []string{"--program=" + program}
	for _, a := range given {
		if len(a) <= 2048 && linkRe.MatchString(a) && !strings.Contains(a, "/../") && !strings.HasSuffix(a, "/..") {
			args = append(args, a)
		}
	}
	return args, nil
}

// Starter starts the runtime without waiting for it (exec in production, a recorder in tests).
type Starter func(runtime string, args []string) error

// StartDetached starts the runtime and returns at once; the runtime outlives the launcher.
func StartDetached(runtime string, args []string) error {
	cmd := exec.Command(runtime, args...)
	cmd.Dir = filepath.Dir(runtime)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Launch finds the runtime and starts it for program with the given launcher arguments.
func Launch(program string, given []string, l Locator, start Starter) (string, error) {
	args, err := Args(program, given)
	if err != nil {
		return "", err
	}
	runtime, err := l.Find()
	if err != nil {
		return "", err
	}
	if start == nil {
		start = StartDetached
	}
	if err := start(runtime, args); err != nil {
		return runtime, fmt.Errorf("starting %s: %w", runtime, err)
	}
	return runtime, nil
}
