package config

import (
	"log"
	"os"
	"sync"
)

// LegacyEnv maps each NIGAFIY_AGENT_* variable to the LAN_ENDPOINT_* name it replaced (and the
// opt-in live test switches to their LD_* names), see docs/architecture/naming.md. The new name
// wins; the old one still works so agents and install scripts from before the rename keep working.
var LegacyEnv = map[string]string{
	"NIGAFIY_AGENT_SERVER_URL":          "LAN_ENDPOINT_SERVER_URL",
	"NIGAFIY_AGENT_ENROLLMENT_TOKEN":    "LAN_ENDPOINT_ENROLLMENT_TOKEN",
	"NIGAFIY_AGENT_STATE_DIR":           "LAN_ENDPOINT_STATE_DIR",
	"NIGAFIY_AGENT_CA_FILE":             "LAN_ENDPOINT_CA_FILE",
	"NIGAFIY_AGENT_TLS_PIN_SHA256":      "LAN_ENDPOINT_TLS_PIN_SHA256",
	"NIGAFIY_AGENT_LOG_LEVEL":           "LAN_ENDPOINT_LOG_LEVEL",
	"NIGAFIY_AGENT_ALLOW_INSECURE_HTTP": "LAN_ENDPOINT_ALLOW_INSECURE_HTTP",
	"NIGAFIY_LIVE_COMPLIANCE":           "LD_LIVE_COMPLIANCE",
	"NIGAFIY_LIVE_UPDATES":              "LD_LIVE_UPDATES",
}

var (
	lookupEnv  = os.LookupEnv
	warnLegacy = func(old, name string) { log.Printf("%s is deprecated, use %s (the old name still works)", old, name) }
	warned     sync.Map
)

// Getenv returns the value of name, else of its legacy twin, else "". Reading a legacy name logs
// one deprecation line per name per process.
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
