// nigafiy-support is Nigafiy Quick Support: an attended-only support program the person runs
// once. Nothing is installed. It is downloaded from Nigafiy Fleet with the company's server bound
// in (signed, see internal/quicksupport), shows a 9-digit ID and a one-time PIN, and when the
// operator connects the person clicks Accept; the session runs with the Nigafiy banner and End
// session. When the session ends, the ID expires, or the person closes the window, the program
// deletes its temporary files and itself, and exits.
//
// It reuses the agent (heartbeat, command poll, remote desktop stream and input) with a Quick
// Support profile: no tray, no inventory upload, no restart, and only the commands the server
// allows a Quick Support computer (screen, input, files, a message to the user). The server caps
// the session profile at Support and always asks for consent.
//
// Usage:
//
//	nigafiy-support.exe          run Quick Support
//	nigafiy-support.exe -keep    do not delete the program at the end (to run it again)
//	nigafiy-support.exe -v       write the log to the console
//	nigafiy-support.exe "nigafiy-support:qs1/..."   the binding from a Fleet link instead of the file
//	                             (how the Microsoft Store version is opened; it never deletes itself)
package main

//go:generate go run ../../tools/winres -manifest nigafiy-support.manifest -o rsrc_windows_amd64.syso

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/nigafiy/agent/internal/agent"
	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/control"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/quicksupport"
	"github.com/nigafiy/agent/internal/sysinfo"
)

var Version = "1.0.1"

const title = "Nigafiy Quick Support"

func main() {
	keep := flag.Bool("keep", false, "do not delete this program when Quick Support ends")
	verbose := flag.Bool("v", false, "write the log to the console")
	flag.Parse()

	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.Abs(exe)
	}
	if err != nil {
		showError(title, "Cannot find this program's path: "+err.Error())
		os.Exit(1)
	}
	// The Microsoft Store version (an MSIX package): the binding comes from the Fleet link it was
	// opened with, and the program file belongs to the package, so it is never deleted here.
	packaged := quicksupport.Packaged()
	dir, code := run(exe, flag.Args(), packaged, *verbose)
	cleanup(dir, exe, *keep || packaged)
	os.Exit(code)
}

// run returns the temporary folder it made ("" when none) and the exit code.
func run(exe string, args []string, packaged, verbose bool) (string, int) {
	b, err := quicksupport.FromArgs(args, exe, packaged)
	if err == nil {
		err = b.CheckServer()
	}
	if err != nil {
		showError(title, err.Error())
		return "", 1
	}
	tlsCfg, err := b.TLSConfig(agent.VerifyPinnedChain)
	if err != nil {
		showError(title, err.Error())
		return "", 1
	}
	client := &http.Client{
		Timeout:       20 * time.Second,
		Transport:     &http.Transport{TLSClientConfig: tlsCfg, Proxy: http.ProxyFromEnvironment},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	h := sysinfo.CollectHealth(ctx, time.Now())
	regCtx, regCancel := context.WithTimeout(ctx, 30*time.Second)
	reg, err := quicksupport.Register(regCtx, client, b, quicksupport.Host{Hostname: h.Hostname, OS: h.OS, OSVersion: h.OSVersion, Arch: h.Arch, AgentVersion: Version})
	regCancel()
	if err != nil {
		showError(title, err.Error())
		return "", 1
	}
	closeOnServer := func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = quicksupport.Close(c, client, b, reg.Credential)
	}

	dir, err := os.MkdirTemp("", "nigafiy-support-")
	if err != nil {
		closeOnServer()
		showError(title, "Cannot create a temporary folder: "+err.Error())
		return "", 1
	}
	cred, _ := json.Marshal(map[string]string{"endpoint_id": reg.EndpointID, "credential": reg.Credential})
	if err := os.WriteFile(filepath.Join(dir, "credential.json"), cred, 0o600); err != nil {
		closeOnServer()
		showError(title, "Cannot write the temporary credential: "+err.Error())
		return dir, 1
	}

	var logOut io.Writer = io.Discard
	if verbose {
		logOut = os.Stderr
	}
	log := slog.New(slog.NewJSONHandler(logOut, &slog.HandlerOptions{Level: slog.LevelInfo})).With("service", "nigafiy-support", "version", Version)
	cfg := config.Config{ServerURL: b.Server, StateDir: dir, TLSPinSHA256: b.TLSPin, LogLevel: "info", AllowInsecureHTTP: b.AllowsHTTP()}
	ag, err := agent.New(&cfg, Deps(desktop.NewLocal(), control.DefaultRunner().Execute), log, Version, agent.DefaultTuning())
	if err != nil {
		closeOnServer()
		showError(title, err.Error())
		return dir, 1
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := ag.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("Quick Support stopped with an error", "error", err.Error())
		}
	}()
	// The window with the ID and PIN; closing it ends Quick Support.
	go func() {
		showCode(title, quicksupport.ScreenTextFor(b, reg, packaged))
		closeOnServer()
		cancel()
	}()
	go watch(runCtx, cancel, client, b, reg.Credential, log)

	<-runCtx.Done()
	if ctx.Err() != nil {
		closeOnServer() // Ctrl+C or the console closed
	}
	select {
	case <-done:
	case <-time.After(15 * time.Second):
	}
	return dir, 0
}

// Deps: the agent with the Quick Support profile (no tray, no inventory, no restart, the server's
// short list of commands).
func Deps(d desktop.Desktop, exec func(context.Context, control.Command) control.Result) agent.Deps {
	return agent.Deps{
		CollectHealth:    sysinfo.CollectHealth,
		CollectInventory: emptyInventory,
		ExecuteCommand:   Limited(exec),
		Desktop:          d,
		NoTray:           true,
	}
}

// Limited refuses every command Quick Support does not run.
func Limited(exec func(context.Context, control.Command) control.Result) func(context.Context, control.Command) control.Result {
	return func(ctx context.Context, cmd control.Command) control.Result {
		if !quicksupport.AllowedCommand(cmd.Kind) {
			return control.Result{ID: cmd.ID, OK: false, Error: "Nigafiy Quick Support does not run " + cmd.Kind}
		}
		return exec(ctx, cmd)
	}
}

// emptyInventory: Quick Support uploads no software, process or connection lists.
func emptyInventory(context.Context) sysinfo.Inventory {
	return sysinfo.Inventory{Disks: []sysinfo.Disk{}, Interfaces: []sysinfo.Interface{}, Processes: []sysinfo.Process{}, Services: []sysinfo.Service{}, Software: []sysinfo.Software{}, Connections: []sysinfo.Connection{}}
}

// watch polls the code's state; the program ends with the session, the expiry or the lockout.
func watch(ctx context.Context, cancel context.CancelFunc, client *http.Client, b quicksupport.Binding, credential string, log *slog.Logger) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
		s, err := quicksupport.GetStatus(ctx, client, b, credential)
		if errors.Is(err, quicksupport.ErrRevoked) || (err == nil && s.Finished()) {
			log.Info("Quick Support finished", "state", s.State)
			cancel()
			return
		}
	}
}

// cleanup: the temporary folder always goes; the program itself unless -keep.
func cleanup(dir, exe string, keep bool) {
	if dir != "" {
		for i := 0; i < 5; i++ {
			if err := os.RemoveAll(dir); err == nil {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	if !keep {
		removeSelf(exe)
	}
}
