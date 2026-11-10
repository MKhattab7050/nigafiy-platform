// Package sysinfo collects hardware, health, process, service, software and network connection
// telemetry from the local machine for LAN Detective IT Operations.
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
	"time"
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

type Health struct {
	Hostname      string      `json:"hostname"`
	OS            string      `json:"os"`
	OSVersion     string      `json:"os_version,omitempty"`
	Arch          string      `json:"arch"`
	CPUModel      string      `json:"cpu_model,omitempty"`
	CPUCores      int         `json:"cpu_cores"`
	RAMTotalMB    int         `json:"ram_total_mb"`
	RAMUsedMB     int         `json:"ram_used_mb"`
	RAMPct        float64     `json:"ram_pct"`
	CPUPct        float64     `json:"cpu_pct"`
	DiskUsedPct   float64     `json:"disk_used_pct,omitempty"`
	UptimeSeconds int64       `json:"uptime_seconds"`
	LoggedInUsers []string    `json:"logged_in_users"`
	PrimaryIP     string      `json:"primary_ip,omitempty"`
	PrimaryMAC    string      `json:"primary_mac,omitempty"`
	Disks         []Disk      `json:"disks,omitempty"`
	Interfaces    []Interface `json:"interfaces,omitempty"`
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
		RAMTotalMB:    4096,
		RAMUsedMB:     1024,
		RAMPct:        25.0,
		CPUPct:        5.0,
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
	if len(h.Disks) > 0 {
		maxPct := 0.0
		for _, d := range h.Disks {
			if d.UsedPct > maxPct {
				maxPct = d.UsedPct
			}
		}
		h.DiskUsedPct = maxPct
	}
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

func collectWindowsHealth(ctx context.Context, h *Health) {
	c, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	script := `$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue; ` +
		`$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
		`$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object { @{ mount=$_.DeviceID; fs=$_.FileSystem; total=[math]::Round($_.Size/1GB,1); free=[math]::Round($_.FreeSpace/1GB,1) } }; ` +
		`@{ caption=$os.Caption; total_kb=$os.TotalVisibleMemorySize; free_kb=$os.FreePhysicalMemory; boot=if($os.LastBootUpTime){[int]((Get-Date)-$os.LastBootUpTime).TotalSeconds}else{0}; cpu_name=$cpu.Name; cpu_load=$cpu.LoadPercentage; disks=@($disks) } | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return
	}
	var data struct {
		Caption string  `json:"caption"`
		TotalKB float64 `json:"total_kb"`
		FreeKB  float64 `json:"free_kb"`
		Boot    int64   `json:"boot"`
		CPUName string  `json:"cpu_name"`
		CPULoad float64 `json:"cpu_load"`
		Disks   []struct {
			Mount string  `json:"mount"`
			FS    string  `json:"fs"`
			Total float64 `json:"total"`
			Free  float64 `json:"free"`
		} `json:"disks"`
	}
	if json.Unmarshal(out, &data) != nil {
		return
	}
	if data.Caption != "" {
		h.OSVersion = truncate(data.Caption, 120)
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
	for _, d := range data.Disks {
		if d.Total <= 0 {
			continue
		}
		used := round1(d.Total - d.Free)
		pct := round1(used * 100 / d.Total)
		h.Disks = append(h.Disks, Disk{
			Mount:      truncate(d.Mount, 120),
			Filesystem: truncate(d.FS, 60),
			TotalGB:    d.Total,
			UsedGB:     used,
			FreeGB:     d.Free,
			UsedPct:    pct,
		})
	}
}

func collectUnixHealth(ctx context.Context, h *Health) {
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		var totalKB, availKB int
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				v, _ := strconv.Atoi(fields[1])
				switch fields[0] {
				case "MemTotal:":
					totalKB = v
				case "MemAvailable:":
					availKB = v
				}
			}
		}
		if totalKB > 0 {
			h.RAMTotalMB = totalKB / 1024
			h.RAMUsedMB = (totalKB - availKB) / 1024
			h.RAMPct = round1(float64(h.RAMUsedMB) * 100 / float64(h.RAMTotalMB))
		}
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			if secs, err := strconv.ParseFloat(fields[0], 64); err == nil {
				h.UptimeSeconds = int64(secs)
			}
		}
	}
	c, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(c, "df", "-P", "-k").Output(); err == nil {
		for i, line := range strings.Split(string(out), "\n") {
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
			h.Disks = append(h.Disks, Disk{
				Mount:   truncate(f[5], 120),
				TotalGB: totalGB,
				UsedGB:  usedGB,
				FreeGB:  freeGB,
				UsedPct: round1(usedKB * 100 / totalKB),
			})
		}
	}
}

// CollectInventory gathers processes, services, installed software, and active network connections.
func CollectInventory(ctx context.Context) Inventory {
	h := CollectHealth(ctx, time.Now())
	inv := Inventory{
		Disks:       h.Disks,
		Interfaces:  h.Interfaces,
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

func collectWindowsServices(ctx context.Context) []Service {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	script := `Get-Service | Select-Object -First 250 Name,DisplayName,@{N='State';E={$_.Status.ToString()}},@{N='Start';E={$_.StartType.ToString()}} | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Service{}
	}
	var raw []struct {
		Name        string `json:"Name"`
		DisplayName string `json:"DisplayName"`
		State       string `json:"State"`
		Start       string `json:"Start"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []Service{}
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

func collectUnixServices(ctx context.Context) []Service {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
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

func collectWindowsSoftware(ctx context.Context) []Software {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	script := `Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*,HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object -First 250 DisplayName,DisplayVersion,Publisher,InstallDate | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(c, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Software{}
	}
	var raw []struct {
		DisplayName    string `json:"DisplayName"`
		DisplayVersion string `json:"DisplayVersion"`
		Publisher      string `json:"Publisher"`
		InstallDate    string `json:"InstallDate"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []Software{}
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

// ParseNetstat parses `netstat -ano` output into structured TCP/UDP connections.
func ParseNetstat(output string, procByPID map[int]string) []Connection {
	var list []Connection
	for _, line := range strings.Split(output, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		proto := strings.ToLower(f[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		localAddr, localPort, ok := splitHostPort(f[1])
		if !ok {
			continue
		}
		remoteAddr, remotePort, _ := splitHostPort(f[2])
		state := "LISTEN"
		pidField := f[len(f)-1]
		if proto == "tcp" && len(f) >= 5 {
			state = truncate(f[3], 40)
		}
		pid, _ := strconv.Atoi(pidField)
		conn := Connection{
			Proto:         proto,
			LocalAddress:  truncate(localAddr, 64),
			LocalPort:     localPort,
			RemoteAddress: truncate(remoteAddr, 64),
			RemotePort:    remotePort,
			State:         state,
			PID:           pid,
			ProcessName:   procByPID[pid],
		}
		list = append(list, conn)
		if len(list) >= 250 {
			break
		}
	}
	return list
}

func splitHostPort(s string) (string, int, bool) {
	if s == "*:*" || s == "0.0.0.0:0" || s == "[::]:0" {
		return "", 0, false
	}
	idx := strings.LastIndex(s, ":")
	if idx <= 0 || idx == len(s)-1 {
		return "", 0, false
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
	cmd := exec.CommandContext(c, "netstat", "-ano")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return []Connection{}
	}
	return ParseNetstat(string(out), procByPID)
}

