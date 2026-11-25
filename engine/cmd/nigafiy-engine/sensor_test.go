package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSensorAliasNames(t *testing.T) {
	yes := []string{
		"nigafiy-sensor", "nigafiy-sensor.exe", "NIGAFIY-SENSOR.EXE", "/usr/local/bin/nigafiy-sensor",
		`C:\Program Files\Nigafiy\resources\collector\nigafiy-sensor.exe`, "lan-collector", "/usr/local/bin/lan-collector", "Lan-Collector.exe",
	}
	no := []string{"nigafiy-engine", "nigafiy-engine.exe", `C:\x\nigafiy-engine.exe`, "/usr/local/bin/nigafiy-engine", "sensor", "nigafiy-sensor-old", "nigafiy-agent.exe", ""}
	for _, n := range yes {
		if !sensorAlias(n) {
			t.Errorf("%q should run the Sensor", n)
		}
	}
	for _, n := range no {
		if sensorAlias(n) {
			t.Errorf("%q should run the engine", n)
		}
	}
}

func TestSensorSubcommandPassesEveryArgument(t *testing.T) {
	var got []string
	orig := runSensor
	runSensor = func(args []string, stdout, stderr io.Writer) int { got = args; return 7 }
	t.Cleanup(func() { runSensor = orig })
	var out, errOut bytes.Buffer
	if code := realMain([]string{"sensor", "-config", "c.yaml", "--check-config"}, &out, &errOut); code != 7 {
		t.Fatalf("exit code %d, want the Sensor's", code)
	}
	if strings.Join(got, " ") != "-config c.yaml --check-config" {
		t.Fatalf("Sensor got %q", got)
	}
	// `run` still means engine mode.
	got = nil
	realMain([]string{"run", "--bogus"}, &out, &errOut)
	if got != nil {
		t.Fatalf("run reached the Sensor: %q", got)
	}
}

// The real Sensor command line behind `nigafiy-engine sensor`: the old program's flags, output,
// exit codes and environment (new names and the legacy LAN_COLLECTOR_* ones).
func TestSensorSubcommandIsTheOldSensorCommandLine(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := realMain([]string{"sensor", "-version"}, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "nigafiy-sensor "+Version {
		t.Fatalf("-version: %d %q %q", code, out.String(), errOut.String())
	}

	dir := t.TempDir()
	cfgFile := filepath.Join(dir, "collector.yaml")
	os.WriteFile(cfgFile, []byte("server_url: https://nigafiy.example.com\nstate_dir: "+filepathYAML(filepath.Join(dir, "state"))+"\n"), 0o600)
	for _, k := range []string{"NIGAFIY_SENSOR_CONFIG", "LAN_COLLECTOR_CONFIG", "NIGAFIY_SENSOR_SERVER_URL", "LAN_COLLECTOR_SERVER_URL", "NIGAFIY_SENSOR_STATE_DIR", "LAN_COLLECTOR_STATE_DIR"} {
		t.Setenv(k, "")
	}

	out.Reset()
	errOut.Reset()
	if code := realMain([]string{"sensor", "-config", cfgFile, "-check-config"}, &out, &errOut); code != 0 || !strings.Contains(out.String(), "configuration is valid") {
		t.Fatalf("-check-config with a file: %d %q %q", code, out.String(), errOut.String())
	}
	// --name works as well as -name.
	out.Reset()
	if code := realMain([]string{"sensor", "--config=" + cfgFile, "--check-config"}, &out, &errOut); code != 0 {
		t.Fatalf("--config=: %d %q", code, errOut.String())
	}

	// No file: the legacy environment of Sensors deployed before the rename still configures it.
	t.Setenv("LAN_COLLECTOR_SERVER_URL", "https://nigafiy.example.com")
	t.Setenv("LAN_COLLECTOR_STATE_DIR", filepath.Join(dir, "legacy-state"))
	out.Reset()
	errOut.Reset()
	if code := realMain([]string{"sensor", "-check-config"}, &out, &errOut); code != 0 || !strings.Contains(out.String(), "configuration is valid") {
		t.Fatalf("legacy env: %d %q %q", code, out.String(), errOut.String())
	}
	// The config file named through the legacy LAN_COLLECTOR_CONFIG.
	t.Setenv("LAN_COLLECTOR_SERVER_URL", "")
	t.Setenv("LAN_COLLECTOR_CONFIG", cfgFile)
	out.Reset()
	if code := realMain([]string{"sensor", "-check-config"}, &out, &errOut); code != 0 {
		t.Fatalf("LAN_COLLECTOR_CONFIG: %d %q", code, errOut.String())
	}

	// An invalid configuration and a bad flag exit 2, as the old program did.
	bad := filepath.Join(dir, "bad.yaml")
	os.WriteFile(bad, []byte("server_url: ftp://nope\nnot_a_key: 1\n"), 0o600)
	if code := realMain([]string{"sensor", "-config", bad, "-check-config"}, &out, &errOut); code != 2 {
		t.Fatalf("invalid config: exit %d", code)
	}
	if code := realMain([]string{"sensor", "-bogus"}, &out, &errOut); code != 2 {
		t.Fatalf("bad flag: exit %d", code)
	}
}

func filepathYAML(p string) string { return `"` + strings.ReplaceAll(p, `\`, `\\`) + `"` }

// Builds the real executable and runs it under the old program names (a copy here; a link in
// the Docker image and after upgrade-to-engine.sh). CGO is off, as in every release build.
func TestBuiltExecutableAnswersToTheOldSensorNames(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the executable")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go not on PATH")
	}
	dir := t.TempDir()
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	engineExe := filepath.Join(dir, "nigafiy-engine"+exe)
	build := exec.Command(goBin, "build", "-trimpath", "-ldflags", "-X main.Version=9.8.7", "-o", engineExe, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	run := func(path string, args ...string) string {
		t.Helper()
		out, err := exec.Command(path, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", filepath.Base(path), args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run(engineExe, "version"); got != "9.8.7" {
		t.Fatalf("engine version %q (main.Version not stamped)", got)
	}
	if got := run(engineExe, "sensor", "-version"); got != "nigafiy-sensor 9.8.7" {
		t.Fatalf("sensor -version %q", got)
	}
	b, _ := os.ReadFile(engineExe)
	for _, name := range []string{"nigafiy-sensor", "lan-collector"} {
		alias := filepath.Join(dir, name+exe)
		if err := os.WriteFile(alias, b, 0o755); err != nil {
			t.Fatal(err)
		}
		if got := run(alias, "-version"); got != "nigafiy-sensor 9.8.7" {
			t.Fatalf("%s -version %q", name, got)
		}
	}
}
