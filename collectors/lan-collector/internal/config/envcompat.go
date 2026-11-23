package config

import (
	"log"
	"os"
	"sync"
)

// LegacyEnv maps each NIGAFIY_SENSOR_* variable to the LAN_COLLECTOR_* name it replaced
// (docs/architecture/naming.md). The new name wins; the old one still works so Sensors deployed
// before the rename (systemd units, Docker run lines, scripts) keep their settings.
var LegacyEnv = map[string]string{
	"NIGAFIY_SENSOR_CONFIG":           "LAN_COLLECTOR_CONFIG",
	"NIGAFIY_SENSOR_SERVER_URL":       "LAN_COLLECTOR_SERVER_URL",
	"NIGAFIY_SENSOR_ENROLLMENT_TOKEN": "LAN_COLLECTOR_ENROLLMENT_TOKEN",
	"NIGAFIY_SENSOR_DNS_LISTEN":       "LAN_COLLECTOR_DNS_LISTEN",
	"NIGAFIY_SENSOR_MNDP_LISTEN":      "LAN_COLLECTOR_MNDP_LISTEN",
	"NIGAFIY_SENSOR_STATE_DIR":        "LAN_COLLECTOR_STATE_DIR",
	"NIGAFIY_SENSOR_TLS_PIN_SHA256":   "LAN_COLLECTOR_TLS_PIN_SHA256",
}

var (
	lookupEnv  = os.LookupEnv
	warnLegacy = func(old, name string) { log.Printf("%s is deprecated, use %s (the old name still works)", old, name) }
	warned     sync.Map
)

// Getenv returns the value of name, else of its legacy LAN_COLLECTOR_* twin, else "". Reading a
// legacy name logs one deprecation line per name per process.
func Getenv(name string) string {
	if v, _ := lookupEnv(name); v != "" {
		return v
	}
	old, ok := LegacyEnv[name]
	if !ok {
		return ""
	}
	v, _ := lookupEnv(old)
	if v != "" {
		if _, seen := warned.LoadOrStore(old, true); !seen {
			warnLegacy(old, name)
		}
	}
	return v
}
