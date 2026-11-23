package engine

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/nigafiy/engine/internal/update"
)

// DefaultControlAddr is where the engine's control API listens.
const DefaultControlAddr = "127.0.0.1:47140"

// Config is everything `nigafiy-engine run` needs. Resolve fills in the defaults.
type Config struct {
	Version string
	Mode    string // "service" | "foreground"

	DataDir      string
	Node         string
	StackScript  string
	BundleDir    string // installed desktop app: the packaged API + web server (NIGAFIY_BUNDLE_DIR)
	SensorExe    string
	SensorConfig string
	NoSensor     bool // the desktop app runs the Sensor itself; the engine leaves it alone
	ControlAddr  string
	OwnerSID     string // a further user allowed to read the control token (set by install)
	// UpdatePublisher, when set, is the SHA-1 thumbprint of the certificate every update installer
	// must be Authenticode-signed with (checked again right before the installer runs).
	UpdatePublisher string

	// Console, when set, also receives the engine log (foreground mode).
	Console io.Writer
	// OnListen is called with the control address once it is listening.
	OnListen func(addr string)
}

// Environment variables that stand in for the flags of the same name.
const (
	EnvDataDir      = "NIGAFIY_ENGINE_DATA_DIR"
	EnvNode         = "NIGAFIY_ENGINE_NODE"
	EnvStackScript  = "NIGAFIY_ENGINE_STACK_SCRIPT"
	EnvBundleDir    = "NIGAFIY_ENGINE_BUNDLE_DIR"
	EnvSensorExe    = "NIGAFIY_ENGINE_SENSOR_EXE"
	EnvSensorConfig = "NIGAFIY_ENGINE_SENSOR_CONFIG"
	EnvControlAddr  = "NIGAFIY_ENGINE_CONTROL_ADDR"
	// The same variable the API reads, so one setting covers both checks.
	EnvUpdatePublisher = "NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT"
)

// FlagSet returns the flags of `run` (and `install`, which records them in the service's command
// line). Both --name value and --name=value work.
func FlagSet(name string, cfg *Config) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.StringVar(&cfg.DataDir, "data-dir", "", "data folder (default: <repo>/.data in a source checkout, else %APPDATA%\\Nigafiy\\data, or the legacy %APPDATA%\\Nigafiy\\data while only that exists) [env "+EnvDataDir+"]")
	fs.StringVar(&cfg.Node, "node", "", "Node.js 24 executable, or the desktop app's exe (run with ELECTRON_RUN_AS_NODE=1) [env "+EnvNode+"]")
	fs.StringVar(&cfg.StackScript, "stack-script", "", "the stack launcher, local.mjs (default: <repo>/scripts/local.mjs) [env "+EnvStackScript+"]")
	fs.StringVar(&cfg.BundleDir, "bundle-dir", "", "installed app only: folder with the packaged API and web server, passed on as NIGAFIY_BUNDLE_DIR [env "+EnvBundleDir+"]")
	fs.StringVar(&cfg.SensorExe, "sensor-exe", "", "the Sensor program (default: <repo>/collectors/lan-collector/bin/nigafiy-sensor.exe) [env "+EnvSensorExe+"]")
	fs.StringVar(&cfg.SensorConfig, "sensor-config", "", "the Sensor's configuration; the Sensor runs only once it exists (default: <data-dir>/collector/collector.yaml) [env "+EnvSensorConfig+"]")
	fs.BoolVar(&cfg.NoSensor, "no-sensor", false, "do not supervise the Sensor (the desktop app runs it)")
	fs.StringVar(&cfg.ControlAddr, "control-addr", "", "control API address, loopback only (default "+DefaultControlAddr+") [env "+EnvControlAddr+"]")
	fs.StringVar(&cfg.OwnerSID, "owner-sid", "", "SID of a further user allowed to read the control token (recorded by install)")
	fs.StringVar(&cfg.UpdatePublisher, "update-publisher", "", "SHA-1 thumbprint of the certificate update installers must be signed with [env "+EnvUpdatePublisher+"]")
	return fs
}

// ParseRunFlags parses the arguments of `run`.
func ParseRunFlags(args []string, stderr io.Writer) (Config, error) {
	var cfg Config
	fs := FlagSet("run", &cfg)
	fs.SetOutput(stderr)
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	if fs.NArg() > 0 {
		return cfg, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return cfg, nil
}

// Resolve fills in every path the flags left empty, from the environment and the source checkout
// the engine is in (if any), and makes all paths absolute. getenv is os.Getenv outside tests.
func Resolve(cfg Config, getenv func(string) string) (Config, error) {
	pick := func(v *string, env string) {
		if *v == "" {
			*v = getenv(env)
		}
	}
	pick(&cfg.DataDir, EnvDataDir)
	pick(&cfg.Node, EnvNode)
	pick(&cfg.StackScript, EnvStackScript)
	pick(&cfg.BundleDir, EnvBundleDir)
	pick(&cfg.SensorExe, EnvSensorExe)
	pick(&cfg.SensorConfig, EnvSensorConfig)
	pick(&cfg.ControlAddr, EnvControlAddr)
	pick(&cfg.UpdatePublisher, EnvUpdatePublisher)
	if tp, err := update.NormalizeThumbprint(cfg.UpdatePublisher); err != nil {
		return cfg, err
	} else {
		cfg.UpdatePublisher = tp
	}

	repo := ""
	if cfg.StackScript == "" || cfg.DataDir == "" || cfg.SensorExe == "" {
		repo = findRepoRoot()
	}
	if cfg.StackScript == "" && repo != "" {
		cfg.StackScript = filepath.Join(repo, "scripts", "local.mjs")
	}
	if cfg.DataDir == "" {
		// The same folder scripts/local.mjs uses: NIGAFIY_DATA_DIR (legacy LD_DATA_DIR), else <repo>/.data.
		switch {
		case envCompat(getenv, "NIGAFIY_DATA_DIR") != "":
			cfg.DataDir = envCompat(getenv, "NIGAFIY_DATA_DIR")
		case repo != "":
			cfg.DataDir = filepath.Join(repo, ".data")
		default:
			dir, err := os.UserConfigDir()
			if err != nil {
				return cfg, fmt.Errorf("no data folder: pass --data-dir (%w)", err)
			}
			cfg.DataDir = filepath.Join(ProfileDir(dir, pathExists), "data")
		}
	}
	if cfg.SensorExe == "" && repo != "" {
		name := "nigafiy-sensor"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		cfg.SensorExe = filepath.Join(repo, "collectors", "lan-collector", "bin", name)
	}
	if cfg.SensorConfig == "" {
		cfg.SensorConfig = filepath.Join(cfg.DataDir, "collector", "collector.yaml")
	}
	if cfg.Node == "" {
		cfg.Node = findNode()
	}
	if cfg.ControlAddr == "" {
		cfg.ControlAddr = DefaultControlAddr
	}
	if err := checkLoopback(cfg.ControlAddr); err != nil {
		return cfg, err
	}
	for _, p := range []*string{&cfg.DataDir, &cfg.StackScript, &cfg.BundleDir, &cfg.SensorExe, &cfg.SensorConfig} {
		if *p == "" {
			continue
		}
		abs, err := filepath.Abs(*p)
		if err != nil {
			return cfg, err
		}
		*p = abs
	}
	if cfg.Node != "" && (filepath.IsAbs(cfg.Node) || filepath.Base(cfg.Node) != cfg.Node) {
		if abs, err := filepath.Abs(cfg.Node); err == nil {
			cfg.Node = abs
		}
	}
	return cfg, nil
}

// checkLoopback refuses a control address that is not a loopback IP literal with a port.
func checkLoopback(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("control address %q: %w", addr, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("control address %q must be a loopback IP such as 127.0.0.1", addr)
	}
	if port == "" {
		return errors.New("control address needs a port")
	}
	return nil
}

// findRepoRoot walks up from the engine's executable, then from the working directory, looking for
// scripts/local.mjs. Empty when the engine is not in a source checkout.
func findRepoRoot() string {
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, dir := range starts {
		for i := 0; i < 8; i++ {
			if info, err := os.Stat(filepath.Join(dir, "scripts", "local.mjs")); err == nil && !info.IsDir() {
				return dir
			}
			up := filepath.Dir(dir)
			if up == dir {
				break
			}
			dir = up
		}
	}
	return ""
}

// findNode is node from PATH, else the standard Windows install location.
func findNode() string {
	if p, err := exec.LookPath("node"); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	if runtime.GOOS == "windows" {
		p := `C:\Program Files\nodejs\node.exe`
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}
