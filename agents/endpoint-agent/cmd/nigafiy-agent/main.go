// nigafiy-agent is the Nigafiy Agent (managed-endpoint agent).
//
// Installed on company-owned computers, it reports hardware, health, running processes, services,
// installed software and active network connections over outbound HTTPS, and executes authorized
// IT administration actions from the closed command allow-list.
//
// Usage:
//
//	nigafiy-agent [flags]                 run in the foreground; the desktop work happens in this process
//	nigafiy-agent install [flags]         enroll (when -token is given) and install the Nigafiy service
//	nigafiy-agent uninstall [-service-name N]
//	nigafiy-agent run [flags]             what the service runs: the desktop work goes to a session helper
//	nigafiy-agent session-helper          started by the service inside the signed-in user's session
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/nigafiy/agent/internal/agent"
	"github.com/nigafiy/agent/internal/config"
	"github.com/nigafiy/agent/internal/desktop"
	"github.com/nigafiy/agent/internal/service"
)

var Version = "0.1.0"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			os.Exit(cmdInstall(os.Args[2:]))
		case "uninstall":
			os.Exit(cmdUninstall(os.Args[2:]))
		case "run":
			os.Exit(cmdRun(os.Args[2:]))
		case "session-helper":
			os.Exit(cmdSessionHelper())
		}
	}
	os.Exit(cmdForeground(os.Args[1:]))
}

func bindConfig(fs *flag.FlagSet, cfg *config.Config) {
	fs.StringVar(&cfg.ServerURL, "server", cfg.ServerURL, "Nigafiy server URL (or NIGAFIY_AGENT_SERVER_URL)")
	fs.StringVar(&cfg.EnrollmentToken, "token", cfg.EnrollmentToken, "single-use enrollment token (or NIGAFIY_AGENT_ENROLLMENT_TOKEN)")
	fs.StringVar(&cfg.StateDir, "state-dir", cfg.StateDir, "directory for endpoint credential state")
	fs.StringVar(&cfg.CAFile, "ca-file", cfg.CAFile, "optional PEM CA bundle")
	fs.StringVar(&cfg.TLSPinSHA256, "tls-pin", cfg.TLSPinSHA256, "optional SHA-256 pin of the server certificate or of its local CA (or NIGAFIY_AGENT_TLS_PIN_SHA256)")
	fs.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level: debug, info, warn, error")
	fs.BoolVar(&cfg.AllowInsecureHTTP, "allow-insecure-http", cfg.AllowInsecureHTTP, "allow http:// server URL (local development only)")
}

func newLogger(w io.Writer, level string) *slog.Logger {
	lv := map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError}[level]
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lv})).With("service", "nigafiy-agent", "version", Version)
}

// cmdForeground is the original mode: flags only, the desktop work in this process.
func cmdForeground(args []string) int {
	cfg := config.FromEnv()
	fs := flag.NewFlagSet("nigafiy-agent", flag.ExitOnError)
	bindConfig(fs, &cfg)
	showVersion := fs.Bool("version", false, "print version and exit")
	_ = fs.Parse(args)

	if *showVersion {
		fmt.Println("nigafiy-agent", Version)
		return 0
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	log := newLogger(os.Stderr, cfg.LogLevel)
	deps := agent.SystemDeps()
	deps.ServiceName = service.DefaultName()
	ag, err := agent.New(&cfg, deps, log, Version, agent.DefaultTuning())
	if err != nil {
		log.Error("cannot start endpoint agent", "error", err.Error())
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("endpoint agent starting", "server", cfg.ServerURL, "state_dir", cfg.StateDir)
	if err := ag.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("endpoint agent stopped with an error", "error", err.Error())
		return 1
	}
	return 0
}

// serviceConfig: like the foreground flags, with the platform's state directory by default.
func serviceConfig(name string, args []string, extra func(*flag.FlagSet)) (config.Config, string, error) {
	cfg := config.FromEnv()
	if config.Getenv("NIGAFIY_AGENT_STATE_DIR") == "" {
		cfg.StateDir = service.DefaultStateDir()
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	bindConfig(fs, &cfg)
	svcName := fs.String("service-name", service.DefaultName(), "service name")
	if extra != nil {
		extra(fs)
	}
	if err := fs.Parse(args); err != nil {
		return cfg, "", err
	}
	return cfg, *svcName, nil
}

func cmdInstall(args []string) int {
	noStart := false
	cfg, name, err := serviceConfig("install", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&noStart, "no-start", false, "install without starting the service now")
	})
	if err != nil {
		return 2
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := service.ValidName(name); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if !service.IsPrivileged() {
		fmt.Fprintln(os.Stderr, service.ErrNotPrivileged)
		return 1
	}
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.Abs(exe)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot find this program's path:", err)
		return 1
	}
	if cfg.StateDir, err = filepath.Abs(cfg.StateDir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := service.PrepareStateDir(cfg.StateDir); err != nil {
		fmt.Fprintln(os.Stderr, "cannot prepare the state directory:", err)
		return 1
	}
	log := newLogger(os.Stderr, cfg.LogLevel)
	// Enroll now so the single-use token is spent here and never stored with the service.
	deps := agent.SystemDeps()
	deps.Desktop = nil
	ag, err := agent.New(&cfg, deps, log, Version, agent.DefaultTuning())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot start endpoint agent:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := ag.Enroll(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	runArgs, err := service.RunArgs(cfg, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := service.Install(service.Spec{Name: name, Exe: exe, Args: runArgs, StateDir: cfg.StateDir}, !noStart); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("Installed the %s service %q (%s).\nState directory: %s\nRemote support sessions show a consent prompt (where the policy asks for one) and a session banner on this computer.\n",
		service.DisplayName, name, exe, cfg.StateDir)
	return 0
}

func cmdUninstall(args []string) int {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	name := fs.String("service-name", service.DefaultName(), "service name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := service.Uninstall(*name); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("Removed the service %q. The state directory (the endpoint's credential) was kept; delete it to forget this enrollment.\n", *name)
	return 0
}

// cmdRun is the service's mode: the remote-desktop work runs in a session helper inside the
// signed-in user's desktop session.
func cmdRun(args []string) int {
	cfg, name, err := serviceConfig("run", args, nil)
	if err != nil {
		return 2
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	var logOut io.Writer = os.Stderr
	if service.InService() {
		// A Windows service has no console: log to the (SYSTEM/Administrators-only) state directory.
		if f, err := openServiceLog(cfg.StateDir); err == nil {
			defer f.Close()
			logOut = f
		}
	}
	log := newLogger(logOut, cfg.LogLevel)
	exe, err := os.Executable()
	if err != nil {
		log.Error("cannot find this program's path", "error", err.Error())
		return 1
	}
	launcher := service.HelperLauncher(exe, log)
	sup := desktop.NewSupervisor(launcher, log)
	deps := agent.SystemDeps()
	deps.Desktop = sup
	// The service can start in safe mode and reach other sessions and the sign-in screen.
	deps.InService = service.InService()
	deps.ServiceName = name
	ag, err := agent.New(&cfg, deps, log, Version, agent.DefaultTuning())
	if err != nil {
		log.Error("cannot start endpoint agent", "error", err.Error())
		return 1
	}
	log.Info("endpoint agent starting as a service", "service", name, "server", cfg.ServerURL, "state_dir", cfg.StateDir, "session_helper", launcher.Describe())
	if err := service.Run(name, log, sup, launcher, ag.Run); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("endpoint agent stopped with an error", "error", err.Error())
		return 1
	}
	return 0
}

const maxServiceLog = 10 << 20

func openServiceLog(stateDir string) (*os.File, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(stateDir, "agent.log")
	if st, err := os.Stat(p); err == nil && st.Size() > maxServiceLog {
		_ = os.Rename(p, p+".1")
	}
	return os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

// cmdSessionHelper answers the service over stdin/stdout. It has no network access of its own
// and never sees the agent's credential.
func cmdSessionHelper() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d := desktop.NewLocal()
	defer d.Close()
	if err := desktop.Serve(ctx, os.Stdin, os.Stdout, d); err != nil {
		fmt.Fprintln(os.Stderr, "session helper:", err)
		return 1
	}
	return 0
}
