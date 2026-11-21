// Command nigafiy-engine supervises the local stack (database, API, web server) and the local
// Sensor, in the foreground (`run`) or as the Windows service NigafiyEngine.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nigafiy/engine/internal/engine"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "0.1.0-dev"

const (
	serviceName        = "NigafiyEngine"
	serviceDisplayName = "Nigafiy Engine"
	serviceDescription = "Runs the Nigafiy database, API, web server and local Sensor on this computer."
)

// Exit codes.
const (
	exitOK             = 0
	exitError          = 1
	exitUsage          = 2
	exitAlreadyRunning = 3
)

const usage = `Nigafiy Engine %s

Usage:
  nigafiy-engine run [flags]        run in the foreground (Ctrl+C stops everything)
  nigafiy-engine install [flags]    install the Windows service NigafiyEngine (admin; starts at boot)
  nigafiy-engine uninstall          remove the Windows service (admin)
  nigafiy-engine start | stop       start or stop the Windows service (admin)
  nigafiy-engine status [--control-addr=127.0.0.1:47140]
                                    print the running engine's status
  nigafiy-engine version

Flags of run and install:
`

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(args []string, stdout, stderr io.Writer) int {
	if inService, err := isWindowsService(); err == nil && inService {
		if err := runAsService(args); err != nil {
			return exitError
		}
		return exitOK
	}
	if len(args) == 0 {
		printUsage(stderr)
		return exitUsage
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "run":
		return cmdRun(rest, stdout, stderr)
	case "install":
		return report(stderr, installService(rest, stderr), "installed service "+serviceName, stdout)
	case "uninstall":
		return report(stderr, noArgs(rest, removeService), "removed service "+serviceName, stdout)
	case "start":
		return report(stderr, noArgs(rest, startService), "started service "+serviceName, stdout)
	case "stop":
		return report(stderr, noArgs(rest, stopService), "stopped service "+serviceName, stdout)
	case "status":
		return cmdStatus(rest, stdout, stderr)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, version)
		return exitOK
	case "help", "--help", "-h":
		printUsage(stdout)
		return exitOK
	}
	fmt.Fprintf(stderr, "unknown command %q\n\n", cmd)
	printUsage(stderr)
	return exitUsage
}

func printUsage(w io.Writer) {
	fmt.Fprintf(w, usage, version)
	var cfg engine.Config
	engine.FlagSet("run", &cfg).VisitAll(func(f *flag.Flag) {
		name, help := flag.UnquoteUsage(f)
		if name != "" {
			name = "=" + name
		}
		fmt.Fprintf(w, "  --%s%s\n        %s\n", f.Name, name, help)
	})
}

func noArgs(args []string, fn func() error) error {
	if len(args) > 0 {
		return usageError{fmt.Errorf("unexpected argument %q", args[0])}
	}
	return fn()
}

type usageError struct{ error }

func report(stderr io.Writer, err error, done string, stdout io.Writer) int {
	var ue usageError
	switch {
	case err == nil:
		fmt.Fprintln(stdout, done)
		return exitOK
	case errors.Is(err, flag.ErrHelp):
		return exitUsage
	case errors.As(err, &ue):
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	fmt.Fprintln(stderr, err)
	return exitError
}

// loadConfig parses run/install flags and resolves defaults.
func loadConfig(args []string, mode string, stderr io.Writer) (engine.Config, error) {
	cfg, err := engine.ParseRunFlags(args, stderr)
	if err != nil {
		return cfg, usageError{err}
	}
	cfg.Version = version
	cfg.Mode = mode
	return engine.Resolve(cfg, os.Getenv)
}

func cmdRun(args []string, stdout, stderr io.Writer) int {
	cfg, err := loadConfig(args, "foreground", stderr)
	if err != nil {
		return report(stderr, err, "", stdout)
	}
	cfg.Console = stdout
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = engine.Run(ctx, cfg)
	if errors.Is(err, engine.ErrAlreadyRunning) {
		fmt.Fprintf(stderr, "%v\nNot starting a second one. Use `nigafiy-engine status` to see it.\n", err)
		return exitAlreadyRunning
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	return exitOK
}

func cmdStatus(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	addr := fs.String("control-addr", "", "control API address (default "+engine.DefaultControlAddr+")")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if *addr == "" {
		*addr = os.Getenv(engine.EnvControlAddr)
	}
	if *addr == "" {
		*addr = engine.DefaultControlAddr
	}
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Get("http://" + *addr + "/v1/status")
	if err != nil {
		fmt.Fprintf(stderr, "Nigafiy Engine is not running at %s (%v)\n", *addr, err)
		return exitError
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "unexpected answer from %s: HTTP %d %s\n", *addr, res.StatusCode, body)
		return exitError
	}
	var pretty any
	if err := json.Unmarshal(body, &pretty); err != nil {
		fmt.Fprintf(stderr, "unexpected answer from %s: %v\n", *addr, err)
		return exitError
	}
	out, _ := json.MarshalIndent(pretty, "", "  ")
	fmt.Fprintln(stdout, string(out))
	return exitOK
}
