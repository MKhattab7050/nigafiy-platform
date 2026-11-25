// Package sensorcmd is the Nigafiy Sensor's command line: the flags, environment variables,
// configuration file, logging and signal handling of what used to be the standalone
// nigafiy-sensor (before that lan-collector) program.
//
// Since the engine and the Sensor became one executable (docs/architecture/engine-sensor.md) the
// shipped program is nigafiy-engine: `nigafiy-engine sensor [flags]` calls Main, and so does a
// copy or link of nigafiy-engine named nigafiy-sensor or lan-collector. cmd/nigafiy-sensor keeps a
// Sensor-only build of this module for development; it is not shipped.
//
// The Sensor runs inside the monitored network, makes only outbound HTTPS connections to the
// Nigafiy server, and probes only the network ranges an administrator has authorized.
package sensorcmd

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/nigafiy/sensor/internal/agent"
	"github.com/nigafiy/sensor/internal/config"
	// Router drivers shipped in the Sensor (they register with internal/router).
	_ "github.com/nigafiy/sensor/internal/router/asus"
	_ "github.com/nigafiy/sensor/internal/router/ciscoxe"
	_ "github.com/nigafiy/sensor/internal/router/dlink"
	_ "github.com/nigafiy/sensor/internal/router/fortigate"
	_ "github.com/nigafiy/sensor/internal/router/huawei"
	_ "github.com/nigafiy/sensor/internal/router/huaweilte"
	_ "github.com/nigafiy/sensor/internal/router/mikrotik"
	_ "github.com/nigafiy/sensor/internal/router/omada"
	_ "github.com/nigafiy/sensor/internal/router/openwrt"
	_ "github.com/nigafiy/sensor/internal/router/opnsense"
	_ "github.com/nigafiy/sensor/internal/router/pfsense"
	_ "github.com/nigafiy/sensor/internal/router/tenda"
	_ "github.com/nigafiy/sensor/internal/router/tplink"
	_ "github.com/nigafiy/sensor/internal/router/unifi"
	_ "github.com/nigafiy/sensor/internal/router/zte"
	_ "github.com/nigafiy/sensor/internal/router/zyxel"
)

// Exit codes, the same as the standalone program had.
const (
	ExitOK    = 0
	ExitError = 1 // the Sensor could not start, or stopped with an error
	ExitUsage = 2 // bad flags or an invalid configuration
)

// Main runs the Sensor with the given arguments (without the program name or the `sensor`
// subcommand) until SIGINT/SIGTERM, and returns the process exit code. version is reported to the
// server and printed by -version.
func Main(args []string, stdout, stderr io.Writer, version string) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return Run(ctx, args, stdout, stderr, version)
}

// Run is Main with the caller's context (tests, and anything that wants to stop the Sensor
// without a signal).
func Run(ctx context.Context, args []string, stdout, stderr io.Writer, version string) int {
	fs := flag.NewFlagSet("nigafiy-sensor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", config.Getenv("NIGAFIY_SENSOR_CONFIG"), "path to collector.yaml (optional when NIGAFIY_SENSOR_* environment variables, or the legacy LAN_COLLECTOR_* ones, are set)")
	showVersion := fs.Bool("version", false, "print version and exit")
	checkOnly := fs.Bool("check-config", false, "validate the configuration and exit")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "unexpected argument %q\n", fs.Arg(0))
		return ExitUsage
	}

	if *showVersion {
		fmt.Fprintln(stdout, "nigafiy-sensor", version)
		return ExitOK
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitUsage
	}
	if *checkOnly {
		fmt.Fprintln(stdout, "configuration is valid")
		return ExitOK
	}

	level := map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError}[cfg.LogLevel]
	log := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: level})).With("service", "nigafiy-sensor", "version", version)
	if cfg.AllowInsecureHTTP || cfg.AllowLoopbackScopes {
		log.Warn("development switches are enabled; do not use this configuration in production",
			"allow_insecure_http", cfg.AllowInsecureHTTP, "allow_loopback_scopes", cfg.AllowLoopbackScopes)
	}

	deps := agent.SystemDeps()
	deps.DNSListen = cfg.DNSListen
	if deps.DNSListen == "off" {
		deps.DNSListen = ""
	}
	deps.MNDPListen = cfg.MNDPListen
	if deps.MNDPListen == "off" {
		deps.MNDPListen = ""
	}
	a, err := agent.New(cfg, deps, log, version, agent.DefaultTuning())
	if err != nil {
		log.Error("cannot start", "error", err.Error())
		return ExitError
	}

	log.Info("collector starting", "server", cfg.ServerURL, "state_dir", cfg.StateDir,
		"max_pps", cfg.Limits.MaxPPS, "max_concurrency", cfg.Limits.MaxConcurrency, "local_allow_list", cfg.AllowedCIDRs)

	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("collector stopped with an error", "error", err.Error())
		return ExitError
	}
	return ExitOK
}
