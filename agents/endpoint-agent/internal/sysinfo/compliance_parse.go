package sysinfo

// Pure parsers for the security-compliance checks. Every function here takes the text (or JSON) a
// command printed and returns structured facts; nothing runs a program. The collectors in
// compliance.go run the commands and turn these facts into Evidence.

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

// FirewallProfile is one Windows Firewall profile (Domain, Private or Public).
type FirewallProfile struct {
	Name    string `json:"name"`
	Enabled string `json:"enabled"` // "True" / "False" / "1" / "0" as printed by PowerShell or the registry
}

// ParseFirewallEnabled reads a profile's Enabled value. ok=false when the value is not a clear on/off
// (for example GpoBoolean "NotConfigured", which the active store never reports but a GPO store can).
func ParseFirewallEnabled(v string) (enabled bool, ok bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1":
		return true, true
	case "false", "0":
		return false, true
	}
	return false, false
}

// AVProductState is the decoded SecurityCenter2 AntiVirusProduct.productState bit field.
type AVProductState struct {
	Enabled  bool
	UpToDate bool
	Snoozed  bool
}

// DecodeAVProductState decodes WMI root/SecurityCenter2 AntiVirusProduct.productState.
// The value is 0x00TTSSDD: byte 2 is the product type/owner, byte 1 the scanner state
// (0x10 or 0x11 = on, 0x00 = off, 0x01 = snoozed) and byte 0 the signature state
// (0x00 = up to date, 0x10 = out of date). Examples: 397568 (0x061100) = Defender on, up to date;
// 393472 (0x060100) = off; 266256 (0x041010) = on, out of date.
func DecodeAVProductState(state int64) AVProductState {
	scanner := (state >> 8) & 0xFF
	sig := state & 0xFF
	return AVProductState{
		Enabled:  scanner == 0x10 || scanner == 0x11,
		Snoozed:  scanner == 0x01,
		UpToDate: sig == 0x00,
	}
}

// AVProduct is one antivirus product registered with Windows Security Center.
type AVProduct struct {
	Name  string `json:"name"`
	State int64  `json:"state"`
}

// DefenderStatus is the subset of Get-MpComputerStatus the compliance check uses.
type DefenderStatus struct {
	AMServiceEnabled bool   `json:"am_service"`
	AntivirusEnabled bool   `json:"av"`
	RealTimeEnabled  bool   `json:"rtp"`
	SignatureAgeDays int    `json:"sig_age"`
	RunningMode      string `json:"mode"`
}

// BitLockerVolume is one fixed volume's BitLocker state from Get-BitLockerVolume, the
// Win32_EncryptableVolume CIM class or manage-bde.
type BitLockerVolume struct {
	Mount      string  `json:"mount"`
	Type       string  `json:"type,omitempty"`
	Protection string  `json:"protection"` // On | Off | Unknown, or CIM 1 | 0 | 2
	Status     string  `json:"status"`     // FullyEncrypted | FullyDecrypted | EncryptionInProgress | ...
	Percent    float64 `json:"pct"`
}

// WindowsSecurityReport is the JSON the Windows compliance script prints.
type WindowsSecurityReport struct {
	Elevated   bool              `json:"elevated"`
	FWSource   string            `json:"fw_source"`
	FWError    string            `json:"fw_error"`
	Firewall   []FirewallProfile `json:"fw"`
	AVOK       bool              `json:"av_ok"`
	AVError    string            `json:"av_error"`
	AV         []AVProduct       `json:"av"`
	Defender   *DefenderStatus   `json:"mp"`
	MPError    string            `json:"mp_error"`
	Fixed      []string          `json:"fixed"`
	BLSource   string            `json:"bl_source"`
	BLError    string            `json:"bl_error"`
	BLCimError string            `json:"bl_cim_error"`
	BitLocker  []BitLockerVolume `json:"bl"`
}

// ParseWindowsSecurityReport decodes the compliance script output. PowerShell's ConvertTo-Json
// prints a single-element array as a bare object, so each list also accepts one object.
func ParseWindowsSecurityReport(raw []byte) (WindowsSecurityReport, error) {
	var loose struct {
		WindowsSecurityReport
		Firewall  json.RawMessage `json:"fw"`
		AV        json.RawMessage `json:"av"`
		Fixed     json.RawMessage `json:"fixed"`
		BitLocker json.RawMessage `json:"bl"`
	}
	if err := json.Unmarshal(raw, &loose); err != nil {
		return WindowsSecurityReport{}, err
	}
	r := loose.WindowsSecurityReport
	r.Firewall = decodeList[FirewallProfile](loose.Firewall)
	r.AV = decodeList[AVProduct](loose.AV)
	r.Fixed = decodeList[string](loose.Fixed)
	r.BitLocker = decodeList[BitLockerVolume](loose.BitLocker)
	return r, nil
}

func decodeList[T any](raw json.RawMessage) []T {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var list []T
	if json.Unmarshal(raw, &list) == nil {
		return list
	}
	var one T
	if json.Unmarshal(raw, &one) == nil {
		return []T{one}
	}
	return nil
}

var manageBdeVolume = regexp.MustCompile(`^Volume ([A-Za-z]:)`)

// ParseManageBdeStatus parses English `manage-bde -status` output into volumes. Other display
// languages print translated labels; they yield no volumes (the check then stays unknown).
func ParseManageBdeStatus(out string) []BitLockerVolume {
	var vols []BitLockerVolume
	var cur *BitLockerVolume
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		t := strings.TrimSpace(line)
		if m := manageBdeVolume.FindStringSubmatch(t); m != nil {
			vols = append(vols, BitLockerVolume{Mount: strings.ToUpper(m[1]), Percent: -1})
			cur = &vols[len(vols)-1]
			continue
		}
		if cur == nil {
			continue
		}
		key, val, ok := strings.Cut(t, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch strings.TrimSpace(key) {
		case "Conversion Status":
			cur.Status = strings.ReplaceAll(val, " ", "")
		case "Percentage Encrypted":
			if p, err := strconv.ParseFloat(strings.TrimSuffix(strings.ReplaceAll(val, ",", "."), "%"), 64); err == nil {
				cur.Percent = p
			}
		case "Protection Status":
			switch {
			case strings.Contains(val, "Protection On"):
				cur.Protection = "On"
			case strings.Contains(val, "Protection Off"):
				cur.Protection = "Off"
			default:
				cur.Protection = "Unknown"
			}
		}
	}
	return vols
}

// BitLockerVerdict judges one volume: pass when protection is on, warn while encryption is still
// in progress, fail when the volume is decrypted or protection is suspended, unknown otherwise.
func BitLockerVerdict(v BitLockerVolume) (state, value string) {
	prot := strings.ToLower(strings.TrimSpace(v.Protection))
	status := strings.TrimSpace(v.Status)
	pct := ""
	if v.Percent >= 0 && status != "" {
		pct = " " + strconv.FormatFloat(v.Percent, 'f', -1, 64) + "%"
	}
	describe := func(p string) string {
		s := "Protection " + p
		if status != "" {
			s += ", " + status + pct
		}
		return s
	}
	switch prot {
	case "on", "1":
		return "pass", describe("On")
	case "off", "0":
		ls := strings.ToLower(status)
		if strings.Contains(ls, "inprogress") && strings.Contains(ls, "encryption") {
			return "warn", describe("Off")
		}
		if strings.Contains(ls, "fullyencrypted") {
			return "fail", describe("Off (suspended)")
		}
		return "fail", describe("Off")
	}
	return "unknown", describe("Unknown")
}

// WindowsUpdateResult is the JSON the Windows Update search script prints.
type WindowsUpdateResult struct {
	OK       bool   `json:"ok"`
	Count    int    `json:"count"`
	Security int    `json:"security"`
	Error    string `json:"error"`
}

// ParseWindowsUpdateResult decodes the Microsoft.Update.Session search script output.
func ParseWindowsUpdateResult(raw []byte) (WindowsUpdateResult, bool) {
	var r WindowsUpdateResult
	if json.Unmarshal(raw, &r) != nil {
		return WindowsUpdateResult{}, false
	}
	if r.OK && (r.Count < 0 || r.Security < 0) {
		return WindowsUpdateResult{}, false
	}
	return r, true
}

// ── Linux ────────────────────────────────────────────────────────────────────────────────────

// ParseUfwStatus reads `ufw status`. ok=false when the output is not a status (e.g. "You need to be root").
func ParseUfwStatus(out string) (active bool, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		t := strings.ToLower(strings.TrimSpace(line))
		if strings.HasPrefix(t, "status:") {
			v := strings.TrimSpace(strings.TrimPrefix(t, "status:"))
			switch v {
			case "active":
				return true, true
			case "inactive":
				return false, true
			}
		}
	}
	return false, false
}

// ParseFirewalldState reads `firewall-cmd --state` ("running" / "not running").
func ParseFirewalldState(out string) (running bool, ok bool) {
	t := strings.ToLower(strings.TrimSpace(out))
	switch {
	case t == "running":
		return true, true
	case strings.HasPrefix(t, "not running"):
		return false, true
	}
	return false, false
}

// NftSummary describes the input filtering found in `nft list ruleset`.
type NftSummary struct {
	Tables      int
	InputChains int  // base chains hooked on input
	InputRules  int  // rules inside those chains
	DropPolicy  bool // an input chain's policy is drop
}

// Filtering reports whether the ruleset actually filters inbound traffic.
func (s NftSummary) Filtering() bool {
	return s.InputChains > 0 && (s.DropPolicy || s.InputRules > 0)
}

// ParseNftRuleset summarises `nft list ruleset`.
func ParseNftRuleset(out string) NftSummary {
	var s NftSummary
	depth := 0
	inChain := false
	isInput := false
	chainRules := 0
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		switch {
		case strings.HasPrefix(t, "table ") && strings.HasSuffix(t, "{"):
			s.Tables++
			depth++
			continue
		case strings.HasPrefix(t, "chain ") && strings.HasSuffix(t, "{"):
			inChain, isInput, chainRules = true, false, 0
			depth++
			continue
		case strings.HasSuffix(t, "{"):
			// sets, maps, flowtables: not rules
			depth++
			continue
		case t == "}":
			if inChain && depth == 2 {
				if isInput {
					s.InputRules += chainRules
				}
				inChain = false
			}
			depth--
			continue
		}
		if !inChain || depth != 2 {
			continue
		}
		if strings.HasPrefix(t, "type ") && strings.Contains(t, " hook ") {
			if strings.Contains(t, "hook input") {
				isInput = true
				s.InputChains++
				if strings.Contains(t, "policy drop") || strings.Contains(t, "policy reject") {
					s.DropPolicy = true
				}
			}
			continue
		}
		if strings.HasPrefix(t, "policy ") {
			if isInput && (strings.Contains(t, "drop") || strings.Contains(t, "reject")) {
				s.DropPolicy = true
			}
			continue
		}
		if strings.HasPrefix(t, "comment ") {
			continue
		}
		chainRules++
	}
	return s
}

// LsblkDevice is one row of `lsblk -P -o NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT`.
type LsblkDevice struct {
	Name, KName, PKName, Type, FSType, Mount string
}

var lsblkPair = regexp.MustCompile(`([A-Z:-]+)="((?:[^"\\]|\\.)*)"`)

// ParseLsblkPairs parses lsblk's -P (KEY="value") output.
func ParseLsblkPairs(out string) []LsblkDevice {
	var list []LsblkDevice
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		d := LsblkDevice{}
		for _, m := range lsblkPair.FindAllStringSubmatch(line, -1) {
			v := unescapeLsblk(m[2])
			switch m[1] {
			case "NAME":
				d.Name = v
			case "KNAME":
				d.KName = v
			case "PKNAME":
				d.PKName = v
			case "TYPE":
				d.Type = v
			case "FSTYPE":
				d.FSType = v
			case "MOUNTPOINT":
				d.Mount = v
			}
		}
		if d.Name == "" && d.KName == "" {
			continue
		}
		if d.KName == "" {
			d.KName = d.Name
		}
		list = append(list, d)
	}
	return list
}

func unescapeLsblk(s string) string {
	// lsblk hex-escapes unsafe characters, e.g. a space in a mount point as \x20.
	if !strings.Contains(s, `\x`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && s[i+1] == 'x' {
			if v, err := strconv.ParseUint(s[i+2:i+4], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// MountEncryption is the encryption verdict for one mounted filesystem.
type MountEncryption struct {
	Mount     string
	Device    string
	Encrypted bool
	CryptDev  string // the dm-crypt device it sits on, when encrypted
}

// EvaluateLinuxMountEncryption decides, for each mounted data filesystem, whether a dm-crypt
// device (TYPE "crypt", e.g. LUKS) lies underneath it. /boot, the EFI partition, swap, loop
// devices (snaps) and optical drives are not judged.
func EvaluateLinuxMountEncryption(devs []LsblkDevice) []MountEncryption {
	byKName := map[string]LsblkDevice{}
	for _, d := range devs {
		byKName[d.KName] = d
	}
	var out []MountEncryption
	seen := map[string]bool{}
	for _, d := range devs {
		m := d.Mount
		if m == "" || m == "[SWAP]" || !strings.HasPrefix(m, "/") || seen[m] {
			continue
		}
		if m == "/boot" || strings.HasPrefix(m, "/boot/") || m == "/efi" || strings.HasPrefix(m, "/snap/") {
			continue
		}
		if d.Type == "loop" || d.Type == "rom" || d.FSType == "squashfs" || d.FSType == "iso9660" {
			continue
		}
		seen[m] = true
		me := MountEncryption{Mount: m, Device: d.Name}
		cur := d
		for hops := 0; hops < 16; hops++ {
			if cur.Type == "crypt" {
				me.Encrypted = true
				me.CryptDev = cur.Name
				break
			}
			parent, ok := byKName[cur.PKName]
			if cur.PKName == "" || !ok {
				break
			}
			cur = parent
		}
		out = append(out, me)
	}
	return out
}

// ParseDmsetupCryptTargets parses `dmsetup ls --target crypt` into device-mapper names.
func ParseDmsetupCryptTargets(out string) []string {
	var names []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || strings.EqualFold(strings.Join(f, " "), "No devices found") {
			continue
		}
		if len(f) >= 2 && strings.HasPrefix(f[1], "(") {
			names = append(names, f[0])
		}
	}
	return names
}

// CryptsetupStatus is the subset of `cryptsetup status NAME` the evidence shows.
type CryptsetupStatus struct {
	Active bool
	Type   string
	Cipher string
}

// ParseCryptsetupStatus parses `cryptsetup status NAME`.
func ParseCryptsetupStatus(out string) CryptsetupStatus {
	var s CryptsetupStatus
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if strings.Contains(t, " is active") {
			s.Active = true
			continue
		}
		k, v, ok := strings.Cut(t, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "type":
			s.Type = strings.TrimSpace(v)
		case "cipher":
			s.Cipher = strings.TrimSpace(v)
		}
	}
	return s
}

// AptUpgrades counts the packages `apt-get -s upgrade` would install, and those coming from a
// "-security" pocket (Debian "bookworm-security", Ubuntu "jammy-security").
func AptUpgrades(out string) (total, security int, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "Inst ") {
			total++
			if strings.Contains(strings.ToLower(t), "-security") {
				security++
			}
			ok = true
			continue
		}
		// The summary line proves the simulation ran even with nothing to upgrade.
		if strings.Contains(t, " upgraded,") && strings.Contains(t, " newly installed") {
			ok = true
		}
	}
	return total, security, ok
}

var rpmNevra = regexp.MustCompile(`^[A-Za-z0-9_.+-]+-[0-9][^ ]*\.[A-Za-z0-9_]+$`)

// DnfSecurityUpdates counts the distinct packages listed by `dnf updateinfo list --security` or
// `yum updateinfo list security`. dnf4/yum print "ADVISORY  Severity/Sec.  PACKAGE"; dnf5 prints
// "ADVISORY  security  Severity  PACKAGE  ISSUED". ok=false when the output carries no recognisable
// table and no "nothing to do" marker.
func DnfSecurityUpdates(out string) (count int, ok bool) {
	pkgs := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		low := strings.ToLower(t)
		if t == "" {
			continue
		}
		if strings.HasPrefix(low, "updateinfo list done") || strings.HasPrefix(low, "last metadata expiration") ||
			strings.HasPrefix(low, "loaded plugins") || strings.HasPrefix(low, "no advisor") || strings.HasPrefix(low, "name ") ||
			strings.HasPrefix(low, "updating and loading") || strings.HasPrefix(low, "repositories loaded") {
			ok = true
			continue
		}
		f := strings.Fields(t)
		if len(f) < 3 {
			continue
		}
		isSec := false
		for _, x := range f[1:] {
			lx := strings.ToLower(x)
			if lx == "security" || strings.HasSuffix(lx, "/sec.") {
				isSec = true
				break
			}
		}
		if !isSec {
			continue
		}
		for _, x := range f[2:] {
			if rpmNevra.MatchString(x) {
				pkgs[x] = true
				ok = true
				break
			}
		}
	}
	return len(pkgs), ok
}

// ZypperSecurityPatches counts "needed" security patches in
// `zypper --non-interactive list-patches --category security` table output.
func ZypperSecurityPatches(out string) (count int, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		low := strings.ToLower(t)
		if strings.HasPrefix(low, "no updates found") || strings.Contains(low, "found 0 applicable patches") {
			ok = true
			continue
		}
		if !strings.Contains(t, "|") {
			continue
		}
		cols := strings.Split(t, "|")
		hasSecurity, needed := false, false
		for _, c := range cols {
			c = strings.ToLower(strings.TrimSpace(c))
			if c == "security" {
				hasSecurity = true
			}
			if c == "needed" {
				needed = true
			}
			if c == "category" {
				ok = true
			}
		}
		if hasSecurity && needed {
			count++
			ok = true
		}
	}
	return count, ok
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

// ParseSocketfilterfwState reads `socketfilterfw --getglobalstate`: "Firewall is enabled. (State = 1)",
// "Firewall is disabled. (State = 0)" or "Firewall is blocking all non-essential incoming connections. (State = 2)".
func ParseSocketfilterfwState(out string) (enabled bool, ok bool) {
	low := strings.ToLower(out)
	switch {
	case strings.Contains(low, "state = 1"), strings.Contains(low, "state = 2"),
		strings.Contains(low, "firewall is enabled"), strings.Contains(low, "blocking all"):
		return true, true
	case strings.Contains(low, "state = 0"), strings.Contains(low, "firewall is disabled"):
		return false, true
	}
	return false, false
}

// ParsePfctlInfo reads the Status line of `pfctl -s info`.
func ParsePfctlInfo(out string) (enabled bool, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "Status:") {
			v := strings.TrimSpace(strings.TrimPrefix(t, "Status:"))
			if strings.HasPrefix(v, "Enabled") {
				return true, true
			}
			if strings.HasPrefix(v, "Disabled") {
				return false, true
			}
		}
	}
	return false, false
}

// ParseFdesetupStatus reads `fdesetup status` into an evidence state.
func ParseFdesetupStatus(out string) (state string, ok bool) {
	low := strings.ToLower(strings.TrimSpace(out))
	switch {
	case strings.Contains(low, "encryption in progress"):
		return "warn", true
	case strings.Contains(low, "decryption in progress"):
		return "fail", true
	case strings.Contains(low, "will be enabled after the next restart"):
		return "warn", true
	case strings.HasPrefix(low, "filevault is on"):
		return "pass", true
	case strings.HasPrefix(low, "filevault is off"):
		return "fail", true
	}
	return "", false
}

// ParseCsrutilStatus reads `csrutil status`: enabled → pass, disabled → fail, a custom
// (partially disabled) configuration → warn.
func ParseCsrutilStatus(out string) (state string, ok bool) {
	low := strings.ToLower(out)
	idx := strings.Index(low, "system integrity protection status:")
	if idx < 0 {
		return "", false
	}
	v := strings.TrimSpace(low[idx+len("system integrity protection status:"):])
	switch {
	case strings.HasPrefix(v, "enabled"):
		if strings.Contains(v, "custom configuration") {
			return "warn", true
		}
		return "pass", true
	case strings.HasPrefix(v, "disabled"):
		return "fail", true
	case strings.HasPrefix(v, "unknown"):
		return "warn", true
	}
	return "", false
}

// ParseSpctlStatus reads `spctl --status` ("assessments enabled" / "assessments disabled").
func ParseSpctlStatus(out string) (enabled bool, ok bool) {
	low := strings.ToLower(strings.TrimSpace(out))
	switch {
	case strings.Contains(low, "assessments enabled"):
		return true, true
	case strings.Contains(low, "assessments disabled"):
		return false, true
	}
	return false, false
}

// ParseSoftwareUpdateList counts updates in `softwareupdate -l` output (both the Catalina+
// "* Label: …" format and the older "   * Name" format). ok=false when the tool reported an error.
func ParseSoftwareUpdateList(out string) (count int, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		low := strings.ToLower(t)
		if strings.Contains(low, "no new software available") {
			return 0, true
		}
		if strings.HasPrefix(t, "* ") {
			count++
			ok = true
			continue
		}
		if strings.Contains(low, "software update found the following") {
			ok = true
		}
	}
	return count, ok
}
