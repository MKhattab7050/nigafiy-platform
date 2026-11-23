package sysinfo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
)

// The samples below are written from each tool's documented output format; they are not captured
// from real machines in this repository's CI (Linux and macOS tools do not exist on the build host).

func TestDecodeAVProductState(t *testing.T) {
	cases := []struct {
		state            int64
		enabled, current bool
	}{
		{397568, true, true},   // 0x061100 Windows Defender, on, up to date
		{397584, true, false},  // 0x061110 on, out of date
		{393472, false, true},  // 0x060100 off
		{262144, false, true},  // 0x040000 off
		{266240, true, true},   // 0x041000 third-party, on
		{266256, true, false},  // 0x041010 third-party, on, out of date
		{393232, false, false}, // 0x060010 off, out of date
	}
	for _, c := range cases {
		got := DecodeAVProductState(c.state)
		if got.Enabled != c.enabled || got.UpToDate != c.current {
			t.Errorf("productState %d (0x%06X): got %+v, want enabled=%t upToDate=%t", c.state, c.state, got, c.enabled, c.current)
		}
	}
}

func TestParseFirewallEnabled(t *testing.T) {
	for in, want := range map[string][2]bool{"True": {true, true}, "False": {false, true}, "1": {true, true}, "0": {false, true}, "NotConfigured": {false, false}, "": {false, false}} {
		on, ok := ParseFirewallEnabled(in)
		if on != want[0] || ok != want[1] {
			t.Errorf("%q: got %t/%t", in, on, ok)
		}
	}
}

const manageBdeSample = `BitLocker Drive Encryption: Configuration Tool version 10.0.22621
Copyright (C) 2013 Microsoft Corporation. All rights reserved.

Disk volumes that can be protected with
BitLocker Drive Encryption:
Volume C: [OS]
[OS Volume]

    Size:                 475.95 GB
    BitLocker Version:    2.0
    Conversion Status:    Fully Encrypted
    Percentage Encrypted: 100.0%
    Encryption Method:    XTS-AES 128
    Protection Status:    Protection On
    Lock Status:          Unlocked
    Identification Field: Unknown
    Key Protectors:
        TPM
        Numerical Password

Volume D: [Data]
[Data Volume]

    Size:                 931.39 GB
    BitLocker Version:    None
    Conversion Status:    Fully Decrypted
    Percentage Encrypted: 0.0%
    Encryption Method:    None
    Protection Status:    Protection Off
    Lock Status:          Unlocked
    Identification Field: None
    Automatic Unlock:     Disabled
    Key Protectors:       None Found

Volume E: [Backup]
[Data Volume]

    Size:                 100.00 GB
    BitLocker Version:    2.0
    Conversion Status:    Fully Encrypted
    Percentage Encrypted: 100.0%
    Encryption Method:    XTS-AES 128
    Protection Status:    Protection Off
    Lock Status:          Unlocked
`

func TestParseManageBdeStatusAndVerdicts(t *testing.T) {
	vols := ParseManageBdeStatus(manageBdeSample)
	if len(vols) != 3 {
		t.Fatalf("want 3 volumes, got %+v", vols)
	}
	want := []struct{ mount, state, contains string }{
		{"C:", "pass", "Protection On, FullyEncrypted 100%"},
		{"D:", "fail", "Protection Off, FullyDecrypted 0%"},
		{"E:", "fail", "suspended"},
	}
	for i, w := range want {
		state, value := BitLockerVerdict(vols[i])
		if vols[i].Mount != w.mount || state != w.state || !strings.Contains(value, w.contains) {
			t.Errorf("volume %d: mount=%s state=%s value=%q, want %+v", i, vols[i].Mount, state, value, w)
		}
	}
	// Get-BitLockerVolume and CIM shapes.
	for _, c := range []struct {
		v     BitLockerVolume
		state string
	}{
		{BitLockerVolume{Mount: "C:", Protection: "On", Status: "FullyEncrypted", Percent: 100}, "pass"},
		{BitLockerVolume{Mount: "C:", Protection: "Off", Status: "EncryptionInProgress", Percent: 42}, "warn"},
		{BitLockerVolume{Mount: "C:", Protection: "1", Percent: -1}, "pass"},
		{BitLockerVolume{Mount: "C:", Protection: "0", Percent: -1}, "fail"},
		{BitLockerVolume{Mount: "C:", Protection: "2", Percent: -1}, "unknown"},
	} {
		if got, _ := BitLockerVerdict(c.v); got != c.state {
			t.Errorf("%+v: got %s want %s", c.v, got, c.state)
		}
	}
	if len(ParseManageBdeStatus("ERROR: An attempt to access a required resource was denied.\r\n")) != 0 {
		t.Fatal("an access-denied message must yield no volumes")
	}
}

func fixedEnv(goos string) complianceEnv {
	at := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	return complianceEnv{goos: goos, now: func() time.Time { return at }}
}

func byCheck(ev []Evidence, check string) []Evidence {
	var out []Evidence
	for _, e := range ev {
		if e.Check == check {
			out = append(out, e)
		}
	}
	return out
}

// A report as printed by the Windows script (ConvertTo-Json -Compress) on a workstation running
// elevated, with a third-party antivirus active and Defender passive.
const windowsReportSample = `{"elevated":true,"fw":[{"name":"Domain","enabled":"True"},{"name":"Private","enabled":"True"},{"name":"Public","enabled":"False"}],"fw_source":"Get-NetFirewallProfile -PolicyStore ActiveStore","av":[{"name":"Windows Defender","state":393472},{"name":"ESET Security","state":266240}],"av_ok":true,"mp":{"am_service":true,"av":false,"rtp":false,"sig_age":0,"mode":"Passive Mode"},"fixed":["C:","D:"],"bl":{"mount":"C:","type":"OperatingSystem","protection":"On","status":"FullyEncrypted","pct":100},"bl_source":"Get-BitLockerVolume"}`

func TestWindowsEvidenceFromReport(t *testing.T) {
	rep, err := ParseWindowsSecurityReport([]byte(windowsReportSample))
	if err != nil {
		t.Fatal(err)
	}
	ev := WindowsEvidence(rep, fixedEnv("windows"))

	fw := byCheck(ev, checkFirewall)
	if len(fw) != 3 || fw[0].State != "pass" || fw[1].State != "pass" || fw[2].State != "fail" || fw[2].Subject != "Public profile" {
		t.Fatalf("firewall evidence: %+v", fw)
	}
	if fw[2].Source != "Get-NetFirewallProfile -PolicyStore ActiveStore" || fw[2].MeasuredAt != "2026-11-22T10:00:00Z" {
		t.Fatalf("evidence must carry source and time: %+v", fw[2])
	}

	av := byCheck(ev, checkAntivirus)
	states := map[string]string{}
	for _, e := range av {
		states[e.Subject+"|"+e.Source] = e.State
	}
	if states["ESET Security|WMI root/SecurityCenter2 AntiVirusProduct"] != "pass" ||
		states["Windows Defender|WMI root/SecurityCenter2 AntiVirusProduct"] != "info" ||
		states["Microsoft Defender Antivirus|Get-MpComputerStatus"] != "info" {
		t.Fatalf("antivirus evidence: %+v", av)
	}

	dc := byCheck(ev, checkDiskCrypt)
	if len(dc) != 2 || dc[0].Subject != "C:" || dc[0].State != "pass" || dc[1].Subject != "D:" || dc[1].State != "unknown" {
		t.Fatalf("disk encryption evidence: %+v", dc)
	}

	var p SecurityPosture
	ApplyEvidence(&p, ev)
	if p.FirewallEnabled == nil || *p.FirewallEnabled || p.AntivirusEnabled == nil || !*p.AntivirusEnabled || p.DiskEncrypted != nil {
		t.Fatalf("summary: fw=%v av=%v disk=%v", p.FirewallEnabled, p.AntivirusEnabled, p.DiskEncrypted)
	}
}

func TestWindowsEvidenceNotElevatedAndNoAV(t *testing.T) {
	raw := `{"elevated":false,"fw":[],"fw_error":"Access denied","fw_source":"registry SharedAccess","av_ok":true,"mp":{"am_service":true,"av":false,"rtp":false,"sig_age":2,"mode":"Normal"},"fixed":"C:","bl_error":"Access denied","bl_cim_error":"Access denied"}`
	rep, err := ParseWindowsSecurityReport([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	ev := WindowsEvidence(rep, fixedEnv("windows"))
	fw := byCheck(ev, checkFirewall)
	if len(fw) != 3 || fw[0].State != "unknown" || !strings.Contains(fw[0].Reason, "Access denied") {
		t.Fatalf("every missing profile is unknown with the reason: %+v", fw)
	}
	dc := byCheck(ev, checkDiskCrypt)
	if len(dc) != 1 || dc[0].State != "unknown" || !strings.Contains(dc[0].Reason, "not running elevated") {
		t.Fatalf("BitLocker without elevation must be unknown with reason: %+v", dc)
	}
	av := byCheck(ev, checkAntivirus)
	hasFail := false
	for _, e := range av {
		if e.State == "fail" {
			hasFail = true
		}
	}
	if !hasFail {
		t.Fatalf("Defender off with no other product must fail: %+v", av)
	}
}

func TestWindowsUpdateEvidence(t *testing.T) {
	env := fixedEnv("windows")
	r, ok := ParseWindowsUpdateResult([]byte(`{"ok":true,"count":3,"security":1}`))
	e := windowsUpdateEvidence(r, ok, "", nil, env)
	if e.State != "fail" || e.Count == nil || *e.Count != 3 || e.Value != "3 pending (1 security)" {
		t.Fatalf("pending updates: %+v", e)
	}
	r, ok = ParseWindowsUpdateResult([]byte(`{"ok":true,"count":0,"security":0}`))
	if e = windowsUpdateEvidence(r, ok, "", nil, env); e.State != "pass" || *e.Count != 0 {
		t.Fatalf("no updates: %+v", e)
	}
	r, ok = ParseWindowsUpdateResult([]byte(`{"ok":false,"error":"Exception from HRESULT: 0x8024402C"}`))
	if e = windowsUpdateEvidence(r, ok, "", nil, env); e.State != "unknown" || e.Count != nil || !strings.Contains(e.Reason, "0x8024402C") {
		t.Fatalf("search failure must be unknown: %+v", e)
	}
	if e = windowsUpdateEvidence(WindowsUpdateResult{}, false, "", errors.New("timed out after 4m0s"), env); e.State != "unknown" || !strings.Contains(e.Reason, "timed out") {
		t.Fatalf("timeout must be unknown: %+v", e)
	}
}

func TestParseUfwFirewalldNft(t *testing.T) {
	ufw := []struct {
		out        string
		active, ok bool
	}{
		{"Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n", true, true},
		{"Status: inactive\n", false, true},
		{"ERROR: You need to be root to run this script\n", false, false},
	}
	for _, c := range ufw {
		a, ok := ParseUfwStatus(c.out)
		if a != c.active || ok != c.ok {
			t.Errorf("ufw %q: %t/%t", c.out, a, ok)
		}
	}
	for out, want := range map[string][2]bool{"running\n": {true, true}, "not running\n": {false, true}, "FirewallD is not running\n": {false, false}} {
		r, ok := ParseFirewalldState(out)
		if r != want[0] || ok != want[1] {
			t.Errorf("firewalld %q: %t/%t", out, r, ok)
		}
	}

	filtering := `table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		iif "lo" accept
		tcp dport 22 accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
	chain output {
		type filter hook output priority filter; policy accept;
	}
}
`
	open := `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
	}
	chain output {
		type filter hook output priority filter; policy accept;
	}
}
`
	withSet := `table ip nat {
	set blocklist {
		type ipv4_addr
		elements = { 10.0.0.1 }
	}
	chain prerouting {
		type nat hook prerouting priority dstnat; policy accept;
	}
}
table inet firewalld {
	chain filter_INPUT {
		type filter hook input priority filter + 10; policy accept;
		ct state { established, related } accept
		jump filter_INPUT_ZONES
		reject with icmpx admin-prohibited
	}
}
`
	if s := ParseNftRuleset(filtering); !s.Filtering() || s.InputChains != 1 || s.InputRules != 3 || !s.DropPolicy || s.Tables != 1 {
		t.Fatalf("filtering ruleset: %+v", s)
	}
	if s := ParseNftRuleset(open); s.Filtering() {
		t.Fatalf("accept-all input chain is not filtering: %+v", s)
	}
	if s := ParseNftRuleset(""); s.Filtering() || s.Tables != 0 {
		t.Fatalf("empty ruleset: %+v", s)
	}
	if s := ParseNftRuleset(withSet); !s.Filtering() || s.InputRules != 3 || s.Tables != 2 {
		t.Fatalf("set elements are not rules; firewalld input chain filters: %+v", s)
	}
}

const lsblkLUKS = `NAME="nvme0n1" KNAME="nvme0n1" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""
NAME="nvme0n1p1" KNAME="nvme0n1p1" PKNAME="nvme0n1" TYPE="part" FSTYPE="vfat" MOUNTPOINT="/boot/efi"
NAME="nvme0n1p2" KNAME="nvme0n1p2" PKNAME="nvme0n1" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/boot"
NAME="nvme0n1p3" KNAME="nvme0n1p3" PKNAME="nvme0n1" TYPE="part" FSTYPE="crypto_LUKS" MOUNTPOINT=""
NAME="dm_crypt-0" KNAME="dm-0" PKNAME="nvme0n1p3" TYPE="crypt" FSTYPE="LVM2_member" MOUNTPOINT=""
NAME="ubuntu--vg-ubuntu--lv" KNAME="dm-1" PKNAME="dm-0" TYPE="lvm" FSTYPE="ext4" MOUNTPOINT="/"
NAME="loop0" KNAME="loop0" PKNAME="" TYPE="loop" FSTYPE="squashfs" MOUNTPOINT="/snap/core22/1380"
NAME="sda" KNAME="sda" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""
NAME="sda1" KNAME="sda1" PKNAME="sda" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/mnt/data\x20disk"
NAME="sr0" KNAME="sr0" PKNAME="" TYPE="rom" FSTYPE="" MOUNTPOINT=""
`

func TestLinuxMountEncryption(t *testing.T) {
	mounts := EvaluateLinuxMountEncryption(ParseLsblkPairs(lsblkLUKS))
	if len(mounts) != 2 {
		t.Fatalf("want / and /mnt/data disk judged, got %+v", mounts)
	}
	if mounts[0].Mount != "/" || !mounts[0].Encrypted || mounts[0].CryptDev != "dm_crypt-0" {
		t.Fatalf("root on LVM on LUKS must be encrypted: %+v", mounts[0])
	}
	if mounts[1].Mount != "/mnt/data disk" || mounts[1].Encrypted {
		t.Fatalf("plain data partition must not be encrypted: %+v", mounts[1])
	}
	if names := ParseDmsetupCryptTargets("luks-3a1b2c\t(253:0)\n"); len(names) != 1 || names[0] != "luks-3a1b2c" {
		t.Fatalf("dmsetup: %v", names)
	}
	if names := ParseDmsetupCryptTargets("No devices found\n"); len(names) != 0 {
		t.Fatalf("dmsetup none: %v", names)
	}
	cs := ParseCryptsetupStatus("/dev/mapper/dm_crypt-0 is active and is in use.\n  type:    LUKS2\n  cipher:  aes-xts-plain64\n  keysize: 512 bits\n")
	if !cs.Active || cs.Type != "LUKS2" || cs.Cipher != "aes-xts-plain64" {
		t.Fatalf("cryptsetup: %+v", cs)
	}
}

func TestLinuxUpdateParsers(t *testing.T) {
	apt := `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  libssl3 openssl tzdata
3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst openssl [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
Inst tzdata [2023c-0ubuntu0.22.04.1] (2024a-0ubuntu0.22.04 Ubuntu:22.04/jammy-updates [all])
Conf libssl3 (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
`
	if total, sec, ok := AptUpgrades(apt); total != 3 || sec != 2 || !ok {
		t.Fatalf("apt: %d/%d/%t", total, sec, ok)
	}
	if total, sec, ok := AptUpgrades("Reading package lists...\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n"); total != 0 || sec != 0 || !ok {
		t.Fatalf("apt none: %d/%d/%t", total, sec, ok)
	}
	if _, _, ok := AptUpgrades("E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\n"); ok {
		t.Fatal("apt error must not be a measurement")
	}

	dnf4 := `Last metadata expiration check: 0:12:01 ago on Sun 22 Nov 2026 09:00:00 AM UTC.
RHSA-2026:1234 Important/Sec. openssl-libs-1:3.0.7-27.el9.x86_64
RHSA-2026:1234 Important/Sec. openssl-1:3.0.7-27.el9.x86_64
RHSA-2026:1300 Moderate/Sec.  curl-7.76.1-29.el9.x86_64
RHBA-2026:1301 bugfix         tzdata-2026a-1.el9.noarch
`
	if n, ok := DnfSecurityUpdates(dnf4); n != 3 || !ok {
		t.Fatalf("dnf4: %d/%t", n, ok)
	}
	dnf5 := `Name                  Type     Severity  Package                         Issued
FEDORA-2026-1a2b3c4d5e security Important openssl-libs-1:3.2.2-1.fc41.x86_64 2026-11-01 00:00:00
FEDORA-2026-99aa88bb77 security Moderate  curl-8.9.1-2.fc41.x86_64         2026-11-03 00:00:00
`
	if n, ok := DnfSecurityUpdates(dnf5); n != 2 || !ok {
		t.Fatalf("dnf5: %d/%t", n, ok)
	}
	yum := `Loaded plugins: fastestmirror, product-id
RHSA-2024:0001 Critical/Sec. kernel-3.10.0-1160.108.1.el7.x86_64
updateinfo list done
`
	if n, ok := DnfSecurityUpdates(yum); n != 1 || !ok {
		t.Fatalf("yum: %d/%t", n, ok)
	}
	zypper := `Loading repository data...
Reading installed packages...
Repository                  | Name                     | Category | Severity  | Interactive | Status | Summary
----------------------------+--------------------------+----------+-----------+-------------+--------+---------------------------
Update repository with u... | openSUSE-SLE-15.5-2026-1 | security | important | ---         | needed | Security update for openssl
Update repository with u... | openSUSE-SLE-15.5-2026-2 | security | moderate  | ---         | applied| Security update for curl
`
	if n, ok := ZypperSecurityPatches(zypper); n != 1 || !ok {
		t.Fatalf("zypper: %d/%t", n, ok)
	}
	if n, ok := ZypperSecurityPatches("Loading repository data...\nReading installed packages...\nNo updates found.\n"); n != 0 || !ok {
		t.Fatalf("zypper none: %d/%t", n, ok)
	}
}

func TestMacOSParsers(t *testing.T) {
	for out, want := range map[string][2]bool{
		"Firewall is enabled. (State = 1)\n":                                         {true, true},
		"Firewall is disabled. (State = 0)\n":                                        {false, true},
		"Firewall is blocking all non-essential incoming connections. (State = 2)\n": {true, true},
		"": {false, false},
	} {
		on, ok := ParseSocketfilterfwState(out)
		if on != want[0] || ok != want[1] {
			t.Errorf("socketfilterfw %q: %t/%t", out, on, ok)
		}
	}
	pfOn := "No ALTQ support in kernel\nALTQ related functions disabled\nStatus: Enabled for 0 days 01:02:03           Debug: Urgent\n\nState Table                          Total             Rate\n"
	if on, ok := ParsePfctlInfo(pfOn); !on || !ok {
		t.Fatal("pf enabled")
	}
	if on, ok := ParsePfctlInfo("Status: Disabled                              Debug: Urgent\n"); on || !ok {
		t.Fatal("pf disabled")
	}
	if _, ok := ParsePfctlInfo("pfctl: /dev/pf: Permission denied\n"); ok {
		t.Fatal("pf permission denied must not parse")
	}
	for out, want := range map[string]string{
		"FileVault is On.\n":  "pass",
		"FileVault is Off.\n": "fail",
		"FileVault is On.\nEncryption in progress: Percent completed = 45.3\n": "warn",
		"FileVault is Off, but will be enabled after the next restart.\n":      "warn",
		"FileVault is On.\nDecryption in progress: Percent completed = 10.0\n": "fail",
	} {
		if got, ok := ParseFdesetupStatus(out); got != want || !ok {
			t.Errorf("fdesetup %q: %s/%t", out, got, ok)
		}
	}
	for out, want := range map[string]string{
		"System Integrity Protection status: enabled.\n":                                                                      "pass",
		"System Integrity Protection status: disabled.\n":                                                                     "fail",
		"System Integrity Protection status: unknown (Custom Configuration).\n\nConfiguration:\n\tApple Internal: disabled\n": "warn",
	} {
		if got, ok := ParseCsrutilStatus(out); got != want || !ok {
			t.Errorf("csrutil %q: %s/%t", out, got, ok)
		}
	}
	if on, ok := ParseSpctlStatus("assessments enabled\n"); !on || !ok {
		t.Fatal("spctl enabled")
	}
	if on, ok := ParseSpctlStatus("assessments disabled\n"); on || !ok {
		t.Fatal("spctl disabled")
	}
	su := `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Sonoma 14.7.1-23H222
	Title: macOS Sonoma 14.7.1, Version: 14.7.1, Size: 1234567KiB, Recommended: YES, Action: restart,
* Label: Safari18.1.1SonomaAuto-18.1.1
	Title: Safari, Version: 18.1.1, Size: 150000KiB, Recommended: YES,
`
	if n, ok := ParseSoftwareUpdateList(su); n != 2 || !ok {
		t.Fatalf("softwareupdate: %d/%t", n, ok)
	}
	if n, ok := ParseSoftwareUpdateList("Software Update Tool\n\nFinding available software\nNo new software available.\n"); n != 0 || !ok {
		t.Fatalf("softwareupdate none: %d/%t", n, ok)
	}
	if _, ok := ParseSoftwareUpdateList("Software Update Tool\n\nFinding available software\nCan't connect to the Apple Software Update server.\n"); ok {
		t.Fatal("softwareupdate error must not be a measurement")
	}
}

// fakeEnv answers commands from a table and records what ran.
func fakeEnv(goos string, installed []string, outputs map[string]string, failing map[string]bool) (complianceEnv, *[]string) {
	var ran []string
	env := fixedEnv(goos)
	have := map[string]bool{}
	for _, n := range installed {
		have[n] = true
	}
	env.has = func(n string) bool { return have[n] }
	env.run = func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
		key := strings.TrimSpace(name + " " + strings.Join(args, " "))
		ran = append(ran, key)
		if failing[key] {
			return outputs[key], errors.New("exit status 1")
		}
		return outputs[key], nil
	}
	return env, &ran
}

func TestLinuxCollectorsWithFakeCommands(t *testing.T) {
	env, ran := fakeEnv("linux", []string{"ufw", "nft", "apt-get", "cryptsetup"}, map[string]string{
		"ufw status":       "Status: inactive\n",
		"nft list ruleset": "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t}\n}\n",
		"lsblk -P -o NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT": lsblkLUKS,
		"cryptsetup status -- dm_crypt-0":                      "/dev/mapper/dm_crypt-0 is active.\n  type:    LUKS2\n  cipher:  aes-xts-plain64\n",
		"apt-get -s -o Debug::NoLocking=1 upgrade":             "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
	}, nil)
	ev := collectFastChecks(context.Background(), env)
	fw := byCheck(ev, checkFirewall)
	if len(fw) != 2 || fw[0].Subject != "ufw" || fw[0].State != "info" || fw[1].Subject != "nftables" || fw[1].State != "pass" {
		t.Fatalf("an active nftables ruleset makes an inactive ufw context only: %+v", fw)
	}
	dc := byCheck(ev, checkDiskCrypt)
	if len(dc) != 2 || dc[0].State != "pass" || !strings.Contains(dc[0].Value, "LUKS2") || dc[1].State != "fail" {
		t.Fatalf("disk encryption: %+v", dc)
	}
	up := collectUpdateChecks(context.Background(), env)
	if len(up) != 1 || up[0].State != "pass" || *up[0].Count != 0 {
		t.Fatalf("apt updates: %+v", up)
	}
	if !strings.Contains(strings.Join(*ran, "\n"), "cryptsetup status -- dm_crypt-0") {
		t.Fatalf("the device name is passed after --: %v", *ran)
	}

	// Every firewall front-end inactive: fail. ufw unreadable (not root): unknown, never "off".
	env, _ = fakeEnv("linux", []string{"ufw"}, map[string]string{"ufw status": "Status: inactive\n"}, nil)
	if fw := byCheck(collectFastChecks(context.Background(), env), checkFirewall); len(fw) != 1 || fw[0].State != "fail" {
		t.Fatalf("inactive ufw alone: %+v", fw)
	}
	env, _ = fakeEnv("linux", []string{"ufw"}, map[string]string{"ufw status": "ERROR: You need to be root to run this script\n"}, map[string]bool{"ufw status": true})
	if fw := byCheck(collectFastChecks(context.Background(), env), checkFirewall); len(fw) != 1 || fw[0].State != "unknown" || !strings.Contains(fw[0].Reason, "root") {
		t.Fatalf("unreadable ufw: %+v", fw)
	}
	env, _ = fakeEnv("linux", nil, nil, nil)
	if fw := byCheck(collectFastChecks(context.Background(), env), checkFirewall); len(fw) != 1 || fw[0].State != "unknown" {
		t.Fatalf("no firewall tool: %+v", fw)
	}

	// dnf chosen when apt-get is absent; yum only when dnf is absent too.
	env, ran = fakeEnv("linux", []string{"dnf", "yum"}, map[string]string{
		"dnf -q updateinfo list --security": "RHSA-2026:1234 Important/Sec. openssl-libs-1:3.0.7-27.el9.x86_64\n",
	}, nil)
	up = collectUpdateChecks(context.Background(), env)
	if len(up) != 1 || up[0].State != "fail" || *up[0].Count != 1 || len(*ran) != 1 || !strings.HasPrefix((*ran)[0], "dnf ") {
		t.Fatalf("dnf updates: %+v ran=%v", up, *ran)
	}
	env, _ = fakeEnv("linux", []string{"yum"}, map[string]string{"yum -q updateinfo list security": "updateinfo list done\n"}, nil)
	if up = collectUpdateChecks(context.Background(), env); up[0].State != "pass" || up[0].Subject != "YUM" {
		t.Fatalf("yum updates: %+v", up)
	}
}

func TestMacOSCollectorsWithFakeCommands(t *testing.T) {
	env, _ := fakeEnv("darwin", nil, map[string]string{
		socketfilterfw + " --getglobalstate": "Firewall is enabled. (State = 1)\n",
		"pfctl -s info":                      "pfctl: /dev/pf: Permission denied\n",
		"fdesetup status":                    "FileVault is Off.\n",
		"csrutil status":                     "System Integrity Protection status: enabled.\n",
		"spctl --status":                     "assessments enabled\n",
		"softwareupdate -l":                  "Software Update Tool\n\nFinding available software\nNo new software available.\n",
	}, map[string]bool{"pfctl -s info": true})
	ev := collectFastChecks(context.Background(), env)
	want := map[string]string{
		"firewall|Application Firewall":   "pass",
		"firewall|pf packet filter":       "info",
		"disk_encryption|FileVault":       "fail",
		"sip|System Integrity Protection": "pass",
		"gatekeeper|Gatekeeper":           "pass",
	}
	for _, e := range ev {
		k := e.Check + "|" + e.Subject
		if want[k] != e.State {
			t.Errorf("%s: got %s want %s (%+v)", k, e.State, want[k], e)
		}
		delete(want, k)
	}
	if len(want) != 0 {
		t.Fatalf("missing evidence: %v", want)
	}
	up := collectUpdateChecks(context.Background(), env)
	if len(up) != 1 || up[0].State != "pass" || *up[0].Count != 0 {
		t.Fatalf("softwareupdate: %+v", up)
	}
}

func TestApplyEvidenceSummaries(t *testing.T) {
	env := fixedEnv("linux")
	var p SecurityPosture
	ApplyEvidence(&p, nil)
	if p.Checks != nil || p.FirewallEnabled != nil {
		t.Fatal("no evidence leaves the posture empty")
	}
	n := 2
	ev := []Evidence{
		env.ev(checkFirewall, "ufw", "pass", "Status: active", "ufw status", ""),
		env.ev(checkDiskCrypt, "/", "warn", "", "", ""),
		{Check: checkUpdates, Subject: "APT", State: "fail", Count: &n, MeasuredAt: "2026-11-22T11:00:00Z"},
	}
	ApplyEvidence(&p, ev)
	if p.FirewallEnabled == nil || !*p.FirewallEnabled || p.DiskEncrypted == nil || *p.DiskEncrypted || p.PendingUpdates == nil || *p.PendingUpdates != 2 || p.MeasuredAt != "2026-11-22T11:00:00Z" {
		t.Fatalf("summary: %+v", p)
	}
	if p.AntivirusEnabled != nil {
		t.Fatal("antivirus was not measured: it must stay absent, never false")
	}
}

// The API refuses a whole heartbeat when one evidence field is out of bounds, so the agent keeps
// every field inside the schema (subject ≤ 120, source ≤ 200, value/reason ≤ 300, ≤ 64 items).
func TestEvidenceStaysWithinTheAPISchema(t *testing.T) {
	env := fixedEnv("linux")
	long := "/srv/" + strings.Repeat("very-long-mount-name-", 20) + "\x01end"
	e := env.ev(checkDiskCrypt, long, "fail", strings.Repeat("v", 400), strings.Repeat("s", 250), strings.Repeat("r", 400))
	if len(e.Subject) > 120 || len(e.Source) > 200 || len(e.Value) > 300 || len(e.Reason) > 300 || strings.ContainsRune(e.Subject, 1) {
		t.Fatalf("fields not clipped: %d %d %d %d", len(e.Subject), len(e.Source), len(e.Value), len(e.Reason))
	}
	if blank := env.ev(checkFirewall, "  ", "unknown", "", "", ""); blank.Subject == "" || blank.Source == "" {
		t.Fatalf("subject and source are required by the API: %+v", blank)
	}

	var ev []Evidence
	for i := 0; i < 80; i++ {
		ev = append(ev, env.ev(checkDiskCrypt, fmt.Sprintf("/data%02d", i), "pass", "", "lsblk", ""))
	}
	ev[75].State = "fail" // a problem near the end must survive the cap
	capped := capEvidence(ev)
	if len(capped) != MaxEvidenceItems {
		t.Fatalf("capped to %d items", len(capped))
	}
	foundFail := false
	for _, c := range capped {
		foundFail = foundFail || (c.Subject == "/data75" && c.State == "fail")
	}
	last := capped[len(capped)-1]
	if !foundFail || last.State != "unknown" || !strings.Contains(last.Value, "17 more item(s)") || last.MeasuredAt == "" {
		t.Fatalf("cap hid a failure or the overflow note is wrong: fail=%t last=%+v", foundFail, last)
	}
	if got := capEvidence(ev[:10]); len(got) != 10 {
		t.Fatal("small lists are unchanged")
	}
	var p SecurityPosture
	ApplyEvidence(&p, ev)
	if len(p.Checks) != MaxEvidenceItems || p.DiskEncrypted == nil || *p.DiskEncrypted {
		t.Fatalf("summary uses all evidence, the list is capped: %d %+v", len(p.Checks), p.DiskEncrypted)
	}
}

// TestLiveComplianceOnThisMachine runs the real checks of the host OS and prints the evidence.
// Opt-in (the update search can take minutes): NIGAFIY_LIVE_COMPLIANCE=1 [NIGAFIY_LIVE_UPDATES=1] go test (legacy LD_LIVE_* still work) -run Live -v
func TestLiveComplianceOnThisMachine(t *testing.T) {
	if config.Getenv("NIGAFIY_LIVE_COMPLIANCE") != "1" {
		t.Skip("set NIGAFIY_LIVE_COMPLIANCE=1 to run the real compliance commands of this machine")
	}
	env := defaultComplianceEnv()
	ev := collectFastChecks(context.Background(), env)
	if config.Getenv("NIGAFIY_LIVE_UPDATES") == "1" {
		ev = append(ev, collectUpdateChecks(context.Background(), env)...)
	}
	for _, e := range ev {
		t.Logf("%-16s %-30s %-7s value=%q source=%q reason=%q", e.Check, e.Subject, e.State, e.Value, e.Source, e.Reason)
		if e.Source == "" || e.MeasuredAt == "" {
			t.Errorf("evidence without source/time: %+v", e)
		}
	}
	if len(ev) == 0 {
		t.Fatal("no evidence produced")
	}
}
