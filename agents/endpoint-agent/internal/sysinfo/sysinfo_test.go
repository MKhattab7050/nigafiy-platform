package sysinfo

import (
	"testing"
	"time"
)

func TestParseTasklistCSV(t *testing.T) {
	sample := `"System Idle Process","0","Services","0","8 K"` + "\n" +
		`"svchost.exe","1240","Services","0","45,120 K"` + "\n" +
		`"chrome.exe","8812","Console","1","312,400 K"` + "\n"
	got := ParseTasklistCSV(sample)
	if len(got) != 2 {
		t.Fatalf("expected 2 processes, got %d: %+v", len(got), got)
	}
	if got[0].Name != "chrome.exe" || got[0].PID != 8812 || got[0].MemMB < 300 {
		t.Fatalf("unexpected first process: %+v", got[0])
	}
}

func TestParseNetstat(t *testing.T) {
	sample := `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    192.168.1.25:51422     93.184.216.34:443      ESTABLISHED     8812
  UDP    0.0.0.0:5353           *:*                                    1240
`
	procs := map[int]string{4: "System", 8812: "chrome.exe", 1240: "svchost.exe"}
	got := ParseNetstat(sample, procs)
	if len(got) != 3 {
		t.Fatalf("expected 3 connections, got %d: %+v", len(got), got)
	}
	if got[1].LocalPort != 51422 || got[1].RemoteAddress != "93.184.216.34" || got[1].RemotePort != 443 || got[1].ProcessName != "chrome.exe" {
		t.Fatalf("unexpected TCP connection: %+v", got[1])
	}
}

func TestParseLinuxMeminfo(t *testing.T) {
	sample := `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:   12288000 kB
Buffers:          512000 kB
Cached:          4096000 kB
`
	totalMB, usedMB, pct := ParseLinuxMeminfo(sample)
	if totalMB != 16000 || usedMB != 4000 || pct != 25.0 {
		t.Fatalf("unexpected meminfo parse: total=%d used=%d pct=%v", totalMB, usedMB, pct)
	}

	// Fallback when MemAvailable is absent (older kernels)
	legacy := `MemTotal:        8192000 kB
MemFree:         1024000 kB
Buffers:         1024000 kB
Cached:          2048000 kB
`
	totalMB, usedMB, pct = ParseLinuxMeminfo(legacy)
	if totalMB != 8000 || usedMB != 4000 || pct != 50.0 {
		t.Fatalf("unexpected legacy meminfo parse: total=%d used=%d pct=%v", totalMB, usedMB, pct)
	}

	if total, used, p := ParseLinuxMeminfo(""); total != 0 || used != 0 || p != 0 {
		t.Fatalf("empty meminfo should return zeros, got %d %d %v", total, used, p)
	}
}

func TestParseLinuxCPUInfo(t *testing.T) {
	x86 := `processor	: 0
vendor_id	: GenuineIntel
model name	: Intel(R) Core(TM) i7-12700K
cpu MHz		: 3600.000
`
	if got := ParseLinuxCPUInfo(x86); got != "Intel(R) Core(TM) i7-12700K" {
		t.Fatalf("unexpected x86 CPU model: %q", got)
	}

	arm := `processor	: 0
Processor	: ARMv7 Processor rev 4 (v7l)
Hardware	: BCM2835
`
	if got := ParseLinuxCPUInfo(arm); got != "BCM2835" {
		t.Fatalf("unexpected ARM CPU hardware: %q", got)
	}
}

func TestParseOSRelease(t *testing.T) {
	ubuntu := `NAME="Ubuntu"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
PRETTY_NAME="Ubuntu 24.04.1 LTS"
`
	if got := ParseOSRelease(ubuntu); got != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("unexpected PRETTY_NAME: %q", got)
	}

	fallback := `NAME="Alpine Linux"
VERSION="3.20.2"
`
	if got := ParseOSRelease(fallback); got != "Alpine Linux 3.20.2" {
		t.Fatalf("unexpected fallback OS name: %q", got)
	}
}

func TestParseLinuxLoadAvgCPU(t *testing.T) {
	if got := ParseLinuxLoadAvgCPU("2.00 1.50 1.20 2/412 9812", 8); got != 25.0 {
		t.Fatalf("expected 25.0%%, got %v", got)
	}
	if got := ParseLinuxLoadAvgCPU("12.00 8.00 4.00 5/500 100", 4); got != 100.0 {
		t.Fatalf("expected capped 100.0%%, got %v", got)
	}
}

func TestParseDarwinVMStat(t *testing.T) {
	// Apple Silicon 16384-byte page size:
	// 131072 active + 65536 wired + 65536 compressed = 262144 pages * 16384 = 4096 MB used out of 16384 MB (25%)
	sample := `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              400000.
Pages active:                            131072.
Pages inactive:                          120000.
Pages speculative:                        10000.
Pages throttled:                              0.
Pages wired down:                         65536.
Pages purgeable:                           4096.
Pages occupied by compressor:             65536.
`
	usedMB, pct := ParseDarwinVMStat(sample, 16384)
	if usedMB != 4096 || pct != 25.0 {
		t.Fatalf("unexpected darwin vm_stat: usedMB=%d pct=%v", usedMB, pct)
	}
}

func TestParseDarwinBoottime(t *testing.T) {
	now := time.Unix(1700003600, 0)
	raw := `{ sec = 1700000000, usec = 543210 } Tue Nov 14 22:13:20 2023`
	if up := ParseDarwinBoottime(raw, now); up != 3600 {
		t.Fatalf("expected uptime 3600s, got %d", up)
	}
}

func TestParsePSCPU(t *testing.T) {
	raw := `%CPU
  0.0
 40.0
 60.0
`
	if got := ParsePSCPU(raw, 4); got != 25.0 {
		t.Fatalf("expected 25.0%%, got %v", got)
	}
}

func TestParseDFDisks(t *testing.T) {
	raw := `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        104857600  26214400  78643200      25% /
tmpfs              8388608         0   8388608       0% /dev/shm
`
	disks := ParseDFDisks(raw)
	if len(disks) != 1 || disks[0].Mount != "/" || disks[0].TotalGB != 100.0 || disks[0].UsedPct != 25.0 {
		t.Fatalf("unexpected df disks: %+v", disks)
	}
}

func TestParseWinSingleObjectAndConnections(t *testing.T) {
	svcs := parseWinServices([]byte(`{"Name":"Spooler","DisplayName":"Print Spooler","State":"Running","Start":"Automatic"}`))
	if len(svcs) != 1 || svcs[0].Name != "Spooler" || svcs[0].State != "running" || svcs[0].StartMode != "auto" {
		t.Fatalf("unexpected single service parse: %+v", svcs)
	}
	sw := parseWinSoftware([]byte(`{"DisplayName":"7-Zip","DisplayVersion":"24.08","Publisher":"Igor Pavlov","InstallDate":"20260101"}`))
	if len(sw) != 1 || sw[0].Name != "7-Zip" || sw[0].Version != "24.08" {
		t.Fatalf("unexpected single software parse: %+v", sw)
	}

	ssOut := "Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n" +
		"tcp   LISTEN 0      128    0.0.0.0:22         0.0.0.0:*         users:((\"sshd\",pid=1234,fd=3))\n" +
		"tcp   ESTAB  0      0      192.168.1.10:51000 93.184.216.34:443 users:((\"curl\",pid=5678,fd=4))\n"
	ssConns := ParseLinuxSS(ssOut, nil)
	if len(ssConns) != 2 || ssConns[0].LocalPort != 22 || ssConns[0].ProcessName != "sshd" || ssConns[1].RemotePort != 443 || ssConns[1].PID != 5678 {
		t.Fatalf("unexpected ss connections: %+v", ssConns)
	}

	lsofOut := "COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n" +
		"Safari  1234 user  15u  IPv4 0x01   0t0      TCP 192.168.1.25:51422->93.184.216.34:443 (ESTABLISHED)\n" +
		"mDNS     201 root   8u  IPv4 0x02   0t0      UDP *:5353\n"
	lsofConns := ParseLsofConnections(lsofOut, nil)
	if len(lsofConns) != 2 || lsofConns[0].RemotePort != 443 || lsofConns[0].State != "ESTABLISHED" || lsofConns[1].LocalPort != 5353 {
		t.Fatalf("unexpected lsof connections: %+v", lsofConns)
	}
}


