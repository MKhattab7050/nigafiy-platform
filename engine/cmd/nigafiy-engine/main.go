// Command nigafiy-engine is the one Nigafiy executable for the Engine and the Sensor
// (docs/architecture/engine-sensor.md).
//
// Engine mode supervises the local stack (database, API, web server) and the local Sensor, in the
// foreground (`run`) or as the Windows service NigafiyEngine. The Sensor runs as a child process
// of this same executable (`nigafiy-engine sensor -config …`), so a crash in it never stops the
// engine. `nigafiy-engine sensor [flags]` runs the Sensor alone (branch sites), with the flags,
// environment and config file of the old nigafiy-sensor program; so does this executable when it
// is named nigafiy-sensor or lan-collector (a link or copy kept for installs in the field).
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
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nigafiy/engine/internal/engine"
	"github.com/nigafiy/sensor/sensorcmd"
)

// Version is set at build time with -ldflags "-X main.Version=…" (the Engine and the Sensor share
// it; the Sensor reports it to the server).
var Version = "0.1.0-dev"

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
  nigafiy-engine install-info [--bundle-dir=<install>\resources\backend]
                                    how this copy was installed (MSI or NSIS) and the programs
                                    chosen at install time, read from the registry (read-only)
  nigafiy-engine sensor [-config <collector.yaml>] [-check-config] [-version]
                                    run the Sensor alone (a branch site with no local stack); the
                                    same flags, NIGAFIY_SENSOR_* (and legacy LAN_COLLECTOR_*)
                                    environment and config file as the old nigafiy-sensor program
  nigafiy-engine version

Flags of run and install:
`

func main() {
	if sensorAlias(os.Args[0]) {
		os.Exit(runSensor(os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(realMain(os.Args[1:], os.Stdout, os.Stderr))
}

// runSensor is the Sensor mode. A variable so tests can stand in for the real Sensor.
var runSensor = func(args []string, stdout, stderr io.Writer) int {
	return sensorcmd.Main(args, stdout, stderr, Version)
}

// sensorAliases are the program names that mean "run the Sensor with every argument": the old
// standalone Sensor's names, kept so a link or copy of this executable under that name replaces it
// in systemd units, Docker entrypoints and scripts in the field.
var sensorAliases = []string{"nigafiy-sensor", "lan-collector"}

// sensorAlias reports whether argv0 names this executable as the old Sensor program.
func sensorAlias(argv0 string) bool {
	base := filepath.Base(strings.ReplaceAll(argv0, `\`, "/"))
	base = strings.ToLower(base)
	base = strings.TrimSuffix(base, ".exe")
	for _, a := range sensorAliases {
		if base == a {
			return true
		}
	}
	return false
}

func realMain(args []string, stdout, stderr io.Writer) int {
	// Before the service check: the Sensor never runs as the engine's Windows service.
	if len(args) > 0 && args[0] == "sensor" {
		return runSensor(args[1:], stdout, stderr)
	}
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
	case "install-info":
		return cmdInstallInfo(rest, stdout, stderr)
	case "update-apply":
		return cmdUpdateApply(rest, stdout, stderr)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, Version)
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
	fmt.Fprintf(w, usage, Version)
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
	cfg.Version = Version
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

// cmdInstallInfo prints what the engine would use at start: the install kind and the programs.
func cmdInstallInfo(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("install-info", flag.ContinueOnError)
	fs.SetOutput(stderr)
	bundle := fs.String("bundle-dir", "", `the installed app's resources\backend folder (default: next to this program in an installed app)`)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if *bundle == "" {
		if exe, err := os.Executable(); err == nil {
			// <install>\resources\engine\nigafiy-engine.exe: the bundle is <install>\resources\backend.
			*bundle = filepath.Join(filepath.Dir(filepath.Dir(exe)), "backend")
		}
	}
	info := engine.InstallInfo(*bundle, os.Getenv)
	out, _ := json.MarshalIndent(info, "", "  ")
	fmt.Fprintln(stdout, string(out))
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
