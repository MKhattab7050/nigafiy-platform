package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nigafiy/engine/internal/logs"
	"github.com/nigafiy/engine/internal/update"
)

// cmdUpdateApply is the update helper: a copy of this program, started by the engine
// (POST /v1/update/apply) and left running while the engine stops. It waits for the engine to exit,
// checks the installer again, runs it silently and starts the engine (service) or the desktop app
// again. It is not meant to be run by hand.
func cmdUpdateApply(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("update-apply", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var p update.Plan
	fs.StringVar(&p.DataDir, "data-dir", "", "the engine's data folder")
	fs.StringVar(&p.Request.Installer, "installer", "", "staged installer")
	fs.StringVar(&p.Request.SHA256, "sha256", "", "SHA-256 from the signed manifest")
	fs.StringVar(&p.Request.Version, "version", "", "version being installed")
	fs.StringVar(&p.InstallDir, "install-dir", "", "installation folder")
	fs.StringVar(&p.Publisher, "publisher", "", "required signer thumbprint")
	fs.IntVar(&p.WaitPid, "wait-pid", 0, "engine process to wait for")
	fs.StringVar(&p.ServiceName, "service", "", "Windows service to start afterwards")
	fs.StringVar(&p.RestartExe, "restart-exe", "", "program to start afterwards (the desktop app)")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if p.DataDir == "" || !filepath.IsAbs(p.DataDir) {
		fmt.Fprintln(stderr, "--data-dir must be an absolute path")
		return exitUsage
	}
	if p.ServiceName != "" && p.ServiceName != serviceName {
		fmt.Fprintf(stderr, "--service may only name %s\n", serviceName)
		return exitUsage
	}
	if p.ServiceName != "" && p.RestartExe != "" {
		fmt.Fprintln(stderr, "--service and --restart-exe exclude each other")
		return exitUsage
	}
	tp, err := update.NormalizeThumbprint(p.Publisher)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	p.Publisher = tp
	p.WaitFor = 3 * time.Minute

	logFile, err := logs.OpenRotating(filepath.Join(p.DataDir, "logs", "update.log"), logs.DefaultMaxSize, logs.DefaultKeep)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	defer logFile.Close()
	lw := logs.NewLineWriter(io.MultiWriter(logFile, stdout), nil)
	defer lw.Flush()
	lg := log.New(lw, "", log.LstdFlags|log.LUTC)

	res := update.Apply(p, update.Deps{
		WaitExit:     update.WaitExit,
		RunInstaller: update.RunInstaller,
		CheckSig:     update.CheckAuthenticode,
		StartService: func(string) error { return startService() },
		StartExe: func(path string) error {
			_, err := update.StartDetached(path, nil, envWithout(os.Environ(), "ELECTRON_RUN_AS_NODE"))
			return err
		},
		Logf: lg.Printf,
	})
	if !res.OK {
		lg.Printf("result: not installed: %s", res.Error)
		return exitError
	}
	if res.Error != "" {
		lg.Printf("result: %s", res.Error)
		return exitError
	}
	lg.Printf("result: version %s installed and restarted", res.Version)
	return exitOK
}

func envWithout(env []string, names ...string) []string {
	out := env[:0:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		drop := false
		for _, n := range names {
			if strings.EqualFold(k, n) {
				drop = true
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}
