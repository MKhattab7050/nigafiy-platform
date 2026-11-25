// Command nigafiy-sensor is a Sensor-only build of this module, for development and for the
// module's own tests and cross-builds. It is NOT shipped: every installer, the Docker image and
// the systemd unit run the single Nigafiy executable, `nigafiy-engine sensor`, which calls the
// same sensorcmd.Main (docs/architecture/engine-sensor.md).
package main

import (
	"os"

	"github.com/nigafiy/sensor/sensorcmd"
)

// Version is set at build time: -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0-dev"

func main() {
	os.Exit(sensorcmd.Main(os.Args[1:], os.Stdout, os.Stderr, Version))
}
