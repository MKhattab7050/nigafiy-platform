// Package sysinfo collects hardware, health, process, service, software and network connection
// telemetry from the local machine for Nigafiy IT Operations.
package sysinfo

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	healthCacheMu  sync.Mutex
	cachedHealth   Health
	cachedHealthAt time.Time
)

type Disk struct {
	Mount      string  `json:"mount"`
	Filesystem string  `json:"filesystem,omitempty"`
	TotalGB    float64 `json:"total_gb"`
	UsedGB     float64 `json:"used_gb"`
	FreeGB     float64 `json:"free_gb"`
	UsedPct    float64 `json:"used_pct"`
}

type Interface struct {
	Name      string   `json:"name"`
	MAC       string   `json:"mac,omitempty"`
	Addresses []string `json:"addresses"`
}

type Process struct {
	PID     int     `json:"pid"`
	Name    string  `json:"name"`
	CPUPct  float64 `json:"cpu_pct,omitempty"`
	MemMB   float64 `json:"mem_mb"`
	User    string  `json:"user,omitempty"`
	Command string  `json:"command,omitempty"`
}

type Service struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	State       string `json:"state"`
	StartMode   string `json:"start_mode,omitempty"`
}

type Software struct {
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Publisher   string `json:"publisher,omitempty"`
	InstallDate string `json:"install_date,omitempty"`
}

type Connection struct {
	Proto         string `json:"proto"`
	LocalAddress  string `json:"local_address"`
	LocalPort     int    `json:"local_port"`
	RemoteAddress string `json:"remote_address,omitempty"`
	RemotePort    int    `json:"remote_port,omitempty"`
	State         string `json:"state"`
	PID           int    `json:"pid,omitempty"`
	ProcessName   string `json:"process_name,omitempty"`
}

type SecurityPosture struct {
	// Pointers: a value the agent did not measure is left out, never reported as false/0.
	FirewallEnabled  *bool  `json:"firewall_enabled,omitempty"`
	AntivirusEnabled *bool  `json:"antivirus_enabled,omitempty"`
	DiskEncrypted    *bool  `json:"disk_encrypted,omitempty"`
	PendingUpdates   *int   `json:"pending_updates,omitempty"`
	LastUpdateDate   string `json:"last_update_date,omitempty"`
	OSBuild          string `json:"os_build,omitempty"`
	// Checks is the evidence behind the fields above (compliance.go); MeasuredAt is the newest measurement.
	Checks     []Evidence `json:"checks,omitempty"`
	MeasuredAt string     `json:"measured_at,omitempty"`
}

type Health struct {
	Hostname      string          `json:"hostname"`
	OS            string          `json:"os"`
	OSVersion     string          `json:"os_version,omitempty"`
	Arch          string          `json:"arch"`
	Manufacturer  string          `json:"manufacturer,omitempty"`
	Model         string          `json:"model,omitempty"`
	SerialNumber  string          `json:"serial_number,omitempty"`
	CPUModel      string          `json:"cpu_model,omitempty"`
	CPUCores      int             `json:"cpu_cores"`
	RAMTotalMB    int             `json:"ram_total_mb,omitempty"`
	RAMUsedMB     int             `json:"ram_used_mb"`
	RAMPct        float64         `json:"ram_pct"`
	CPUPct        float64         `json:"cpu_pct"`
	DiskUsedPct   float64         `json:"disk_used_pct,omitempty"`
	UptimeSeconds int64           `json:"uptime_seconds"`
	LoggedInUsers []string        `json:"logged_in_users"`
	PrimaryIP     string          `json:"primary_ip,omitempty"`
	PrimaryMAC    string          `json:"primary_mac,omitempty"`
	Disks         []Disk          `json:"disks,omitempty"`
	Interfaces    []Interface     `json:"interfaces,omitempty"`
	Security      SecurityPosture `json:"security,omitempty"`
}

type Inventory struct {
	Disks       []Disk       `json:"disks"`
	Interfaces  []Interface  `json:"interfaces"`
	Processes   []Process    `json:"processes"`
	Services    []Service    `json:"services"`
	Software    []Software   `json:"software"`
	Connections []Connection `json:"connections"`
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max]
	}
	return s
}

// CollectInterfaces reads local network adapters and picks the primary non-loopback IPv4 & MAC.
func CollectInterfaces() (list []Interface, primaryIP string, primaryMAC string) {
	ifs, err := net.Interfaces()
	if err != nil {
		return []Interface{}, "", ""
	}
	for _, iface := range ifs {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil || len(addrs) == 0 {
			continue
		}
		var addrStrs []string
		for _, a := range addrs {
			s := a.String()
			addrStrs = append(addrStrs, s)
			if ipNet, ok := a.(*net.IPNet); ok && ipNet.IP.To4() != nil && !ipNet.IP.IsLoopback() {
				if primaryIP == "" {
					primaryIP = ipNet.IP.String()
					if len(iface.HardwareAddr) == 6 {
						primaryMAC = strings.ToLower(iface.HardwareAddr.String())
					}
				}
			}
		}
		if len(addrStrs) > 0 {
			mac := ""
			if len(iface.HardwareAddr) == 6 {
				mac = strings.ToLower(iface.HardwareAddr.String())
			}
			list = append(list, Interface{
				Name:      truncate(iface.Name, 120),
				MAC:       mac,
				Addresses: addrStrs,
			})
		}
	}
	return list, primaryIP, primaryMAC
}

// CollectHealth gathers a fast snapshot of system health for the heartbeat.
func CollectHealth(ctx context.Context, started time.Time) Health {
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown-host"
	}
	ifs, primaryIP, primaryMAC := CollectInterfaces()
	users := currentUsers()
	h := Health{
		Hostname:      truncate(host, 253),
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		CPUCores:      runtime.NumCPU(),
		UptimeSeconds: int64(time.Since(started).Seconds()),
		LoggedInUsers: users,
		PrimaryIP:     primaryIP,
		PrimaryMAC:    primaryMAC,
		Interfaces:    ifs,
	}

	if runtime.GOOS == "windows" {
		collectWindowsHealth(ctx, &h)
	} else {
		collectUnixHealth(ctx, &h)
	}
	ApplyEvidence(&h.Security, ComplianceEvidence())
	if len(h.Disks) > 0 {
		maxPct := 0.0
		for _, d := range h.Disks {
			if d.UsedPct > maxPct {
				maxPct = d.UsedPct
			}
		}
		h.DiskUsedPct = maxPct
	}
	healthCacheMu.Lock()
	cachedHealth = h
	cachedHealthAt = time.Now()
	healthCacheMu.Unlock()
	return h
}

func currentUsers() []string {
	u, err := user.Current()
	if err == nil && u.Username != "" {
		return []string{truncate(u.Username, 120)}
	}
	if v := os.Getenv("USERNAME"); v != "" {
		return []string{truncate(v, 120)}
	}
	if v := os.Getenv("USER"); v != "" {
		return []string{truncate(v, 120)}
	}
	return []string{}
}

type winDisk struct {
	Mount string  `json:"mount"`
	FS    string  `json:"fs"`
	Total float64 `json:"total"`
	Free  float64 `json:"free"`
}

func parseWinDisks(raw json.RawMessage) []Disk {
	if len(raw) == 0 {
		return nil
	}
	var disks []winDisk
	if json.Unmarshal(raw, &disks) != nil {
		var single winDisk
		if json.Unmarshal(raw, &single) == nil && single.Mount != "" {
			disks = []winDisk{single}
		}
	}
	var out []Disk
	for _, d := range disks {
		if d.Total <= 0 {
			continue
		}
		used := round1(d.Total - d.Free)
		pct := round1(used * 100 / d.Total)
		out = append(out, Disk{
			Mount:      truncate(d.Mount, 120),
			Filesystem: truncate(d.FS, 60),
			TotalGB:    d.Total,
			UsedGB:     used,
			FreeGB:     d.Free,
			UsedPct:    pct,
		})
	}
	return out
}

func collectWindowsHealth(ctx context.Context, h *Health) {
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	script := `$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue; ` +
		`$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue; ` +
		`$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue; ` +
		`$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
		`$ntos = Get-Item "$env:SystemRoot\System32\ntoskrnl.exe" -ErrorAction SilentlyContinue; ` +
		`$disks = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | ForEach-Object { @{ mount=$_.Name.TrimEnd('\'); fs=$_.DriveFormat; total=[math]::Round($_.TotalSize/1GB,1); free=[math]::Round($_.AvailableFreeSpace/1GB,1) } }); ` +
		`@{ caption=$os.Caption; build=$os.BuildNumber; mfg=$cs.Manufacturer; model=$cs.Model; serial=$bios.SerialNumber; total_kb=$os.TotalVisibleMemorySize; free_kb=$os.FreePhysicalMemory; boot=if($os.LastBootUpTime){[int]((Get-Date)-$os.LastBootUpTime).TotalSeconds}else{0}; cpu_name=$cpu.Name; cpu_load=$cpu.LoadPercentage; last_hf=if($ntos){$ntos.LastWriteTime.ToString('yyyy-MM-dd')}else{''}; disks=$disks } | ConvertTo-Json -Depth 4 -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return
	}
	var data struct {
		Caption string          `json:"caption"`
		Build   string          `json:"build"`
		Mfg     string          `json:"mfg"`
		Model   string          `json:"model"`
		Serial  string          `json:"serial"`
		TotalKB float64         `json:"total_kb"`
		FreeKB  float64         `json:"free_kb"`
		Boot    int64           `json:"boot"`
		CPUName string          `json:"cpu_name"`
		CPULoad float64         `json:"cpu_load"`
		LastHF  string          `json:"last_hf"`
		Disks   json.RawMessage `json:"disks"`
	}
	if json.Unmarshal(out, &data) != nil {
		return
	}
	if data.Caption != "" {
		h.OSVersion = truncate(data.Caption, 120)
	}
	if data.Mfg != "" {
		h.Manufacturer = truncate(data.Mfg, 120)
	}
	if data.Model != "" {
		h.Model = truncate(data.Model, 120)
	}
	if data.Serial != "" {
		h.SerialNumber = truncate(data.Serial, 120)
	}
	// Firewall, antivirus, BitLocker and updates are measured with evidence in compliance.go.
	h.Security = SecurityPosture{
		LastUpdateDate: truncate(data.LastHF, 40),
		OSBuild:        truncate(data.Build, 40),
	}
	if data.CPUName != "" {
		h.CPUModel = truncate(data.CPUName, 160)
	}
	if data.TotalKB > 0 {
		totalMB := int(data.TotalKB / 1024)
		usedMB := int((data.TotalKB - data.FreeKB) / 1024)
		if usedMB < 0 {
			usedMB = 0
		}
		h.RAMTotalMB = totalMB
		h.RAMUsedMB = usedMB
		h.RAMPct = round1(float64(usedMB) * 100 / float64(totalMB))
	}
	if data.Boot > 0 {
		h.UptimeSeconds = data.Boot
	}
	h.CPUPct = round1(data.CPULoad)
	h.Disks = parseWinDisks(data.Disks)
}

// ParseLinuxMeminfo extracts total MB, used MB, and usage percentage from /proc/meminfo contents.
func ParseLinuxMeminfo(raw string) (totalMB, usedMB int, pct float64) {
	var totalKB, availKB, freeKB, buffersKB, cachedKB int
	var hasAvail bool
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKB = v
		case "MemAvailable:":
			availKB = v
			hasAvail = true
		case "MemFree:":
			freeKB = v
		case "Buffers:":
			buffersKB = v
		case "Cached:":
			cachedKB = v
		}
	}
	if totalKB <= 0 {
		return 0, 0, 0
	}
	usedKB := totalKB - availKB
	if !hasAvail {
		usedKB = totalKB - freeKB - buffersKB - cachedKB
	}
	if usedKB < 0 {
		usedKB = 0
	}
	totalMB = totalKB / 1024
	usedMB = usedKB / 1024
	if totalMB <= 0 {
		return 0, 0, 0
	}
	return totalMB, usedMB, round1(float64(usedMB) * 100 / float64(totalMB))
}

// ParseLinuxCPUInfo extracts the CPU model string from /proc/cpuinfo contents.
func ParseLinuxCPUInfo(raw string) string {
	var modelName, hardware, processor string
	for _, line := range strings.Split(raw, "\n") {
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:idx]))
		val := strings.TrimSpace(line[idx+1:])
		if val == "" {
			continue
		}
		switch key {
		case "model name", "cpu model", "uarch":
			if modelName == "" {
				modelName = val
			}
		case "hardware":
			if hardware == "" {
				hardware = val
			}
		case "processor":
			// On x86, "processor : 0" is a core index; on ARM, "Processor : ARMv7..." is the model name.
			if processor == "" {
				if _, err := strconv.Atoi(val); err != nil {
					processor = val
				}
			}
		}
	}
	for _, candidate := range []string{modelName, hardware, processor} {
		if candidate != "" {
			return truncate(candidate, 160)
		}
	}
	return ""
}

// ParseOSRelease extracts PRETTY_NAME (or NAME + VERSION) from /etc/os-release contents.
func ParseOSRelease(raw string) string {
	var pretty, name, version string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:idx])
		v := strings.Trim(strings.TrimSpace(line[idx+1:]), `"'`)
		switch k {
		case "PRETTY_NAME":
			pretty = v
		case "NAME":
			name = v
		case "VERSION":
			version = v
		}
	}
	if pretty != "" {
		return truncate(pretty, 120)
	}
	if name != "" {
		return truncate(strings.TrimSpace(name+" "+version), 120)
	}
	return ""
}

// ParseLinuxLoadAvgCPU converts the 1-minute load average in /proc/loadavg into a 0..100 CPU percentage.
func ParseLinuxLoadAvgCPU(raw string, numCPU int) float64 {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return 0
	}
	load1, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || load1 < 0 {
		return 0
	}
	if numCPU <= 0 {
		numCPU = 1
	}
	pct := (load1 / float64(numCPU)) * 100
	if pct > 100 {
		pct = 100
	}
	return round1(pct)
}

// ParseDarwinVMStat computes used RAM in MB and usage percentage from macOS `vm_stat` output.
func ParseDarwinVMStat(raw string, totalMB int) (usedMB int, pct float64) {
	pageSize := int64(4096)
	var active, wired, compressed int64
	for _, line := range strings.Split(raw, "\n") {
		if idx := strings.Index(line, "page size of "); idx >= 0 {
			rest := line[idx+len("page size of "):]
			if f := strings.Fields(rest); len(f) > 0 {
				if ps, err := strconv.ParseInt(f[0], 10, 64); err == nil && ps > 0 {
					pageSize = ps
				}
			}
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSuffix(strings.TrimSpace(parts[1]), ".")
		val, err := strconv.ParseInt(valStr, 10, 64)
		if err != nil || val < 0 {
			continue
		}
		switch key {
		case "Pages active":
			active = val
		case "Pages wired down":
			wired = val
		case "Pages occupied by compressor":
			compressed = val
		}
	}
	usedBytes := (active + wired + compressed) * pageSize
	if usedBytes <= 0 {
		return 0, 0
	}
	usedMB = int(usedBytes / (1024 * 1024))
	if totalMB > 0 {
		if usedMB > totalMB {
			usedMB = totalMB
		}
		pct = round1(float64(usedMB) * 100 / float64(totalMB))
	}
	return usedMB, pct
}

// ParseDarwinBoottime parses `sysctl -n kern.boottime` output (`{ sec = 1700000000, usec = 0 } ...`) into uptime seconds.
func ParseDarwinBoottime(raw string, now time.Time) int64 {
	idx := strings.Index(raw, "sec =")
	if idx < 0 {
		return 0
	}
	rest := strings.TrimSpace(raw[idx+len("sec ="):])
	end := strings.IndexAny(rest, ", }")
	if end > 0 {
		rest = rest[:end]
	}
	sec, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
	if err != nil || sec <= 0 {
		return 0
	}
	up := now.Unix() - sec
	if up < 0 {
		return 0
	}
	return up
}

// ParsePSCPU sums `ps -A -o %cpu` output and normalizes by CPU core count into a 0..100 percentage.
func ParsePSCPU(raw string, numCPU int) float64 {
	var sum float64
	for _, line := range strings.Split(raw, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(f[0], 64)
		if err != nil || v < 0 {
			continue
		}
		sum += v
	}
	if numCPU <= 0 {
		numCPU = 1
	}
	pct := sum / float64(numCPU)
	if pct > 100 {
		pct = 100
	}
	return round1(pct)
}

// ParseDFDisks parses POSIX `df -P -k` output into disk entries.
func ParseDFDisks(raw string) []Disk {
	var disks []Disk
	for i, line := range strings.Split(raw, "\n") {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 6 || strings.HasPrefix(f[0], "tmpfs") || strings.HasPrefix(f[0], "devtmpfs") {
			continue
		}
		totalKB, _ := strconv.ParseFloat(f[1], 64)
		usedKB, _ := strconv.ParseFloat(f[2], 64)
		availKB, _ := strconv.ParseFloat(f[3], 64)
		if totalKB <= 0 {
			continue
		}
		totalGB := round1(totalKB / (1024 * 1024))
		if totalGB <= 0 {
			continue
		}
		usedGB := round1(usedKB / (1024 * 1024))
		freeGB := round1(availKB / (1024 * 1024))
		disks = append(disks, Disk{
			Mount:   truncate(f[5], 120),
			TotalGB: totalGB,
			UsedGB:  usedGB,
			FreeGB:  freeGB,
			UsedPct: round1(usedKB * 100 / totalKB),
		})
	}
	return disks
}

func collectUnixHealth(ctx context.Context, h *Health) {
	if runtime.GOOS == "darwin" {
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		h.Manufacturer = "Apple Inc."
		if out, err := exec.CommandContext(c, "sysctl", "-n", "hw.model").Output(); err == nil {
			if m := truncate(strings.TrimSpace(string(out)), 120); m != "" {
				h.Model = m
			}
		}
		if out, err := exec.CommandContext(c, "sysctl", "-n", "hw.memsize").Output(); err == nil {
			if b, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err == nil && b > 0 {
				h.RAMTotalMB = int(b / (1024 * 1024))
			}
		}
		if out, err := exec.CommandContext(c, "vm_stat").Output(); err == nil {
			h.RAMUsedMB, h.RAMPct = ParseDarwinVMStat(string(out), h.RAMTotalMB)
		}
		if out, err := exec.CommandContext(c, "sysctl", "-n", "kern.boottime").Output(); err == nil {
			if up := ParseDarwinBoottime(string(out), time.Now()); up > 0 {
				h.UptimeSeconds = up
			}
		}
		if out, err := exec.CommandContext(c, "sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
			if cpu := truncate(strings.TrimSpace(string(out)), 160); cpu != "" {
				h.CPUModel = cpu
			}
		}
		if out, err := exec.CommandContext(c, "sw_vers", "-productVersion").Output(); err == nil {
			if ver := truncate(strings.TrimSpace(string(out)), 100); ver != "" {
				h.OSVersion = "macOS " + ver
			}
		}
		if out, err := exec.CommandContext(c, "ps", "-A", "-o", "%cpu").Output(); err == nil {
			h.CPUPct = ParsePSCPU(string(out), runtime.NumCPU())
		}
		h.Disks = collectDisks(ctx)
		return
	}

	// Linux / POSIX via /proc and /sys
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		h.RAMTotalMB, h.RAMUsedMB, h.RAMPct = ParseLinuxMeminfo(string(raw))
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			if secs, err := strconv.ParseFloat(fields[0], 64); err == nil {
				h.UptimeSeconds = int64(secs)
			}
		}
	}
	if raw, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		if cpu := ParseLinuxCPUInfo(string(raw)); cpu != "" {
			h.CPUModel = cpu
		}
	}
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		if osVer := ParseOSRelease(string(raw)); osVer != "" {
			h.OSVersion = osVer
		}
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/sys_vendor"); err == nil {
		if v := truncate(strings.TrimSpace(string(raw)), 120); v != "" {
			h.Manufacturer = v
		}
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
		if m := truncate(strings.TrimSpace(string(raw)), 120); m != "" {
			h.Model = m
		}
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		h.CPUPct = ParseLinuxLoadAvgCPU(string(raw), runtime.NumCPU())
	}
	h.Disks = collectDisks(ctx)
}

func collectDisks(ctx context.Context) []Disk {
	c, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if runtime.GOOS == "windows" {
		script := `@([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | ForEach-Object { @{ mount=$_.Name.TrimEnd('\'); fs=$_.DriveFormat; total=[math]::Round($_.TotalSize/1GB,1); free=[math]::Round($_.AvailableFreeSpace/1GB,1) } }) | ConvertTo-Json -Compress`
		cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
		hideWindow(cmd)
		out, err := cmd.Output()
		if err != nil {
			return []Disk{}
		}
		if disks := parseWinDisks(out); disks != nil {
			return disks
		}
		return []Disk{}
	}
	out, err := exec.CommandContext(c, "df", "-P", "-k").Output()
	if err != nil {
		return []Disk{}
	}
	if disks := ParseDFDisks(string(out)); disks != nil {
		return disks
	}
	return []Disk{}
}

// CollectInventory gathers processes, services, installed software, and active network connections.
func CollectInventory(ctx context.Context) Inventory {
	var disks []Disk
	var ifs []Interface
	healthCacheMu.Lock()
	if !cachedHealthAt.IsZero() && time.Since(cachedHealthAt) < 15*time.Second {
		disks = append([]Disk(nil), cachedHealth.Disks...)
		ifs = append([]Interface(nil), cachedHealth.Interfaces...)
	}
	healthCacheMu.Unlock()
	if disks == nil {
		disks = collectDisks(ctx)
	}
	if ifs == nil {
		ifs, _, _ = CollectInterfaces()
	}
	inv := Inventory{
		Disks:       disks,
		Interfaces:  ifs,
		Processes:   []Process{},
		Services:    []Service{},
		Software:    []Software{},
		Connections: []Connection{},
	}
	if inv.Disks == nil {
		inv.Disks = []Disk{}
	}
	if inv.Interfaces == nil {
		inv.Interfaces = []Interface{}
	}
	procByPID := map[int]string{}
	if runtime.GOOS == "windows" {
		inv.Processes = collectWindowsProcesses(ctx)
		inv.Services = collectWindowsServices(ctx)
		inv.Software = collectWindowsSoftware(ctx)
	} else {
		inv.Processes = collectUnixProcesses(ctx)
		inv.Services = collectUnixServices(ctx)
		inv.Software = collectUnixSoftware(ctx)
	}
	for _, p := range inv.Processes {
		procByPID[p.PID] = p.Name
	}
	inv.Connections = collectConnections(ctx, procByPID)
	return inv
}

// ParseTasklistCSV parses Windows `tasklist /FO CSV /NH` output into top processes by memory.
func ParseTasklistCSV(output string) []Process {
	r := csv.NewReader(strings.NewReader(output))
	records, _ := r.ReadAll()
	var list []Process
	for _, rec := range records {
		if len(rec) < 5 {
			continue
		}
		name := truncate(rec[0], 160)
		pid, err := strconv.Atoi(strings.TrimSpace(rec[1]))
		if err != nil || pid <= 0 || name == "" {
			continue
		}
		memStr := strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, rec[4])
		memKB, _ := strconv.ParseFloat(memStr, 64)
		list = append(list, Process{
			PID:   pid,
			Name:  name,
			MemMB: round1(memKB / 1024),
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].MemMB > list[j].MemMB })
	if len(list) > 150 {
		list = list[:150]
	}
	return list
}

func collectWindowsProcesses(ctx context.Context) []Process {
	c, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, "tasklist", "/FO", "CSV", "/NH")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Process{}
	}
	return ParseTasklistCSV(string(out))
}

func collectUnixProcesses(ctx context.Context) []Process {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(c, "ps", "-eo", "pid,pcpu,rss,user,comm").Output()
	if err != nil {
		return []Process{}
	}
	var list []Process
	for i, line := range strings.Split(string(out), "\n") {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil || pid <= 0 {
			continue
		}
		cpu, _ := strconv.ParseFloat(f[1], 64)
		rssKB, _ := strconv.ParseFloat(f[2], 64)
		list = append(list, Process{
			PID:    pid,
			Name:   truncate(strings.Join(f[4:], " "), 160),
			CPUPct: round1(cpu),
			MemMB:  round1(rssKB / 1024),
			User:   truncate(f[3], 120),
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].MemMB > list[j].MemMB })
	if len(list) > 150 {
		list = list[:150]
	}
	return list
}

type winService struct {
	Name        string `json:"Name"`
	DisplayName string `json:"DisplayName"`
	State       string `json:"State"`
	Start       string `json:"Start"`
}

func parseWinServices(out []byte) []Service {
	var raw []winService
	if json.Unmarshal(out, &raw) != nil {
		var single winService
		if json.Unmarshal(out, &single) == nil && single.Name != "" {
			raw = []winService{single}
		} else {
			return []Service{}
		}
	}
	var list []Service
	for _, s := range raw {
		if s.Name == "" {
			continue
		}
		state := "other"
		switch strings.ToLower(s.State) {
		case "running":
			state = "running"
		case "stopped":
			state = "stopped"
		}
		mode := "other"
		switch strings.ToLower(s.Start) {
		case "automatic":
			mode = "auto"
		case "manual":
			mode = "manual"
		case "disabled":
			mode = "disabled"
		}
		disp := s.DisplayName
		if disp == "" {
			disp = s.Name
		}
		list = append(list, Service{
			Name:        truncate(s.Name, 160),
			DisplayName: truncate(disp, 240),
			State:       state,
			StartMode:   mode,
		})
	}
	return list
}

func collectWindowsServices(ctx context.Context) []Service {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	script := `@(Get-Service | Select-Object -First 250 Name,DisplayName,@{N='State';E={$_.Status.ToString()}},@{N='Start';E={$_.StartType.ToString()}}) | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Service{}
	}
	return parseWinServices(out)
}

func collectUnixServices(ctx context.Context) []Service {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		out, err := exec.CommandContext(c, "launchctl", "list").Output()
		if err != nil {
			return []Service{}
		}
		var list []Service
		for i, line := range strings.Split(string(out), "\n") {
			if i == 0 {
				continue
			}
			f := strings.Fields(line)
			if len(f) < 3 {
				continue
			}
			state := "stopped"
			if f[0] != "-" {
				state = "running"
			}
			name := truncate(f[2], 160)
			list = append(list, Service{
				Name:        name,
				DisplayName: name,
				State:       state,
			})
			if len(list) >= 250 {
				break
			}
		}
		return list
	}
	out, err := exec.CommandContext(c, "systemctl", "list-units", "--type=service", "--all", "--no-pager", "--no-legend").Output()
	if err != nil {
		return []Service{}
	}
	var list []Service
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "●"))
		if len(f) < 4 {
			continue
		}
		name := strings.TrimSuffix(f[0], ".service")
		sub := strings.ToLower(f[3])
		state := "other"
		if sub == "running" {
			state = "running"
		} else if sub == "dead" || sub == "exited" || sub == "failed" {
			state = "stopped"
		}
		disp := name
		if len(f) > 4 {
			disp = strings.Join(f[4:], " ")
		}
		list = append(list, Service{
			Name:        truncate(name, 160),
			DisplayName: truncate(disp, 240),
			State:       state,
		})
		if len(list) >= 250 {
			break
		}
	}
	return list
}

func collectUnixSoftware(ctx context.Context) []Software {
	c, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	var list []Software
	if runtime.GOOS == "darwin" {
		entries, err := os.ReadDir("/Applications")
		if err == nil {
			for _, e := range entries {
				if strings.HasSuffix(e.Name(), ".app") {
					list = append(list, Software{
						Name:      truncate(strings.TrimSuffix(e.Name(), ".app"), 200),
						Publisher: "macOS Application Bundle",
					})
				}
			}
		}
		if out, err := exec.CommandContext(c, "brew", "list", "--versions").Output(); err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				f := strings.Fields(line)
				if len(f) >= 2 {
					list = append(list, Software{
						Name:      truncate(f[0], 200),
						Version:   truncate(f[1], 80),
						Publisher: "Homebrew",
					})
				}
			}
		}
		return list
	}
	// Linux dpkg or rpm
	if out, err := exec.CommandContext(c, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\n").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) >= 2 && parts[0] != "" {
				pub := ""
				if len(parts) >= 3 {
					pub = truncate(parts[2], 160)
				}
				list = append(list, Software{
					Name:      truncate(parts[0], 200),
					Version:   truncate(parts[1], 100),
					Publisher: pub,
				})
				if len(list) >= 250 {
					break
				}
			}
		}
		return list
	}
	if out, err := exec.CommandContext(c, "rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}\t%{VENDOR}\n").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) >= 2 && parts[0] != "" {
				pub := ""
				if len(parts) >= 3 {
					pub = truncate(parts[2], 160)
				}
				list = append(list, Software{
					Name:      truncate(parts[0], 200),
					Version:   truncate(parts[1], 100),
					Publisher: pub,
				})
				if len(list) >= 250 {
					break
				}
			}
		}
	}
	return list
}

type winSoftware struct {
	DisplayName    string `json:"DisplayName"`
	DisplayVersion string `json:"DisplayVersion"`
	Publisher      string `json:"Publisher"`
	InstallDate    string `json:"InstallDate"`
}

func parseWinSoftware(out []byte) []Software {
	var raw []winSoftware
	if json.Unmarshal(out, &raw) != nil {
		var single winSoftware
		if json.Unmarshal(out, &single) == nil && single.DisplayName != "" {
			raw = []winSoftware{single}
		} else {
			return []Software{}
		}
	}
	seen := map[string]bool{}
	var list []Software
	for _, sw := range raw {
		name := truncate(sw.DisplayName, 240)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		list = append(list, Software{
			Name:        name,
			Version:     truncate(sw.DisplayVersion, 120),
			Publisher:   truncate(sw.Publisher, 160),
			InstallDate: truncate(sw.InstallDate, 40),
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

func collectWindowsSoftware(ctx context.Context) []Software {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	script := `@(Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*,HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object -First 250 DisplayName,DisplayVersion,Publisher,InstallDate) | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Software{}
	}
	return parseWinSoftware(out)
}

// ParseNetstat parses `netstat -ano` or `netstat -tunap` / `netstat -anv` output into structured TCP/UDP connections.
func ParseNetstat(output string, procByPID map[int]string) []Connection {
	var list []Connection
	for _, line := range strings.Split(output, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		proto := strings.ToLower(f[0])
		if strings.HasPrefix(proto, "tcp") {
			proto = "tcp"
		} else if strings.HasPrefix(proto, "udp") {
			proto = "udp"
		} else {
			continue
		}
		addrIdx := 1
		// Linux/BSD netstat includes Recv-Q and Send-Q columns before Local Address.
		if len(f) >= 6 {
			if _, err1 := strconv.Atoi(f[1]); err1 == nil {
				if _, err2 := strconv.Atoi(f[2]); err2 == nil {
					addrIdx = 3
				}
			}
		}
		if len(f) <= addrIdx+1 {
			continue
		}
		localAddr, localPort, ok := splitHostPort(f[addrIdx])
		if !ok {
			continue
		}
		remoteAddr, remotePort, _ := splitHostPort(f[addrIdx+1])
		state := "LISTEN"
		pidField := f[len(f)-1]
		if proto == "tcp" && len(f) >= addrIdx+4 {
			state = truncate(f[addrIdx+2], 40)
		}
		pid := 0
		procName := ""
		if slash := strings.IndexByte(pidField, '/'); slash > 0 {
			pid, _ = strconv.Atoi(pidField[:slash])
			procName = truncate(pidField[slash+1:], 160)
		} else {
			pid, _ = strconv.Atoi(pidField)
		}
		if procName == "" && pid > 0 {
			procName = procByPID[pid]
		}
		conn := Connection{
			Proto:         proto,
			LocalAddress:  truncate(localAddr, 64),
			LocalPort:     localPort,
			RemoteAddress: truncate(remoteAddr, 64),
			RemotePort:    remotePort,
			State:         state,
			PID:           pid,
			ProcessName:   procName,
		}
		list = append(list, conn)
		if len(list) >= 250 {
			break
		}
	}
	return list
}

// ParseLinuxSS parses `ss -tunap` output into structured TCP/UDP connections.
func ParseLinuxSS(output string, procByPID map[int]string) []Connection {
	var list []Connection
	for _, line := range strings.Split(output, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		proto := strings.ToLower(f[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		state := truncate(f[1], 40)
		if proto == "udp" && state == "UNCONN" {
			state = "LISTEN"
		}
		localAddr, localPort, ok := splitHostPort(f[4])
		if !ok {
			continue
		}
		remoteAddr, remotePort := "", 0
		if len(f) >= 6 {
			remoteAddr, remotePort, _ = splitHostPort(f[5])
		}
		pid := 0
		procName := ""
		if len(f) >= 7 {
			rest := strings.Join(f[6:], " ")
			if idx := strings.Index(rest, "pid="); idx >= 0 {
				sub := rest[idx+4:]
				if end := strings.IndexAny(sub, ",)"); end > 0 {
					pid, _ = strconv.Atoi(sub[:end])
				}
			}
			if q1 := strings.IndexByte(rest, '"'); q1 >= 0 {
				if q2 := strings.IndexByte(rest[q1+1:], '"'); q2 > 0 {
					procName = truncate(rest[q1+1:q1+1+q2], 160)
				}
			}
		}
		if procName == "" && pid > 0 {
			procName = procByPID[pid]
		}
		list = append(list, Connection{
			Proto:         proto,
			LocalAddress:  truncate(localAddr, 64),
			LocalPort:     localPort,
			RemoteAddress: truncate(remoteAddr, 64),
			RemotePort:    remotePort,
			State:         state,
			PID:           pid,
			ProcessName:   procName,
		})
		if len(list) >= 250 {
			break
		}
	}
	return list
}

// ParseLsofConnections parses macOS/POSIX `lsof -iTCP -iUDP -n -P` output into structured connections.
func ParseLsofConnections(output string, procByPID map[int]string) []Connection {
	var list []Connection
	for i, line := range strings.Split(output, "\n") {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 9 {
			continue
		}
		procName := truncate(f[0], 160)
		pid, _ := strconv.Atoi(f[1])
		if p := procByPID[pid]; p != "" {
			procName = p
		}
		proto := ""
		nameIdx := -1
		for idx := 7; idx < len(f); idx++ {
			low := strings.ToLower(f[idx])
			if low == "tcp" || low == "udp" {
				proto = low
				nameIdx = idx + 1
				break
			}
		}
		if proto == "" || nameIdx < 0 || nameIdx >= len(f) {
			continue
		}
		addrSpec := f[nameIdx]
		state := "LISTEN"
		if len(f) > nameIdx+1 {
			st := strings.Trim(f[nameIdx+1], "()")
			if st != "" {
				state = truncate(st, 40)
			}
		}
		localPart := addrSpec
		remotePart := ""
		if arrow := strings.Index(addrSpec, "->"); arrow > 0 {
			localPart = addrSpec[:arrow]
			remotePart = addrSpec[arrow+2:]
		}
		localAddr, localPort, ok := splitHostPort(localPart)
		if !ok {
			continue
		}
		remoteAddr, remotePort, _ := splitHostPort(remotePart)
		list = append(list, Connection{
			Proto:         proto,
			LocalAddress:  truncate(localAddr, 64),
			LocalPort:     localPort,
			RemoteAddress: truncate(remoteAddr, 64),
			RemotePort:    remotePort,
			State:         state,
			PID:           pid,
			ProcessName:   procName,
		})
		if len(list) >= 250 {
			break
		}
	}
	return list
}

func splitHostPort(s string) (string, int, bool) {
	if s == "" || s == "*:*" || s == "*.*" || s == "0.0.0.0:0" || s == "[::]:0" || s == "0.0.0.0:*" || s == "[::]:*" {
		return "", 0, false
	}
	idx := strings.LastIndex(s, ":")
	if idx <= 0 || idx == len(s)-1 {
		// BSD netstat uses a dot before port (e.g. 192.168.1.25.443 or *.22).
		idx = strings.LastIndex(s, ".")
		if idx <= 0 || idx == len(s)-1 {
			return "", 0, false
		}
	}
	port, err := strconv.Atoi(s[idx+1:])
	if err != nil || port < 0 || port > 65535 {
		return "", 0, false
	}
	return s[:idx], port, true
}

func collectConnections(ctx context.Context, procByPID map[int]string) []Connection {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch runtime.GOOS {
	case "linux":
		if out, err := exec.CommandContext(c, "ss", "-tunap").Output(); err == nil {
			if conns := ParseLinuxSS(string(out), procByPID); len(conns) > 0 {
				return conns
			}
		}
		if out, err := exec.CommandContext(c, "netstat", "-tunap").Output(); err == nil {
			return ParseNetstat(string(out), procByPID)
		}
	case "darwin":
		if out, err := exec.CommandContext(c, "lsof", "-iTCP", "-iUDP", "-n", "-P").Output(); err == nil {
			if conns := ParseLsofConnections(string(out), procByPID); len(conns) > 0 {
				return conns
			}
		}
		if out, err := exec.CommandContext(c, "netstat", "-anv").Output(); err == nil {
			return ParseNetstat(string(out), procByPID)
		}
	}
	cmd := exec.CommandContext(c, "netstat", "-ano")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Connection{}
	}
	return ParseNetstat(string(out), procByPID)
}
