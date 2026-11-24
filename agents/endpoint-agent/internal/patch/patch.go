// Package patch reads the updates a computer is missing and installs the ones IT approved
// (Fleet Pro). Each operating system uses its own updater, named on every report:
//
//	Windows  the Windows Update Agent COM API (Microsoft.Update.Session), pure Go IDispatch calls
//	Linux    apt (Debian, Ubuntu) or dnf (Fedora, RHEL and rebuilds)
//	macOS    softwareupdate
//
// Installing needs administrator / root rights: a report says whether this agent can install
// (install_supported) and the server never queues an install it cannot do. Nothing here installs
// on its own: installs run only when the server sends patch_install inside a maintenance window.
package patch

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Update is one missing update.
type Update struct {
	// ID identifies the update for approvals: the WUA UpdateID, or "apt:name=version",
	// "dnf:name-[epoch:]version-release.arch", "softwareupdate:label".
	ID             string `json:"update_id"`
	Title          string `json:"title"`
	KB             string `json:"kb,omitempty"`
	Classification string `json:"classification"`
	Severity       string `json:"severity,omitempty"`
	// SizeBytes: 0 when the updater does not say.
	SizeBytes      int64  `json:"size_bytes,omitempty"`
	RebootRequired *bool  `json:"reboot_required,omitempty"`
	PublishedAt    string `json:"published_at,omitempty"`
}

// Status is one scan.
type Status struct {
	Source           string    `json:"source"`
	InstallSupported bool      `json:"install_supported"`
	ScannedAt        time.Time `json:"scanned_at"`
	Error            string    `json:"scan_error,omitempty"`
	RebootPending    *bool     `json:"reboot_pending,omitempty"`
	Updates          []Update  `json:"updates"`
}

// Item is one approved update to install.
type Item struct {
	ID    string `json:"update_id"`
	Title string `json:"title"`
	KB    string `json:"kb,omitempty"`
}

// ItemResult: succeeded | failed | aborted | not_started (not missing any more, or never reached).
type ItemResult struct {
	ID             string `json:"update_id"`
	Result         string `json:"result"`
	HResult        string `json:"hresult,omitempty"`
	RebootRequired bool   `json:"reboot_required,omitempty"`
}

// InstallResult is what one install did.
type InstallResult struct {
	Results        []ItemResult `json:"results"`
	RebootRequired bool         `json:"reboot_required"`
	// Output: the updater's last lines (apt, dnf, softwareupdate), never more than 4 KiB.
	Output string `json:"output,omitempty"`
}

// Scanner is the updater of this computer.
type Scanner interface {
	Scan(ctx context.Context) Status
	Install(ctx context.Context, items []Item) (InstallResult, error)
}

// ErrNotSupported: this computer has no updater Nigafiy can drive.
var ErrNotSupported = errors.New("no supported updater on this computer")

// Classifications the server knows (fleet_patch_policies.auto_approve).
var Classifications = []string{"critical", "security", "definition", "update_rollup", "service_pack", "feature_pack", "update", "driver", "tool", "upgrade", "other"}

// wuaClassifications maps the Windows Update classification category IDs (the same on every
// language of Windows; the names are translated) to the server's classification keys.
var wuaClassifications = map[string]string{
	"e6cf1350-c01b-414d-a61f-263d14d133b4": "critical",
	"0fa1201d-4330-4fa8-8ae9-b877473b6441": "security",
	"e0789628-ce08-4437-be74-2495b842f43b": "definition",
	"28bc880e-0592-4cbf-8f95-c79b17911d5f": "update_rollup",
	"68c5b0a3-d1a6-4553-ae49-01d3a7827828": "service_pack",
	"b54e7d24-7add-428f-8b75-90a396fa584f": "feature_pack",
	"cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83": "update",
	"ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0": "driver",
	"b4832bd8-e735-4761-8daf-37f882276dab": "tool",
	"3689bdc8-b205-4af4-8d4a-a63924c5e9d5": "upgrade",
}

// wuaNames is the fallback on the English category names.
var wuaNames = map[string]string{
	"critical updates": "critical", "security updates": "security", "definition updates": "definition",
	"update rollups": "update_rollup", "service packs": "service_pack", "feature packs": "feature_pack",
	"updates": "update", "drivers": "driver", "tools": "tool", "upgrades": "upgrade",
}

// WUAClass is the classification of a Windows update from its UpdateClassification category.
func WUAClass(categoryID, name string) string {
	if c, ok := wuaClassifications[strings.ToLower(strings.TrimSpace(categoryID))]; ok {
		return c
	}
	if c, ok := wuaNames[strings.ToLower(strings.TrimSpace(name))]; ok {
		return c
	}
	return "other"
}

// WUAResult turns an OperationResultCode into the result names.
func WUAResult(code int) string {
	switch code {
	case 2, 3: // succeeded, succeeded with errors
		return "succeeded"
	case 4:
		return "failed"
	case 5:
		return "aborted"
	}
	return "not_started"
}

func boolPtr(b bool) *bool { return &b }

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}
