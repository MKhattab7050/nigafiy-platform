package main

import "github.com/nigafiy/engine/internal/engine"

// serviceArgs is the command line the service is installed with: `run` plus every resolved path
// in --name=value form. The service runs as LocalSystem, whose PATH, %APPDATA% and working
// directory differ from the installing user's, so nothing is left to be guessed at boot.
func serviceArgs(cfg engine.Config, ownerSID string) []string {
	args := []string{"run"}
	add := func(name, value string) {
		if value != "" {
			args = append(args, "--"+name+"="+value)
		}
	}
	add("data-dir", cfg.DataDir)
	add("node", cfg.Node)
	add("stack-script", cfg.StackScript)
	add("bundle-dir", cfg.BundleDir)
	add("sensor-exe", cfg.SensorExe)
	add("sensor-config", cfg.SensorConfig)
	if cfg.NoSensor {
		args = append(args, "--no-sensor")
	}
	add("control-addr", cfg.ControlAddr)
	add("owner-sid", ownerSID)
	return args
}
