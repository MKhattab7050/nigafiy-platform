package sysinfo

// Evidence-only security compliance. Each check runs a documented OS command, keeps what it saw
// (the command, the value and the time) and states pass / fail / warn / unknown / info for that one
// subject. Nothing is assumed: a check the agent could not run is reported as unknown with the reason.
// The API turns this evidence into the compliant / attention / non_compliant / unknown verdict.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Evidence is one measured fact behind a compliance check.
type Evidence struct {
	Check      string `json:"check"`   // firewall | antivirus | disk_encryption | os_updates | sip | gatekeeper | local_admins
	Subject    string `json:"subject"` // "Public profile", "C:", "ufw", "/home", "FileVault"
	State      string `json:"state"`   // pass | fail | warn | unknown | info (context only, not judged)
	Value      string `json:"value"`   // what the command reported
	Source     string `json:"source"`  // the command / API that produced the value
	MeasuredAt string `json:"measured_at"`
	Reason     string `json:"reason,omitempty"` // why a check is unknown, or what a fail/warn means
	Count      *int   `json:"count,omitempty"`  // pending updates
}

const (
	checkFirewall   = "firewall"
	checkAntivirus  = "antivirus"
	checkDiskCrypt  = "disk_encryption"
	checkUpdates    = "os_updates"
	checkSIP        = "sip"
	checkGatekeeper = "gatekeeper"
)

// complianceEnv runs the commands; tests replace it to drive every platform's collector.
type complianceEnv struct {
	goos string
	// run executes a program with a timeout and returns its combined output.
	run func(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error)
	has func(name string) bool
	now func() time.Time
}

func defaultComplianceEnv() complianceEnv {
	return complianceEnv{
		goos: runtime.GOOS,
		run: func(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
			c, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			cmd := exec.CommandContext(c, name, args...)
			hideWindow(cmd)
			out, err := cmd.CombinedOutput()
			if c.Err() == context.DeadlineExceeded {
				return string(out), fmt.Errorf("timed out after %s", timeout)
			}
			return string(out), err
		},
		has: func(name string) bool {
			if strings.HasPrefix(name, "/") {
				_, err := os.Stat(name)
				return err == nil
			}
			_, err := exec.LookPath(name)
			return err == nil
		},
		now: time.Now,
	}
}

func (e complianceEnv) stamp() string { return e.now().UTC().Format(time.RFC3339) }

// The API validates every evidence field strictly and refuses the whole heartbeat when one is out
// of bounds, so the limits are enforced here: subject ≤ 120, source ≤ 200, value / reason ≤ 300,
// no control characters, subject and source never empty.
func (e complianceEnv) ev(check, subject, state, value, source, reason string) Evidence {
	return Evidence{
		Check:      check,
		Subject:    firstNonEmptyStr(clip(subject, 120), "Unnamed item"),
		State:      state,
		Value:      clip(value, 300),
		Source:     firstNonEmptyStr(clip(source, 200), "agent"),
		MeasuredAt: e.stamp(),
		Reason:     clip(reason, 300),
	}
}

// MaxEvidenceItems is the API's limit on evidence items in one heartbeat.
const MaxEvidenceItems = 64

// capEvidence keeps the evidence within MaxEvidenceItems. Failures, warnings and unknowns are kept
// before passes and context, so the cap can never hide a problem; and what does not fit is not
// dropped silently: the last slot says how many items of which checks were left out, as "unknown".
func capEvidence(ev []Evidence) []Evidence {
	if len(ev) <= MaxEvidenceItems {
		return ev
	}
	rank := map[string]int{"fail": 0, "warn": 1, "unknown": 2, "pass": 3, "info": 4}
	idx := make([]int, len(ev))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return rank[ev[idx[a]].State] < rank[ev[idx[b]].State] })
	keep := map[int]bool{}
	for _, i := range idx[:MaxEvidenceItems-1] {
		keep[i] = true
	}
	var kept, dropped []Evidence
	for i, e := range ev {
		if keep[i] {
			kept = append(kept, e)
		} else {
			dropped = append(dropped, e)
		}
	}
	checks := map[string]int{}
	var order []string
	latest := ""
	for _, d := range dropped {
		if checks[d.Check] == 0 {
			order = append(order, d.Check)
		}
		checks[d.Check]++
		if d.MeasuredAt > latest {
			latest = d.MeasuredAt
		}
	}
	parts := make([]string, 0, len(order))
	for _, c := range order {
		parts = append(parts, fmt.Sprintf("%s: %d", c, checks[c]))
	}
	kept = append(kept, Evidence{
		Check:      dropped[0].Check,
		Subject:    "Items not sent",
		State:      "unknown",
		Value:      clip(fmt.Sprintf("%d more item(s) (%s)", len(dropped), strings.Join(parts, ", ")), 300),
		Source:     "agent evidence limit",
		MeasuredAt: latest,
		Reason:     fmt.Sprintf("more than %d evidence items were measured; the rest are not reported", MaxEvidenceItems),
	})
	return kept
}

func clip(s string, max int) string {
	s = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)), " ")
	if len(s) > max {
		cut := max
		for cut > 0 && (s[cut]&0xC0) == 0x80 { // do not split a UTF-8 sequence
			cut--
		}
		return s[:cut]
	}
	return s
}

func errText(out string, err error) string {
	if t := clip(out, 200); t != "" {
		if err != nil {
			return t + " (" + err.Error() + ")"
		}
		return t
	}
	if err != nil {
		return err.Error()
	}
	return "no output"
}

func intPtr(v int) *int { return &v }

// ── cache: fast checks every 10 minutes, the slow update search every 6 hours ─────────────────

const (
	fastChecksTTL    = 10 * time.Minute
	updateChecksTTL  = 6 * time.Hour
	updateRetryAfter = 30 * time.Minute
)

type complianceCache struct {
	mu          sync.Mutex
	env         complianceEnv
	fast        []Evidence
	fastAt      time.Time
	fastRunning bool
	upd         []Evidence
	updAt       time.Time
	updOK       bool
	updRunning  bool
}

var compliance = &complianceCache{env: defaultComplianceEnv()}

// ComplianceEvidence returns the latest measured evidence (empty until the first measurement
// finishes) and starts a background refresh of whatever is stale. It never blocks the heartbeat.
func ComplianceEvidence() []Evidence {
	return compliance.snapshot()
}

func (c *complianceCache) snapshot() []Evidence {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.env.now()
	if !c.fastRunning && (c.fastAt.IsZero() || now.Sub(c.fastAt) > fastChecksTTL) {
		c.fastRunning = true
		go func() {
			ev := collectFastChecks(context.Background(), c.env)
			c.mu.Lock()
			c.fast, c.fastAt, c.fastRunning = ev, c.env.now(), false
			c.mu.Unlock()
		}()
	}
	ttl := updateChecksTTL
	if !c.updOK {
		ttl = updateRetryAfter
	}
	if !c.updRunning && (c.updAt.IsZero() || now.Sub(c.updAt) > ttl) {
		c.updRunning = true
		go func() {
			ev := collectUpdateChecks(context.Background(), c.env)
			ok := true
			for _, e := range ev {
				if e.State == "unknown" {
					ok = false
				}
			}
			c.mu.Lock()
			c.upd, c.updAt, c.updOK, c.updRunning = ev, c.env.now(), ok, false
			c.mu.Unlock()
		}()
	}
	out := make([]Evidence, 0, len(c.fast)+len(c.upd))
	out = append(out, c.fast...)
	out = append(out, c.upd...)
	return out
}

// ApplyEvidence fills the posture's checks and its summary fields from evidence.
func ApplyEvidence(p *SecurityPosture, ev []Evidence) {
	if len(ev) == 0 {
		return
	}
	// Summaries are computed from everything measured; only the list sent is capped.
	p.Checks = capEvidence(ev)
	latest := ""
	for _, e := range ev {
		if e.MeasuredAt > latest {
			latest = e.MeasuredAt
		}
	}
	p.MeasuredAt = latest
	p.FirewallEnabled = summarize(ev, checkFirewall, true)
	p.AntivirusEnabled = summarize(ev, checkAntivirus, true)
	p.DiskEncrypted = summarize(ev, checkDiskCrypt, false)
	p.PendingUpdates = nil
	total, measured := 0, false
	for _, e := range ev {
		if e.Check == checkUpdates && e.Count != nil {
			total += *e.Count
			measured = true
		}
	}
	if measured {
		p.PendingUpdates = intPtr(total)
	}
}

// summarize turns a check's evidence into the legacy yes/no field: false on any fail, nil when
// anything is unknown or nothing was judged, true otherwise. warnOK says whether a warning (e.g.
// out-of-date signatures) still counts as "enabled".
func summarize(ev []Evidence, check string, warnOK bool) *bool {
	judged, fail, unknown := false, false, false
	for _, e := range ev {
		if e.Check != check {
			continue
		}
		switch e.State {
		case "pass":
			judged = true
		case "warn":
			judged = true
			if !warnOK {
				fail = true
			}
		case "fail":
			judged, fail = true, true
		case "unknown":
			unknown = true
		}
	}
	if fail {
		v := false
		return &v
	}
	if unknown || !judged {
		return nil
	}
	v := true
	return &v
}

// ── collectors ───────────────────────────────────────────────────────────────────────────────

func collectFastChecks(ctx context.Context, env complianceEnv) []Evidence {
	var ev []Evidence
	switch env.goos {
	case "windows":
		ev = windowsFastChecks(ctx, env)
	case "linux":
		ev = append(ev, linuxFirewall(ctx, env)...)
		ev = append(ev, linuxDiskEncryption(ctx, env)...)
	case "darwin":
		ev = darwinFastChecks(ctx, env)
	default:
		return nil
	}
	return append(ev, localAdminsChecks(ctx, env)...)
}

func collectUpdateChecks(ctx context.Context, env complianceEnv) []Evidence {
	switch env.goos {
	case "windows":
		return windowsUpdates(ctx, env)
	case "linux":
		return linuxUpdates(ctx, env)
	case "darwin":
		return darwinUpdates(ctx, env)
	}
	return nil
}

// ── Windows ──

const windowsSecurityScript = `$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$r.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
try {
  $r.fw = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object { @{ name = [string]$_.Name; enabled = $_.Enabled.ToString() } })
  $r.fw_source = 'Get-NetFirewallProfile -PolicyStore ActiveStore'
} catch {
  $r.fw_error = $_.Exception.Message
  $r.fw = @()
  foreach ($p in @(@('Domain','DomainProfile'), @('Private','StandardProfile'), @('Public','PublicProfile'))) {
    $v = Get-ItemProperty ('HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\' + $p[1]) -Name EnableFirewall -ErrorAction SilentlyContinue
    if ($null -ne $v) { $r.fw += @{ name = $p[0]; enabled = [string]$v.EnableFirewall } }
  }
  $r.fw_source = 'registry SharedAccess\Parameters\FirewallPolicy\<profile>\EnableFirewall'
}
try {
  $r.av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { @{ name = [string]$_.displayName; state = [int64]$_.productState } })
  $r.av_ok = $true
} catch { $r.av_error = $_.Exception.Message }
try {
  $m = Get-MpComputerStatus -ErrorAction Stop
  $r.mp = @{ am_service = [bool]$m.AMServiceEnabled; av = [bool]$m.AntivirusEnabled; rtp = [bool]$m.RealTimeProtectionEnabled; sig_age = [int]$m.AntivirusSignatureAge; mode = [string]$m.AMRunningMode }
} catch { $r.mp_error = $_.Exception.Message }
$fixed = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name.TrimEnd('\') })
$r.fixed = $fixed
try {
  $r.bl = @(Get-BitLockerVolume -ErrorAction Stop | Where-Object { $fixed -contains $_.MountPoint } | ForEach-Object { @{ mount = [string]$_.MountPoint; type = $_.VolumeType.ToString(); protection = $_.ProtectionStatus.ToString(); status = $_.VolumeStatus.ToString(); pct = [double]$_.EncryptionPercentage } })
  $r.bl_source = 'Get-BitLockerVolume'
} catch {
  $r.bl_error = $_.Exception.Message
  try {
    $r.bl = @(Get-CimInstance -Namespace root/CIMV2/Security/MicrosoftVolumeEncryption -ClassName Win32_EncryptableVolume -ErrorAction Stop | Where-Object { $fixed -contains $_.DriveLetter } | ForEach-Object { @{ mount = [string]$_.DriveLetter; protection = [string]$_.ProtectionStatus; status = ''; pct = -1 } })
    $r.bl_source = 'CIM root/CIMV2/Security/MicrosoftVolumeEncryption Win32_EncryptableVolume'
  } catch { $r.bl_cim_error = $_.Exception.Message }
}
$r | ConvertTo-Json -Depth 4 -Compress`

// The "Security Updates" category id is language-independent (category names are localized).
const windowsUpdateScript = `try {
  $s = New-Object -ComObject Microsoft.Update.Session
  $res = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
  $sec = 0
  foreach ($u in $res.Updates) { foreach ($c in $u.Categories) { if ($c.CategoryID -eq '0fa1201d-4330-4fa8-8ae9-b877473b6441') { $sec++; break } } }
  @{ ok = $true; count = [int]$res.Updates.Count; security = $sec } | ConvertTo-Json -Compress
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }`

const windowsUpdateSource = `Microsoft.Update.Session IUpdateSearcher.Search("IsInstalled=0 and IsHidden=0")`

func windowsFastChecks(ctx context.Context, env complianceEnv) []Evidence {
	out, err := env.run(ctx, 60*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", windowsSecurityScript)
	rep, perr := ParseWindowsSecurityReport([]byte(strings.TrimSpace(out)))
	if err != nil || perr != nil {
		reason := "compliance script failed: " + errText(out, err)
		return []Evidence{
			env.ev(checkFirewall, "Windows Firewall", "unknown", "", "powershell", reason),
			env.ev(checkAntivirus, "Antivirus", "unknown", "", "powershell", reason),
			env.ev(checkDiskCrypt, "BitLocker", "unknown", "", "powershell", reason),
		}
	}
	// manage-bde is the last resort when neither the BitLocker module nor its CIM class answered.
	if len(rep.BitLocker) == 0 && rep.BLError != "" && rep.Elevated {
		if mb, mbErr := env.run(ctx, 30*time.Second, "manage-bde", "-status"); mbErr == nil {
			fixed := map[string]bool{}
			for _, f := range rep.Fixed {
				fixed[strings.ToUpper(f)] = true
			}
			for _, v := range ParseManageBdeStatus(mb) {
				if len(fixed) == 0 || fixed[v.Mount] {
					rep.BitLocker = append(rep.BitLocker, v)
				}
			}
			if len(rep.BitLocker) > 0 {
				rep.BLSource = "manage-bde -status"
			}
		} else if rep.BLCimError == "" {
			rep.BLCimError = "manage-bde: " + errText(mb, mbErr)
		}
	}
	return WindowsEvidence(rep, env)
}

// WindowsEvidence turns the parsed Windows report into evidence (pure apart from the timestamp).
func WindowsEvidence(rep WindowsSecurityReport, env complianceEnv) []Evidence {
	var ev []Evidence

	// Firewall: each of the three profiles must be on.
	for _, want := range []string{"Domain", "Private", "Public"} {
		subject := want + " profile"
		var found *FirewallProfile
		for i := range rep.Firewall {
			if strings.EqualFold(rep.Firewall[i].Name, want) {
				found = &rep.Firewall[i]
				break
			}
		}
		if found == nil {
			reason := "profile not reported"
			if rep.FWError != "" {
				reason = "profile not reported; Get-NetFirewallProfile: " + rep.FWError
			}
			ev = append(ev, env.ev(checkFirewall, subject, "unknown", "", rep.FWSource, reason))
			continue
		}
		on, ok := ParseFirewallEnabled(found.Enabled)
		switch {
		case !ok:
			ev = append(ev, env.ev(checkFirewall, subject, "unknown", "Enabled="+found.Enabled, rep.FWSource, "unrecognised value"))
		case on:
			ev = append(ev, env.ev(checkFirewall, subject, "pass", "Enabled=True", rep.FWSource, ""))
		default:
			ev = append(ev, env.ev(checkFirewall, subject, "fail", "Enabled=False", rep.FWSource, "the firewall is off for this network profile"))
		}
	}

	ev = append(ev, windowsAVEvidence(rep, env)...)

	// BitLocker: every fixed volume.
	blSource := rep.BLSource
	if blSource == "" {
		blSource = "Get-BitLockerVolume"
	}
	reported := map[string]bool{}
	for _, v := range rep.BitLocker {
		mount := strings.ToUpper(strings.TrimSpace(v.Mount))
		if mount == "" || reported[mount] {
			continue
		}
		reported[mount] = true
		state, value := BitLockerVerdict(v)
		reason := ""
		switch state {
		case "fail":
			reason = "the volume is not protected by BitLocker"
			if strings.Contains(value, "suspended") {
				reason = "BitLocker protection is suspended: the key is stored in the clear"
			}
		case "warn":
			reason = "encryption is still in progress"
		case "unknown":
			reason = "BitLocker reported an unknown protection state (volume locked?)"
		}
		ev = append(ev, env.ev(checkDiskCrypt, mount, state, value, blSource, reason))
	}
	for _, f := range rep.Fixed {
		mount := strings.ToUpper(strings.TrimSpace(f))
		if mount == "" || reported[mount] {
			continue
		}
		reason := "not reported by BitLocker"
		switch {
		case len(rep.BitLocker) == 0 && !rep.Elevated:
			reason = "reading BitLocker status needs administrator rights and the agent is not running elevated"
		case len(rep.BitLocker) == 0:
			reason = "BitLocker status unavailable: " + firstNonEmptyStr(rep.BLError, "no error text") + "; " + firstNonEmptyStr(rep.BLCimError, "")
		}
		ev = append(ev, env.ev(checkDiskCrypt, mount, "unknown", "", blSource, reason))
	}
	if len(rep.Fixed) == 0 && len(rep.BitLocker) == 0 {
		ev = append(ev, env.ev(checkDiskCrypt, "Fixed volumes", "unknown", "", blSource, "no fixed volumes were reported"))
	}
	return ev
}

func windowsAVEvidence(rep WindowsSecurityReport, env complianceEnv) []Evidence {
	const scSource = "WMI root/SecurityCenter2 AntiVirusProduct"
	var ev []Evidence
	anyEnabled, thirdPartyEnabled := false, false
	for _, p := range rep.AV {
		st := DecodeAVProductState(p.State)
		if st.Enabled {
			anyEnabled = true
			if !isDefenderName(p.Name) {
				thirdPartyEnabled = true
			}
		}
	}
	mpOK := rep.Defender != nil && rep.Defender.AMServiceEnabled && rep.Defender.AntivirusEnabled && rep.Defender.RealTimeEnabled
	if mpOK {
		anyEnabled = true
	}
	for _, p := range rep.AV {
		st := DecodeAVProductState(p.State)
		value := fmt.Sprintf("productState=%d (0x%06X): %s, signatures %s", p.State, p.State, onOff(st.Enabled, st.Snoozed), upToDate(st.UpToDate))
		name := firstNonEmptyStr(clip(p.Name, 120), "Unnamed product")
		switch {
		case st.Enabled && st.UpToDate:
			ev = append(ev, env.ev(checkAntivirus, name, "pass", value, scSource, ""))
		case st.Enabled:
			ev = append(ev, env.ev(checkAntivirus, name, "warn", value, scSource, "signatures are out of date"))
		case anyEnabled:
			ev = append(ev, env.ev(checkAntivirus, name, "info", value, scSource, "off, but another antivirus product is active"))
		default:
			ev = append(ev, env.ev(checkAntivirus, name, "fail", value, scSource, "real-time scanning is off"))
		}
	}
	if rep.Defender != nil {
		d := rep.Defender
		value := fmt.Sprintf("AMServiceEnabled=%t AntivirusEnabled=%t RealTimeProtectionEnabled=%t SignatureAge=%dd Mode=%s",
			d.AMServiceEnabled, d.AntivirusEnabled, d.RealTimeEnabled, d.SignatureAgeDays, firstNonEmptyStr(d.RunningMode, "?"))
		const subject = "Microsoft Defender Antivirus"
		switch {
		case mpOK && d.SignatureAgeDays > 7:
			ev = append(ev, env.ev(checkAntivirus, subject, "warn", value, "Get-MpComputerStatus", "signatures are more than 7 days old"))
		case mpOK:
			ev = append(ev, env.ev(checkAntivirus, subject, "pass", value, "Get-MpComputerStatus", ""))
		case thirdPartyEnabled:
			ev = append(ev, env.ev(checkAntivirus, subject, "info", value, "Get-MpComputerStatus", "Defender is not the active antivirus (passive or off) while another product is active"))
		default:
			ev = append(ev, env.ev(checkAntivirus, subject, "fail", value, "Get-MpComputerStatus", "Defender real-time protection is off and no other antivirus is active"))
		}
	}
	if len(rep.AV) == 0 && rep.Defender == nil {
		reason := "no antivirus status could be read"
		if rep.AVError != "" || rep.MPError != "" {
			reason = "SecurityCenter2: " + firstNonEmptyStr(rep.AVError, "no products") + "; Get-MpComputerStatus: " + firstNonEmptyStr(rep.MPError, "not available")
		}
		ev = append(ev, env.ev(checkAntivirus, "Antivirus", "unknown", "", scSource+" / Get-MpComputerStatus", reason))
	} else if len(rep.AV) == 0 && rep.AVOK && !mpOK {
		// Security Center answered but lists nothing, and Defender is not protecting.
		ev = append(ev, env.ev(checkAntivirus, "Registered antivirus products", "fail", "0 products", scSource, "no antivirus product is registered with Windows Security Center"))
	}
	return ev
}

func isDefenderName(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "defender")
}

func onOff(enabled, snoozed bool) string {
	switch {
	case enabled:
		return "on"
	case snoozed:
		return "snoozed"
	}
	return "off"
}

func upToDate(ok bool) string {
	if ok {
		return "up to date"
	}
	return "out of date"
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func windowsUpdates(ctx context.Context, env complianceEnv) []Evidence {
	out, err := env.run(ctx, 4*time.Minute, "powershell", "-NoProfile", "-NonInteractive", "-Command", windowsUpdateScript)
	res, ok := ParseWindowsUpdateResult([]byte(strings.TrimSpace(out)))
	return []Evidence{windowsUpdateEvidence(res, ok, out, err, env)}
}

func windowsUpdateEvidence(res WindowsUpdateResult, parsed bool, out string, err error, env complianceEnv) Evidence {
	if err != nil || !parsed || !res.OK {
		reason := "Windows Update search failed: " + firstNonEmptyStr(res.Error, errText(out, err))
		return env.ev(checkUpdates, "Windows Update", "unknown", "", windowsUpdateSource, reason)
	}
	value := fmt.Sprintf("%d pending (%d security)", res.Count, res.Security)
	e := env.ev(checkUpdates, "Windows Update", "pass", value, windowsUpdateSource, "")
	if res.Count > 0 {
		e.State = "fail"
		e.Reason = "updates are available but not installed"
	}
	e.Count = intPtr(res.Count)
	return e
}

// ── Linux ──

func linuxFirewall(ctx context.Context, env complianceEnv) []Evidence {
	type tool struct {
		subject, source string
		state           string // active | inactive | unknown
		value, reason   string
	}
	var tools []tool
	if env.has("ufw") {
		out, err := env.run(ctx, 15*time.Second, "ufw", "status")
		t := tool{subject: "ufw", source: "ufw status"}
		if active, ok := ParseUfwStatus(out); ok {
			t.state, t.value = map[bool]string{true: "active", false: "inactive"}[active], "Status: "+map[bool]string{true: "active", false: "inactive"}[active]
		} else {
			t.state, t.reason = "unknown", errText(out, err)
		}
		tools = append(tools, t)
	}
	if env.has("firewall-cmd") {
		out, err := env.run(ctx, 15*time.Second, "firewall-cmd", "--state")
		t := tool{subject: "firewalld", source: "firewall-cmd --state"}
		if running, ok := ParseFirewalldState(out); ok {
			t.value = strings.TrimSpace(out)
			t.state = map[bool]string{true: "active", false: "inactive"}[running]
		} else {
			t.state, t.reason = "unknown", errText(out, err)
		}
		tools = append(tools, t)
	}
	if env.has("nft") {
		out, err := env.run(ctx, 15*time.Second, "nft", "list", "ruleset")
		t := tool{subject: "nftables", source: "nft list ruleset"}
		if err != nil {
			t.state, t.reason = "unknown", errText(out, err)
		} else {
			s := ParseNftRuleset(out)
			t.value = fmt.Sprintf("%d table(s), %d input chain(s), %d input rule(s), drop policy=%t", s.Tables, s.InputChains, s.InputRules, s.DropPolicy)
			t.state = map[bool]string{true: "active", false: "inactive"}[s.Filtering()]
		}
		tools = append(tools, t)
	}
	if len(tools) == 0 {
		return []Evidence{env.ev(checkFirewall, "Host firewall", "unknown", "", "ufw / firewall-cmd / nft", "none of ufw, firewalld or nftables is installed or on PATH")}
	}
	anyActive, anyUnknown := false, false
	for _, t := range tools {
		anyActive = anyActive || t.state == "active"
		anyUnknown = anyUnknown || t.state == "unknown"
	}
	var ev []Evidence
	for _, t := range tools {
		switch {
		case t.state == "active":
			ev = append(ev, env.ev(checkFirewall, t.subject, "pass", t.value, t.source, ""))
		case anyActive:
			ev = append(ev, env.ev(checkFirewall, t.subject, "info", t.value, t.source, firstNonEmptyStr(t.reason, "another firewall front-end is active")))
		case t.state == "unknown":
			ev = append(ev, env.ev(checkFirewall, t.subject, "unknown", t.value, t.source, t.reason))
		case anyUnknown:
			ev = append(ev, env.ev(checkFirewall, t.subject, "info", t.value, t.source, "inactive; another front-end could not be read"))
		default:
			ev = append(ev, env.ev(checkFirewall, t.subject, "fail", t.value, t.source, "no inbound filtering is active"))
		}
	}
	return ev
}

var dmNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+:-]{0,127}$`)

func linuxDiskEncryption(ctx context.Context, env complianceEnv) []Evidence {
	const src = "lsblk -P -o NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT"
	out, err := env.run(ctx, 15*time.Second, "lsblk", "-P", "-o", "NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT")
	if err != nil {
		reason := "lsblk failed: " + errText(out, err)
		if env.has("dmsetup") {
			dm, dmErr := env.run(ctx, 15*time.Second, "dmsetup", "ls", "--target", "crypt")
			if dmErr == nil {
				names := ParseDmsetupCryptTargets(dm)
				return []Evidence{env.ev(checkDiskCrypt, "Mounted filesystems", "unknown", fmt.Sprintf("%d dm-crypt device(s): %s", len(names), strings.Join(names, ", ")), "dmsetup ls --target crypt", reason+"; dm-crypt devices cannot be mapped to mount points without lsblk")}
			}
		}
		return []Evidence{env.ev(checkDiskCrypt, "Mounted filesystems", "unknown", "", src, reason)}
	}
	mounts := EvaluateLinuxMountEncryption(ParseLsblkPairs(out))
	if len(mounts) == 0 {
		return []Evidence{env.ev(checkDiskCrypt, "Mounted filesystems", "unknown", "", src, "no mounted block-device filesystems were found (container or unusual storage?)")}
	}
	var ev []Evidence
	for _, m := range mounts {
		if m.Encrypted {
			value := "on dm-crypt device " + m.CryptDev
			source := src
			if env.has("cryptsetup") && dmNamePattern.MatchString(m.CryptDev) {
				if cs, csErr := env.run(ctx, 10*time.Second, "cryptsetup", "status", "--", m.CryptDev); csErr == nil {
					st := ParseCryptsetupStatus(cs)
					if st.Active {
						value += fmt.Sprintf(" (%s, %s)", firstNonEmptyStr(st.Type, "type ?"), firstNonEmptyStr(st.Cipher, "cipher ?"))
						source += "; cryptsetup status"
					}
				}
			}
			ev = append(ev, env.ev(checkDiskCrypt, m.Mount, "pass", value, source, ""))
		} else {
			ev = append(ev, env.ev(checkDiskCrypt, m.Mount, "fail", "on "+m.Device+" (no dm-crypt layer)", src, "the filesystem is not on an encrypted (LUKS/dm-crypt) device"))
		}
	}
	return ev
}

func linuxUpdates(ctx context.Context, env complianceEnv) []Evidence {
	const secReason = "security updates are available but not installed"
	switch {
	case env.has("apt-get"):
		const src = "apt-get -s upgrade"
		out, err := env.run(ctx, 3*time.Minute, "apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade")
		total, sec, ok := AptUpgrades(out)
		if err != nil || !ok {
			return []Evidence{env.ev(checkUpdates, "APT", "unknown", "", src, "simulation failed: "+errText(out, err))}
		}
		return []Evidence{updateEvidence(env, "APT", src, sec, fmt.Sprintf("%d security of %d upgradable package(s) (from the last apt update)", sec, total), secReason)}
	case env.has("dnf"):
		const src = "dnf -q updateinfo list --security"
		out, err := env.run(ctx, 3*time.Minute, "dnf", "-q", "updateinfo", "list", "--security")
		n, ok := DnfSecurityUpdates(out)
		if err != nil || (!ok && strings.TrimSpace(out) != "") {
			return []Evidence{env.ev(checkUpdates, "DNF", "unknown", "", src, "dnf failed: "+errText(out, err))}
		}
		return []Evidence{updateEvidence(env, "DNF", src, n, fmt.Sprintf("%d package(s) with security advisories", n), secReason)}
	case env.has("zypper"):
		const src = "zypper --non-interactive list-patches --category security"
		out, err := env.run(ctx, 3*time.Minute, "zypper", "--non-interactive", "list-patches", "--category", "security")
		n, ok := ZypperSecurityPatches(out)
		if err != nil || !ok {
			return []Evidence{env.ev(checkUpdates, "zypper", "unknown", "", src, "zypper failed: "+errText(out, err))}
		}
		return []Evidence{updateEvidence(env, "zypper", src, n, fmt.Sprintf("%d needed security patch(es)", n), secReason)}
	case env.has("yum"):
		const src = "yum -q updateinfo list security"
		out, err := env.run(ctx, 3*time.Minute, "yum", "-q", "updateinfo", "list", "security")
		n, ok := DnfSecurityUpdates(out)
		if err != nil || (!ok && strings.TrimSpace(out) != "") {
			return []Evidence{env.ev(checkUpdates, "YUM", "unknown", "", src, "yum failed: "+errText(out, err))}
		}
		return []Evidence{updateEvidence(env, "YUM", src, n, fmt.Sprintf("%d package(s) with security advisories", n), secReason)}
	}
	return []Evidence{env.ev(checkUpdates, "Package manager", "unknown", "", "apt-get / dnf / zypper / yum", "no supported package manager (apt-get, dnf, zypper, yum) was found")}
}

func updateEvidence(env complianceEnv, subject, source string, pending int, value, failReason string) Evidence {
	e := env.ev(checkUpdates, subject, "pass", value, source, "")
	if pending > 0 {
		e.State = "fail"
		e.Reason = failReason
	}
	e.Count = intPtr(pending)
	return e
}

// ── macOS ──

const socketfilterfw = "/usr/libexec/ApplicationFirewall/socketfilterfw"

func darwinFastChecks(ctx context.Context, env complianceEnv) []Evidence {
	var ev []Evidence

	// The Application Firewall decides; pf is shown for context (Apple ships it disabled and it is
	// often enabled only by VPN or other software with its own anchors).
	out, err := env.run(ctx, 15*time.Second, socketfilterfw, "--getglobalstate")
	if on, ok := ParseSocketfilterfwState(out); ok {
		state, reason := "pass", ""
		if !on {
			state, reason = "fail", "the Application Firewall is off"
		}
		ev = append(ev, env.ev(checkFirewall, "Application Firewall", state, strings.TrimSpace(out), socketfilterfw+" --getglobalstate", reason))
	} else {
		ev = append(ev, env.ev(checkFirewall, "Application Firewall", "unknown", "", socketfilterfw+" --getglobalstate", errText(out, err)))
	}
	pf, pfErr := env.run(ctx, 10*time.Second, "pfctl", "-s", "info")
	if on, ok := ParsePfctlInfo(pf); ok {
		ev = append(ev, env.ev(checkFirewall, "pf packet filter", "info", "Status: "+map[bool]string{true: "Enabled", false: "Disabled"}[on], "pfctl -s info", "context only; the Application Firewall decides"))
	} else {
		ev = append(ev, env.ev(checkFirewall, "pf packet filter", "info", "", "pfctl -s info", "not readable (needs root): "+errText(pf, pfErr)))
	}

	fv, fvErr := env.run(ctx, 15*time.Second, "fdesetup", "status")
	if state, ok := ParseFdesetupStatus(fv); ok {
		reason := map[string]string{"fail": "FileVault is off", "warn": "FileVault encryption is not complete yet"}[state]
		ev = append(ev, env.ev(checkDiskCrypt, "FileVault", state, strings.TrimSpace(fv), "fdesetup status", reason))
	} else {
		ev = append(ev, env.ev(checkDiskCrypt, "FileVault", "unknown", "", "fdesetup status", errText(fv, fvErr)))
	}

	sip, sipErr := env.run(ctx, 10*time.Second, "csrutil", "status")
	if state, ok := ParseCsrutilStatus(sip); ok {
		reason := map[string]string{"fail": "System Integrity Protection is disabled", "warn": "System Integrity Protection has a custom (partly disabled) configuration"}[state]
		ev = append(ev, env.ev(checkSIP, "System Integrity Protection", state, firstLineOf(sip), "csrutil status", reason))
	} else {
		ev = append(ev, env.ev(checkSIP, "System Integrity Protection", "unknown", "", "csrutil status", errText(sip, sipErr)))
	}

	gk, gkErr := env.run(ctx, 10*time.Second, "spctl", "--status")
	if on, ok := ParseSpctlStatus(gk); ok {
		state, reason := "pass", ""
		if !on {
			state, reason = "fail", "Gatekeeper assessments are disabled"
		}
		ev = append(ev, env.ev(checkGatekeeper, "Gatekeeper", state, strings.TrimSpace(gk), "spctl --status", reason))
	} else {
		ev = append(ev, env.ev(checkGatekeeper, "Gatekeeper", "unknown", "", "spctl --status", errText(gk, gkErr)))
	}
	return ev
}

func firstLineOf(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}

func darwinUpdates(ctx context.Context, env complianceEnv) []Evidence {
	const src = "softwareupdate -l"
	out, err := env.run(ctx, 3*time.Minute, "softwareupdate", "-l")
	n, ok := ParseSoftwareUpdateList(out)
	if !ok {
		return []Evidence{env.ev(checkUpdates, "Software Update", "unknown", "", src, "softwareupdate failed: "+errText(out, err))}
	}
	return []Evidence{updateEvidence(env, "Software Update", src, n, strconv.Itoa(n)+" update(s) available", "macOS updates are available but not installed")}
}
