// lan-collector is the Nigafiy edge collector.
//
// It runs inside the monitored network, makes only outbound HTTPS connections to the Nigafiy
// cloud, and probes only the network ranges an administrator has authorized.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/nigafiy/sensor/internal/agent"
	"github.com/nigafiy/sensor/internal/config"
	// Router drivers shipped in the collector (they register with internal/router).
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

// Version is set at build time: -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0-dev"

func main() {
	configPath := flag.String("config", config.Getenv("NIGAFIY_SENSOR_CONFIG"), "path to collector.yaml (optional when NIGAFIY_SENSOR_* environment variables, or the legacy LAN_COLLECTOR_* ones, are set)")
	showVersion := flag.Bool("version", false, "print version and exit")
	checkOnly := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("nigafiy-sensor", Version)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *checkOnly {
		fmt.Println("configuration is valid")
		return
	}

	level := map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError}[cfg.LogLevel]
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})).With("service", "nigafiy-sensor", "version", Version)
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
	a, err := agent.New(cfg, deps, log, Version, agent.DefaultTuning())
	if err != nil {
		log.Error("cannot start", "error", err.Error())
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("collector starting", "server", cfg.ServerURL, "state_dir", cfg.StateDir,
		"max_pps", cfg.Limits.MaxPPS, "max_concurrency", cfg.Limits.MaxConcurrency, "local_allow_list", cfg.AllowedCIDRs)

	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("collector stopped with an error", "error", err.Error())
		os.Exit(1)
	}
}
