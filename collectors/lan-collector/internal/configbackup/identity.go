package configbackup

import (
	"context"
	"regexp"
	"strings"
)

// Device identity: the hardware model and serial number a device reports about itself. It is read
// during a backup (read-only commands, after the configuration; never part of the configuration
// text) for the drivers that can restore, so a restore can refuse a version that was taken from a
// different device (replaced hardware, a re-used address, another model) unless the administrator
// forces it with an extra confirmation. Drivers without a reader report no identity.

// DeviceIdentity is what the device says about itself. Empty fields were not reported.
type DeviceIdentity struct {
	Model  string `json:"model,omitempty"`
	Serial string `json:"serial,omitempty"`
}

// Known reports whether anything was read.
func (d *DeviceIdentity) Known() bool { return d != nil && (d.Model != "" || d.Serial != "") }

type identityReader struct {
	// Read-only commands, run in the backup's CLI session after the configuration commands.
	commands []string
	model    *regexp.Regexp
	serial   *regexp.Regexp
}

var identityReaders = map[string]identityReader{
	// Junos: "show version" prints "Model: srx300"; "show chassis hardware" prints the chassis row
	// "Chassis   CV1234AF0123   SRX300" (Junos OS CLI User Guide, operational commands).
	junosDriverID: {
		commands: []string{"show version | no-more", "show chassis hardware | no-more"},
		model:    regexp.MustCompile(`(?m)^\s*Model:\s*(\S+)`),
		serial:   regexp.MustCompile(`(?m)^Chassis\s+(\S+)`),
	},
	// VyOS 1.2–1.5 "show version": "Hardware model:" / "Hardware S/N:"; EdgeOS 1.x/2.x "show
	// version": "HW model:" / "HW S/N:". Values may be empty on virtual machines.
	vyosDriverID: {
		commands: []string{"show version | cat"},
		model:    regexp.MustCompile(`(?m)^\s*(?:Hardware model|HW model)\s*:[ \t]*(\S[^\r\n]*)$`),
		serial:   regexp.MustCompile(`(?m)^\s*(?:Hardware S/N|HW S/N)\s*:[ \t]*(\S[^\r\n]*)$`),
	},
	// OpenWrt: "ubus call system board" (procd, OpenWrt 15.05+) prints JSON with "model" (from the
	// device tree / board detection, e.g. "TP-Link Archer C7 v5"). OpenWrt reports no serial number.
	openwrtDriverID: {
		commands: []string{"ubus call system board"},
		model:    regexp.MustCompile(`"model"\s*:\s*"([^"\\]{1,100})"`),
	},
}

// HasIdentityReader reports whether backups of this driver record the device identity.
func HasIdentityReader(driver string) bool {
	_, ok := identityReaders[driver]
	return ok
}

func identityValue(re *regexp.Regexp, out string) string {
	if re == nil {
		return ""
	}
	m := re.FindStringSubmatch(out)
	if len(m) < 2 {
		return ""
	}
	v := strings.TrimSpace(m[1])
	if hasControl(v) {
		return ""
	}
	// Placeholders some virtual platforms print.
	switch strings.ToLower(v) {
	case "", "none", "unknown", "n/a", "-":
		return ""
	}
	return clip(v, 100)
}

func parseIdentity(driver string, outputs []string) *DeviceIdentity {
	r, ok := identityReaders[driver]
	if !ok {
		return nil
	}
	all := strings.Join(outputs, "\n")
	id := &DeviceIdentity{Model: identityValue(r.model, all), Serial: identityValue(r.serial, all)}
	if !id.Known() {
		return nil
	}
	return id
}

// readIdentity runs the driver's identity commands in an open CLI session. A refused or failed
// command only leaves the identity unknown; it never fails a backup.
func readIdentity(ctx context.Context, sh *shell, driver, prompt string) *DeviceIdentity {
	r, ok := identityReaders[driver]
	if !ok {
		return nil
	}
	var outs []string
	for _, cmd := range r.commands {
		out, err := sh.run(ctx, cmd, prompt)
		if err != nil {
			break
		}
		if _, bad := looksLikeCommandError(out); bad {
			continue
		}
		outs = append(outs, out)
	}
	return parseIdentity(driver, outs)
}

// IdentityMismatch compares the identity recorded with a version with the device's identity now.
// It returns a reason when a field both sides know differs, "" otherwise.
func IdentityMismatch(expected, actual *DeviceIdentity) string {
	if !expected.Known() || !actual.Known() {
		return ""
	}
	if expected.Serial != "" && actual.Serial != "" && !strings.EqualFold(expected.Serial, actual.Serial) {
		return "serial number " + actual.Serial + " differs from " + expected.Serial + " recorded with the version"
	}
	if expected.Model != "" && actual.Model != "" && !strings.EqualFold(expected.Model, actual.Model) {
		return "model " + actual.Model + " differs from " + expected.Model + " recorded with the version"
	}
	return ""
}

// checkIdentity is the restore-side check, run in session A before anything is changed.
func checkIdentity(res *RestoreResult, spec RestoreSpec, actual *DeviceIdentity) error {
	res.Identity = actual
	if !actual.Known() {
		res.step("device identity: not reported by the device")
		return nil
	}
	why := IdentityMismatch(spec.ExpectedIdentity, actual)
	switch {
	case why == "":
		res.step("device identity: " + identityText(actual))
	case spec.AllowOtherDevice:
		res.step("device identity: " + why + "; restoring anyway, as the administrator confirmed")
	default:
		return fail(ErrDeviceMismatch, "this version was taken from a different device (%s); nothing was changed", why)
	}
	return nil
}

func identityText(d *DeviceIdentity) string {
	parts := []string{}
	if d.Model != "" {
		parts = append(parts, "model "+d.Model)
	}
	if d.Serial != "" {
		parts = append(parts, "serial "+d.Serial)
	}
	return strings.Join(parts, ", ")
}
