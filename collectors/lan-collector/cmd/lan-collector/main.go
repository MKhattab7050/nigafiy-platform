// lan-collector is the LAN Detective edge collector.
//
// It runs inside the monitored network, makes only outbound HTTPS connections to the LAN Detective
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

	"github.com/lan-detective/lan-collector/internal/agent"
	"github.com/lan-detective/lan-collector/internal/config"
)

// Version is set at build time: -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0-dev"

func main() {
	configPath := flag.String("config", os.Getenv("LAN_COLLECTOR_CONFIG"), "path to collector.yaml (optional when LAN_COLLECTOR_* environment variables are set)")
	showVersion := flag.Bool("version", false, "print version and exit")
	checkOnly := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("lan-collector", Version)
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
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})).With("service", "lan-collector", "version", Version)
	if cfg.AllowInsecureHTTP || cfg.AllowLoopbackScopes {
		log.Warn("development switches are enabled; do not use this configuration in production",
			"allow_insecure_http", cfg.AllowInsecureHTTP, "allow_loopback_scopes", cfg.AllowLoopbackScopes)
	}

	a, err := agent.New(cfg, agent.SystemDeps(), log, Version, agent.DefaultTuning())
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
