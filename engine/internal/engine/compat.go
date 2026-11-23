package engine

import (
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Names after the rename (docs/architecture/naming.md). The engine was born as Nigafiy, but the
// programs it runs and the folders it shares were called LAN Detective before.

// legacyEnv maps each NIGAFIY_* variable the engine reads to the LD_* name it replaced.
var legacyEnv = map[string]string{
	"NIGAFIY_DATA_DIR":   "LD_DATA_DIR",
	"NIGAFIY_BUNDLE_DIR": "LD_BUNDLE_DIR",
}

var warnedEnv sync.Map

// envCompat reads name, else its legacy LD_* twin (logging one deprecation line per name).
func envCompat(getenv func(string) string, name string) string {
	if v := getenv(name); v != "" {
		return v
	}
	old, ok := legacyEnv[name]
	if !ok {
		return ""
	}
	v := getenv(old)
	if v != "" {
		if _, seen := warnedEnv.LoadOrStore(old, true); !seen {
			log.Printf("%s is deprecated, use %s (the old name still works)", old, name)
		}
	}
	return v
}

// Profile folder names under %APPDATA% (os.UserConfigDir).
const (
	ProfileName       = "Nigafiy"
	LegacyProfileName = "LAN Detective"
)

// ProfileDir is the desktop profile folder under configDir: the legacy "LAN Detective" one while it
// exists and "Nigafiy" does not (an install from before the rename, never orphaned), else "Nigafiy".
// The same rule as apps/desktop/src/data-dir.cjs; Milestone 5 moves the legacy folder.
func ProfileDir(configDir string, exists func(string) bool) string {
	legacy := filepath.Join(configDir, LegacyProfileName)
	current := filepath.Join(configDir, ProfileName)
	if exists(legacy) && !exists(current) {
		return legacy
	}
	return current
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
