// Command nigafiy-launcher is one Nigafiy program's launcher (nigafiy-radar.exe, nigafiy-guard.exe, …).
// It finds the Nigafiy desktop runtime and starts it with `--program=<id>`, forwarding a nigafiy://
// link it was opened with. One binary per program, built by `pnpm build:launchers`:
//
//	go build -ldflags "-X main.programID=radar -H windowsgui" -o bin/nigafiy-radar.exe ./cmd/nigafiy-launcher
//
// `--launcher-info` prints {"program": …, "app_user_model_id": …} and exits (the build script checks
// every binary with it). Icons and version resources are added by the Milestone 5 installers.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/nigafiy/engine/internal/launcher"
)

// programID is set at build time with -ldflags "-X main.programID=<id>".
var programID = "hub"

// Seams for tests: how the runtime is started and how the registry is read.
var (
	startRuntime launcher.Starter  = launcher.StartDetached
	readRegistry launcher.Registry = launcher.RegistryRuntime
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if !launcher.ValidProgram(programID) {
		report(stderr, fmt.Sprintf("This launcher was built for an unknown program (%q).", programID))
		return 2
	}
	for _, a := range args {
		if a == "--launcher-info" {
			_ = json.NewEncoder(stdout).Encode(map[string]string{"program": programID, "app_user_model_id": launcher.AppUserModelID(programID)})
			return 0
		}
	}
	exe, _ := os.Executable()
	l := launcher.Locator{Exe: exe, Env: os.Getenv, Registry: readRegistry}
	if _, err := launcher.Launch(programID, args, l, startRuntime); err != nil {
		report(stderr, fmt.Sprintf("Nigafiy could not start.\n\n%v\n\nReinstall Nigafiy, or set %s to the full path of %s.", err, launcher.RuntimeEnv, launcher.RuntimeName))
		return 1
	}
	return 0
}

// report writes the message to stderr and, on Windows (a GUI-subsystem binary has no console), shows it.
func report(stderr io.Writer, msg string) {
	fmt.Fprintln(stderr, msg)
	showError("Nigafiy", msg)
}
