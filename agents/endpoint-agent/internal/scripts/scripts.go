// Package scripts runs a Fleet job's script on this computer (command `script_run`): PowerShell
// on Windows, /bin/sh on Linux and macOS, with typed parameters passed as data.
//
// Parameters never become part of the script's text. Each value goes into an environment variable
// NIGAFIY_PARAM_<NAME> of the script's process only:
//   - PowerShell: a generated launcher builds a hashtable from those variables, converting each by
//     its declared type ([string], [int], [bool]), and splats it onto the saved script file
//     (`& $script @p`), so the script's own param() block binds them. The launcher contains only
//     parameter names (checked against ^[A-Za-z][A-Za-z0-9_]{0,39}$) and the file path it chose.
//   - /bin/sh: the script reads "$NIGAFIY_PARAM_<NAME>".
//
// So quotes, $(...), backticks, ; or newlines in a value are just characters. Output is kept up to
// a cap per stream (the rest is counted, not kept); the script stops at its timeout or when the job
// is cancelled, together with every process it started (a Windows job object; a process group
// elsewhere). The temporary folder is removed afterwards.
package scripts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Param is one typed value as the server sent it (value always as text).
type Param struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

// Request is the `script_run` payload.
type Request struct {
	ResultID       string  `json:"result_id"`
	JobID          string  `json:"job_id"`
	Language       string  `json:"language"`
	Body           string  `json:"body"`
	BodySHA256     string  `json:"body_sha256"`
	Params         []Param `json:"params"`
	TimeoutS       int     `json:"timeout_s"`
	MaxOutputBytes int     `json:"max_output_bytes"`
}

// Result goes back as the command's data.
type Result struct {
	ExitCode    int    `json:"exit_code"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	StdoutBytes int    `json:"stdout_bytes"`
	StderrBytes int    `json:"stderr_bytes"`
	Capped      bool   `json:"capped"`
	DurationMS  int64  `json:"duration_ms"`
	TimedOut    bool   `json:"timed_out,omitempty"`
	Cancelled   bool   `json:"cancelled,omitempty"`
}

// EnvPrefix of every parameter's environment variable.
const EnvPrefix = "NIGAFIY_PARAM_"

var nameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,39}$`)

const (
	DefaultTimeout   = 10 * time.Minute
	MaxTimeout       = 24 * time.Hour
	DefaultOutputCap = 1 << 20
	MaxOutputCap     = 4 << 20
)

// Validate refuses what the server never sends: unknown language, bad names or types, a body that
// does not match its SHA-256, NUL characters.
func (r Request) Validate() error {
	if r.Language != "powershell" && r.Language != "sh" {
		return fmt.Errorf("unknown script language %q", r.Language)
	}
	if strings.TrimSpace(r.Body) == "" {
		return errors.New("the script is empty")
	}
	if r.BodySHA256 != "" {
		sum := sha256.Sum256([]byte(r.Body))
		if hex.EncodeToString(sum[:]) != r.BodySHA256 {
			return errors.New("the script does not match its SHA-256")
		}
	}
	seen := map[string]bool{}
	for _, p := range r.Params {
		if !nameRE.MatchString(p.Name) {
			return fmt.Errorf("invalid parameter name %q", p.Name)
		}
		if seen[strings.ToLower(p.Name)] {
			return fmt.Errorf("parameter %s given twice", p.Name)
		}
		seen[strings.ToLower(p.Name)] = true
		switch p.Type {
		case "string", "choice":
		case "int":
			if _, err := strconv.ParseInt(p.Value, 10, 32); err != nil {
				return fmt.Errorf("parameter %s is not a whole number", p.Name)
			}
		case "bool":
			if p.Value != "true" && p.Value != "false" {
				return fmt.Errorf("parameter %s is not true or false", p.Name)
			}
		default:
			return fmt.Errorf("parameter %s has an unknown type %q", p.Name, p.Type)
		}
		if strings.ContainsRune(p.Value, 0) {
			return fmt.Errorf("parameter %s contains a NUL character", p.Name)
		}
	}
	return nil
}

// Env is the parameters as environment variables (added to the agent's environment).
func (r Request) Env() []string {
	out := make([]string, 0, len(r.Params))
	for _, p := range r.Params {
		out = append(out, EnvPrefix+strings.ToUpper(p.Name)+"="+p.Value)
	}
	return out
}

// psQuote is a PowerShell single-quoted string literal (only ' needs doubling). Used for the
// script path the runner chose, never for a parameter value.
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// Launcher is the PowerShell wrapper: UTF-8 output, the hashtable from the environment, the splat,
// and the script's exit code. It contains parameter names and the script path only.
func (r Request) Launcher(scriptPath string) string {
	var b strings.Builder
	b.WriteString("$ErrorActionPreference = 'Continue'\r\n")
	b.WriteString("try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\r\n")
	b.WriteString("$p = @{}\r\n")
	for _, p := range r.Params {
		v := "$env:" + EnvPrefix + strings.ToUpper(p.Name)
		switch p.Type {
		case "int":
			fmt.Fprintf(&b, "$p['%s'] = [int]%s\r\n", p.Name, v)
		case "bool":
			fmt.Fprintf(&b, "$p['%s'] = (%s -eq 'true')\r\n", p.Name, v)
		default:
			fmt.Fprintf(&b, "$p['%s'] = [string]%s\r\n", p.Name, v)
		}
	}
	fmt.Fprintf(&b, "$global:LASTEXITCODE = 0\r\ntry {\r\n  & %s @p\r\n  if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }\r\n  exit $LASTEXITCODE\r\n} catch {\r\n  Write-Error $_\r\n  exit 1\r\n}\r\n", psQuote(scriptPath))
	return b.String()
}

// capBuffer keeps the first max bytes and counts the rest.
type capBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	max   int
	total int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += len(p)
	if room := c.max - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func (c *capBuffer) result() (string, int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.ToValidUTF8(c.buf.String(), "�"), c.total, c.total > c.buf.Len()
}

// Runner runs scripts; Cancel stops one by its result id.
type Runner struct {
	// TempDir is where each run gets its own folder (default os.TempDir()).
	TempDir string
	// PowerShell and Shell override the interpreters (tests).
	PowerShell string
	Shell      string

	mu      sync.Mutex
	running map[string]context.CancelFunc
	cancels map[string]bool
}

// Cancel stops the script of a result if it runs here (true when it did).
func (r *Runner) Cancel(resultID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.running[resultID]; ok {
		if r.cancels == nil {
			r.cancels = map[string]bool{}
		}
		r.cancels[resultID] = true
		c()
		return true
	}
	return false
}

func (r *Runner) interpreter(lang string) (string, []string, error) {
	if lang == "powershell" {
		exe := r.PowerShell
		if exe == "" {
			if runtime.GOOS != "windows" {
				// PowerShell 7 on Linux/macOS when installed.
				exe = "pwsh"
			} else {
				exe = "powershell.exe"
			}
		}
		path, err := exec.LookPath(exe)
		if err != nil {
			return "", nil, fmt.Errorf("PowerShell was not found (%s)", exe)
		}
		return path, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}, nil
	}
	sh := r.Shell
	if sh == "" {
		sh = "/bin/sh"
	}
	if _, err := os.Stat(sh); err != nil {
		return "", nil, fmt.Errorf("%s was not found", sh)
	}
	return sh, nil, nil
}

// Run runs one script to the end (or its timeout, or a cancel).
func (r *Runner) Run(ctx context.Context, req Request) (Result, error) {
	if err := req.Validate(); err != nil {
		return Result{ExitCode: -1}, err
	}
	timeout := time.Duration(req.TimeoutS) * time.Second
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	timeout = min(timeout, MaxTimeout)
	limit := req.MaxOutputBytes
	if limit <= 0 {
		limit = DefaultOutputCap
	}
	limit = min(limit, MaxOutputCap)

	exe, args, err := r.interpreter(req.Language)
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	base := r.TempDir
	if base == "" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "nigafiy-job-")
	if err != nil {
		return Result{ExitCode: -1}, fmt.Errorf("temporary folder: %w", err)
	}
	defer os.RemoveAll(dir)

	var target string
	if req.Language == "powershell" {
		script := filepath.Join(dir, "script.ps1")
		launcher := filepath.Join(dir, "run.ps1")
		// A BOM so Windows PowerShell 5.1 reads the file as UTF-8.
		if err := os.WriteFile(script, append([]byte{0xEF, 0xBB, 0xBF}, req.Body...), 0o600); err != nil {
			return Result{ExitCode: -1}, err
		}
		if err := os.WriteFile(launcher, append([]byte{0xEF, 0xBB, 0xBF}, req.Launcher(script)...), 0o600); err != nil {
			return Result{ExitCode: -1}, err
		}
		target = launcher
	} else {
		target = filepath.Join(dir, "script.sh")
		if err := os.WriteFile(target, []byte(req.Body), 0o700); err != nil {
			return Result{ExitCode: -1}, err
		}
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if req.ResultID != "" {
		r.mu.Lock()
		if r.running == nil {
			r.running = map[string]context.CancelFunc{}
		}
		r.running[req.ResultID] = cancel
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.running, req.ResultID)
			r.mu.Unlock()
		}()
	}

	cmd := exec.Command(exe, append(args, target)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), req.Env()...)
	stdout := &capBuffer{max: limit}
	stderr := &capBuffer{max: limit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	prepareTree(cmd)
	started := time.Now()
	if err := cmd.Start(); err != nil {
		return Result{ExitCode: -1}, fmt.Errorf("start %s: %w", filepath.Base(exe), err)
	}
	tree := trackTree(cmd)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var waitErr error
	stopped := false
	select {
	case waitErr = <-done:
	case <-runCtx.Done():
		stopped = true
		tree.kill()
		waitErr = <-done
	}
	tree.close()
	res := Result{DurationMS: time.Since(started).Milliseconds()}
	res.Stdout, res.StdoutBytes, res.Capped = stdout.result()
	var errCapped bool
	res.Stderr, res.StderrBytes, errCapped = stderr.result()
	res.Capped = res.Capped || errCapped
	res.ExitCode = exitCode(cmd, waitErr)
	r.mu.Lock()
	res.Cancelled = r.cancels[req.ResultID]
	delete(r.cancels, req.ResultID)
	r.mu.Unlock()
	if stopped && !res.Cancelled {
		if ctx.Err() == nil {
			res.TimedOut = true
		}
	}
	switch {
	case res.Cancelled:
		return res, errors.New("cancelled by the operator")
	case res.TimedOut:
		return res, fmt.Errorf("stopped after %s", timeout)
	}
	return res, nil
}

func exitCode(cmd *exec.Cmd, err error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode()
	}
	if err != nil {
		return -1
	}
	return 0
}
