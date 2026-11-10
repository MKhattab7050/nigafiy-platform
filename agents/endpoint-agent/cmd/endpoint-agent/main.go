// endpoint-agent is the LAN Detective managed-endpoint agent.
//
// Installed on company-owned computers, it reports hardware, health, running processes, services,
// installed software and active network connections over outbound HTTPS, and executes authorized
// IT administration actions from the closed command allow-list.
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

	"github.com/lan-detective/endpoint-agent/internal/agent"
	"github.com/lan-detective/endpoint-agent/internal/config"
)

var Version = "0.1.0"

func main() {
	cfg := config.FromEnv()
	flag.StringVar(&cfg.ServerURL, "server", cfg.ServerURL, "LAN Detective server URL (or LAN_ENDPOINT_SERVER_URL)")
	flag.StringVar(&cfg.EnrollmentToken, "token", cfg.EnrollmentToken, "single-use enrollment token (or LAN_ENDPOINT_ENROLLMENT_TOKEN)")
	flag.StringVar(&cfg.StateDir, "state-dir", cfg.StateDir, "directory for endpoint credential state")
	flag.StringVar(&cfg.CAFile, "ca-file", cfg.CAFile, "optional PEM CA bundle")
	flag.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level: debug, info, warn, error")
	flag.BoolVar(&cfg.AllowInsecureHTTP, "allow-insecure-http", cfg.AllowInsecureHTTP, "allow http:// server URL (local development only)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("lan-endpoint-agent", Version)
		return
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	level := map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError}[cfg.LogLevel]
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})).With("service", "lan-endpoint-agent", "version", Version)

	ag, err := agent.New(&cfg, agent.SystemDeps(), log, Version, agent.DefaultTuning())
	if err != nil {
		log.Error("cannot start endpoint agent", "error", err.Error())
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("endpoint agent starting", "server", cfg.ServerURL, "state_dir", cfg.StateDir)

	if err := ag.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("endpoint agent stopped with an error", "error", err.Error())
		os.Exit(1)
	}
}

