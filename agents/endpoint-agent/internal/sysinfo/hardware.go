package sysinfo

// Hardware and licence inventory (Fleet Pro): CPU, memory modules, system / board / BIOS and serial
// numbers, licences seen (Windows activation state and edition, Office when its licensing service
// reports it), physical disks with their health and reliability counters, batteries (design vs
// full-charge capacity, cycle count). Every part the agent could not measure is listed in
// Unmeasured with the reason, never filled with a guess. Product keys are never read: the Windows
// licensing query asks only for the name, description and status properties.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type HWCPU struct {
	Name         string `json:"name"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Cores        int    `json:"cores,omitempty"`
	Threads      int    `json:"threads,omitempty"`
	MaxMHz       int    `json:"max_mhz,omitempty"`
	Socket       string `json:"socket,omitempty"`
}

type HWMemoryModule struct {
	Slot         string `json:"slot,omitempty"`
	CapacityMB   int    `json:"capacity_mb"`
	SpeedMHz     int    `json:"speed_mhz,omitempty"`
	Type         string `json:"type,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	PartNumber   string `json:"part_number,omitempty"`
}

type HWSystem struct {
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	Serial       string `json:"serial,omitempty"`
	SKU          string `json:"sku,omitempty"`
}

type HWBoard struct {
	Manufacturer string `json:"manufacturer,omitempty"`
	Product      string `json:"product,omitempty"`
	Version      string `json:"version,omitempty"`
	Serial       string `json:"serial,omitempty"`
}

type HWBIOS struct {
	Vendor      string `json:"vendor,omitempty"`
	Version     string `json:"version,omitempty"`
	ReleaseDate string `json:"release_date,omitempty"`
}

// HWLicence: a licence the operating system reports. Status is one of licensed, unlicensed,
// grace, notification, not_genuine, unknown; Detail is the licensing service's own text.
type HWLicence struct {
	Kind    string `json:"kind"` // windows | office
	Product string `json:"product"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
	Source  string `json:"source"`
}

type HWPhysicalDisk struct {
	Name         string  `json:"name"`
	Model        string  `json:"model,omitempty"`
	Serial       string  `json:"serial,omitempty"`
	MediaType    string  `json:"media_type,omitempty"` // SSD | HDD | SCM | unspecified
	Bus          string  `json:"bus,omitempty"`
	SizeGB       float64 `json:"size_gb,omitempty"`
	Health       string  `json:"health,omitempty"` // healthy | warning | unhealthy | unknown
	Operational  string  `json:"operational,omitempty"`
	TemperatureC *int    `json:"temperature_c,omitempty"`
	WearPct      *int    `json:"wear_pct,omitempty"`
	PowerOnHours *int    `json:"power_on_hours,omitempty"`
	ReadErrors   *int64  `json:"read_errors_uncorrected,omitempty"`
	WriteErrors  *int64  `json:"write_errors_uncorrected,omitempty"`
	Reliability  string  `json:"reliability_note,omitempty"`
	Source       string  `json:"source"`
}

type HWBattery struct {
	Name                  string   `json:"name"`
	DesignCapacityMWh     *int     `json:"design_capacity_mwh,omitempty"`
	FullChargeCapacityMWh *int     `json:"full_charge_capacity_mwh,omitempty"`
	HealthPct             *float64 `json:"health_pct,omitempty"`
	CycleCount            *int     `json:"cycle_count,omitempty"`
	ChargePct             *int     `json:"charge_pct,omitempty"`
	Status                string   `json:"status,omitempty"`
	Source                string   `json:"source"`
}

// Hardware is what POST /agent/hardware carries.
type Hardware struct {
	CollectedAt   string           `json:"collected_at"`
	CPUs          []HWCPU          `json:"cpus"`
	MemoryModules []HWMemoryModule `json:"memory_modules"`
	System        HWSystem         `json:"system"`
	Board         HWBoard          `json:"board"`
	BIOS          HWBIOS           `json:"bios"`
	Licences      []HWLicence      `json:"licences"`
	PhysicalDisks []HWPhysicalDisk `json:"physical_disks"`
	Batteries     []HWBattery      `json:"batteries"`
	// Unmeasured: part → why it is not measured (memory_modules, licences, physical_disks,
	// disk_reliability, batteries, board, bios, system).
	Unmeasured map[string]string `json:"unmeasured"`
}

func newHardware(now time.Time) Hardware {
	return Hardware{
		CollectedAt:   now.UTC().Format(time.RFC3339),
		CPUs:          []HWCPU{},
		MemoryModules: []HWMemoryModule{},
		Licences:      []HWLicence{},
		PhysicalDisks: []HWPhysicalDisk{},
		Batteries:     []HWBattery{},
		Unmeasured:    map[string]string{},
	}
}

// CollectHardware measures the hardware inventory of this computer (slow: run it rarely).
func CollectHardware(ctx context.Context) Hardware {
	env := defaultComplianceEnv()
	switch runtime.GOOS {
	case "windows":
		return collectWindowsHardware(ctx, env)
	case "linux":
		return collectLinuxHardware(ctx, env, "/")
	case "darwin":
		return collectDarwinHardware(ctx, env)
	}
	h := newHardware(time.Now())
	h.Unmeasured["system"] = "unsupported operating system " + runtime.GOOS
	return h
}

func (h *Hardware) note(part, why string) {
	if _, ok := h.Unmeasured[part]; !ok {
		h.Unmeasured[part] = clip(why, 300)
	}
}

func intP(v int) *int         { return &v }
func i64P(v int64) *int64     { return &v }
func f64P(v float64) *float64 { return &v }

// BatteryHealth: full-charge capacity as a percentage of the design capacity (one decimal).
func BatteryHealth(design, full int) *float64 {
	if design <= 0 || full <= 0 {
		return nil
	}
	return f64P(math.Round(float64(full)*1000/float64(design)) / 10)
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

// Licensing: -Property limits what CIM returns, so the partial product key is never fetched.
const windowsHardwareScript = `$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$r.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$r.cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { @{ name = [string]$_.Name; mfg = [string]$_.Manufacturer; cores = [int]$_.NumberOfCores; threads = [int]$_.NumberOfLogicalProcessors; mhz = [int]$_.MaxClockSpeed; socket = [string]$_.SocketDesignation } })
try { $r.mem = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object { @{ slot = [string]$_.DeviceLocator; bank = [string]$_.BankLabel; cap = [int64]$_.Capacity; speed = [int]$_.ConfiguredClockSpeed; speed2 = [int]$_.Speed; type = [int]$_.SMBIOSMemoryType; mfg = [string]$_.Manufacturer; part = [string]$_.PartNumber } }) } catch { $r.mem_error = $_.Exception.Message }
$cs = Get-CimInstance Win32_ComputerSystem
$csp = Get-CimInstance Win32_ComputerSystemProduct
$bios = Get-CimInstance Win32_BIOS
$bb = Get-CimInstance Win32_BaseBoard
$r.sys = @{ mfg = [string]$cs.Manufacturer; model = [string]$cs.Model; sku = [string]$cs.SystemSKUNumber; serial = [string]$bios.SerialNumber; uuid_serial = [string]$csp.IdentifyingNumber }
$r.board = @{ mfg = [string]$bb.Manufacturer; product = [string]$bb.Product; version = [string]$bb.Version; serial = [string]$bb.SerialNumber }
$r.bios = @{ vendor = [string]$bios.Manufacturer; version = [string]$bios.SMBIOSBIOSVersion; date = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { '' } }
try {
  $r.lic = @(Get-CimInstance -ClassName SoftwareLicensingProduct -Filter "LicenseStatus<>0 AND (ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' OR ApplicationID='0ff1ce15-a989-479d-af46-f275c6370663')" -Property Name,Description,LicenseStatus,ApplicationID -ErrorAction Stop | ForEach-Object { @{ name = [string]$_.Name; desc = [string]$_.Description; status = [int]$_.LicenseStatus; app = [string]$_.ApplicationID } })
  $r.lic_ok = $true
} catch { $r.lic_error = $_.Exception.Message }
$r.edition = [string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID).EditionID
$c2r = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -Name ProductReleaseIds
if ($c2r) { $r.office_c2r = [string]$c2r.ProductReleaseIds }
try {
  $r.pd = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    $d = $_
    $o = @{ id = [string]$d.DeviceId; name = [string]$d.FriendlyName; serial = ([string]$d.SerialNumber).Trim(); media = [string]$d.MediaType; bus = [string]$d.BusType; size = [int64]$d.Size; health = [string]$d.HealthStatus; op = ([string[]]$d.OperationalStatus) -join ', ' }
    try {
      $c = $d | Get-StorageReliabilityCounter -ErrorAction Stop
      $o.rel = @{ temp = $c.Temperature; wear = $c.Wear; poh = $c.PowerOnHours; rerr = $c.ReadErrorsUncorrected; werr = $c.WriteErrorsUncorrected }
    } catch { $o.rel_error = $_.Exception.Message }
    $o
  })
} catch { $r.pd_error = $_.Exception.Message }
$bat = @(Get-CimInstance Win32_Battery)
$r.bat = @($bat | ForEach-Object { @{ name = [string]$_.Name; id = [string]$_.DeviceID; charge = [int]$_.EstimatedChargeRemaining; status = [int]$_.BatteryStatus } })
if ($bat.Count -gt 0) {
  try { $r.bat_design = @(Get-CimInstance -Namespace root/WMI -ClassName BatteryStaticData -ErrorAction Stop | ForEach-Object { [int64]$_.DesignedCapacity }) } catch { $r.bat_error = $_.Exception.Message }
  try { $r.bat_full = @(Get-CimInstance -Namespace root/WMI -ClassName BatteryFullChargedCapacity -ErrorAction Stop | ForEach-Object { [int64]$_.FullChargedCapacity }) } catch { $r.bat_error = $_.Exception.Message }
  try { $r.bat_cycles = @(Get-CimInstance -Namespace root/WMI -ClassName BatteryCycleCount -ErrorAction Stop | ForEach-Object { [int64]$_.CycleCount }) } catch {}
}
$r | ConvertTo-Json -Depth 6 -Compress`

type winHardwareReport struct {
	Elevated bool `json:"elevated"`
	CPU      []struct {
		Name    string `json:"name"`
		Mfg     string `json:"mfg"`
		Cores   int    `json:"cores"`
		Threads int    `json:"threads"`
		MHz     int    `json:"mhz"`
		Socket  string `json:"socket"`
	} `json:"cpu"`
	Mem []struct {
		Slot   string `json:"slot"`
		Bank   string `json:"bank"`
		Cap    int64  `json:"cap"`
		Speed  int    `json:"speed"`
		Speed2 int    `json:"speed2"`
		Type   int    `json:"type"`
		Mfg    string `json:"mfg"`
		Part   string `json:"part"`
	} `json:"mem"`
	MemError string `json:"mem_error"`
	Sys      struct {
		Mfg        string `json:"mfg"`
		Model      string `json:"model"`
		SKU        string `json:"sku"`
		Serial     string `json:"serial"`
		UUIDSerial string `json:"uuid_serial"`
	} `json:"sys"`
	Board struct {
		Mfg     string `json:"mfg"`
		Product string `json:"product"`
		Version string `json:"version"`
		Serial  string `json:"serial"`
	} `json:"board"`
	BIOS struct {
		Vendor  string `json:"vendor"`
		Version string `json:"version"`
		Date    string `json:"date"`
	} `json:"bios"`
	Lic []struct {
		Name   string `json:"name"`
		Desc   string `json:"desc"`
		Status int    `json:"status"`
		App    string `json:"app"`
	} `json:"lic"`
	LicOK     bool   `json:"lic_ok"`
	LicError  string `json:"lic_error"`
	Edition   string `json:"edition"`
	OfficeC2R string `json:"office_c2r"`
	PD        []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Serial string `json:"serial"`
		Media  string `json:"media"`
		Bus    string `json:"bus"`
		Size   int64  `json:"size"`
		Health string `json:"health"`
		Op     string `json:"op"`
		Rel    *struct {
			Temp *float64 `json:"temp"`
			Wear *float64 `json:"wear"`
			POH  *float64 `json:"poh"`
			RErr *float64 `json:"rerr"`
			WErr *float64 `json:"werr"`
		} `json:"rel"`
		RelError string `json:"rel_error"`
	} `json:"pd"`
	PDError string `json:"pd_error"`
	Bat     []struct {
		Name   string `json:"name"`
		ID     string `json:"id"`
		Charge int    `json:"charge"`
		Status int    `json:"status"`
	} `json:"bat"`
	BatDesign []int64 `json:"bat_design"`
	BatFull   []int64 `json:"bat_full"`
	BatCycles []int64 `json:"bat_cycles"`
	BatError  string  `json:"bat_error"`
}

// smbiosMemoryType names SMBIOS memory type codes (SMBIOS 3.x, table 7.18.2).
func smbiosMemoryType(code int) string {
	switch code {
	case 20:
		return "DDR"
	case 21:
		return "DDR2"
	case 24:
		return "DDR3"
	case 26:
		return "DDR4"
	case 27:
		return "LPDDR"
	case 28:
		return "LPDDR2"
	case 29:
		return "LPDDR3"
	case 30:
		return "LPDDR4"
	case 34:
		return "DDR5"
	case 35:
		return "LPDDR5"
	}
	return ""
}

// windowsLicenceStatus maps SoftwareLicensingProduct.LicenseStatus.
func windowsLicenceStatus(code int) string {
	switch code {
	case 0:
		return "unlicensed"
	case 1:
		return "licensed"
	case 2, 3, 6:
		return "grace"
	case 4:
		return "not_genuine"
	case 5:
		return "notification"
	}
	return "unknown"
}

func mediaTypeName(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "ssd", "4":
		return "SSD"
	case "hdd", "3":
		return "HDD"
	case "scm", "5":
		return "SCM"
	}
	return "unspecified"
}

func healthName(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "healthy", "0":
		return "healthy"
	case "warning", "1":
		return "warning"
	case "unhealthy", "2":
		return "unhealthy"
	}
	return "unknown"
}

func optInt(f *float64) *int {
	if f == nil {
		return nil
	}
	return intP(int(*f))
}

func optI64(f *float64) *int64 {
	if f == nil {
		return nil
	}
	return i64P(int64(*f))
}

// ParseWindowsHardware turns the PowerShell report into the inventory.
func ParseWindowsHardware(raw []byte, now time.Time) (Hardware, error) {
	h := newHardware(now)
	var rep winHardwareReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return h, fmt.Errorf("hardware report is not JSON: %w", err)
	}
	for _, c := range rep.CPU {
		if strings.TrimSpace(c.Name) == "" {
			continue
		}
		h.CPUs = append(h.CPUs, HWCPU{Name: clip(c.Name, 160), Manufacturer: clip(c.Mfg, 120), Cores: c.Cores, Threads: c.Threads, MaxMHz: c.MHz, Socket: clip(c.Socket, 60)})
	}
	if len(h.CPUs) == 0 {
		h.note("cpus", "Win32_Processor returned nothing")
	}
	for _, m := range rep.Mem {
		if m.Cap <= 0 {
			continue
		}
		slot := strings.TrimSpace(m.Slot)
		if slot == "" {
			slot = strings.TrimSpace(m.Bank)
		}
		speed := m.Speed
		if speed <= 0 {
			speed = m.Speed2
		}
		h.MemoryModules = append(h.MemoryModules, HWMemoryModule{
			Slot: clip(slot, 60), CapacityMB: int(m.Cap / (1024 * 1024)), SpeedMHz: speed, Type: smbiosMemoryType(m.Type),
			Manufacturer: clip(m.Mfg, 120), PartNumber: clip(m.Part, 80),
		})
	}
	if len(h.MemoryModules) == 0 {
		h.note("memory_modules", firstNonEmptyStr(rep.MemError, "Win32_PhysicalMemory listed no modules (common in virtual machines)"))
	}
	serial := rep.Sys.Serial
	if blankSerial(serial) {
		serial = rep.Sys.UUIDSerial
	}
	h.System = HWSystem{Manufacturer: clip(rep.Sys.Mfg, 120), Model: clip(rep.Sys.Model, 120), SKU: clip(rep.Sys.SKU, 120)}
	if !blankSerial(serial) {
		h.System.Serial = clip(serial, 120)
	} else {
		h.note("system_serial", "the firmware reports no serial number")
	}
	h.Board = HWBoard{Manufacturer: clip(rep.Board.Mfg, 120), Product: clip(rep.Board.Product, 120), Version: clip(rep.Board.Version, 60)}
	if !blankSerial(rep.Board.Serial) {
		h.Board.Serial = clip(rep.Board.Serial, 120)
	}
	if h.Board.Manufacturer == "" && h.Board.Product == "" {
		h.note("board", "Win32_BaseBoard returned nothing")
	}
	h.BIOS = HWBIOS{Vendor: clip(rep.BIOS.Vendor, 120), Version: clip(rep.BIOS.Version, 120), ReleaseDate: clip(rep.BIOS.Date, 20)}
	if h.BIOS.Version == "" {
		h.note("bios", "Win32_BIOS returned nothing")
	}

	// Licences: only products whose licence is not "unlicensed" are returned by the query.
	const licSource = "CIM SoftwareLicensingProduct (Name, Description, LicenseStatus)"
	if rep.LicOK {
		sawWindows := false
		for _, l := range rep.Lic {
			kind := "windows"
			if strings.EqualFold(l.App, "0ff1ce15-a989-479d-af46-f275c6370663") {
				kind = "office"
			} else {
				sawWindows = true
			}
			h.Licences = append(h.Licences, HWLicence{Kind: kind, Product: clip(firstNonEmptyStr(l.Name, "Unnamed product"), 200), Status: windowsLicenceStatus(l.Status), Detail: clip(l.Desc, 300), Source: licSource})
		}
		if !sawWindows {
			product := "Windows"
			if rep.Edition != "" {
				product = "Windows (" + rep.Edition + ")"
			}
			h.Licences = append(h.Licences, HWLicence{Kind: "windows", Product: clip(product, 200), Status: "unlicensed", Detail: "no Windows product with an activated or grace licence was reported", Source: licSource})
		}
		sawOffice := false
		for _, l := range h.Licences {
			if l.Kind == "office" {
				sawOffice = true
			}
		}
		if !sawOffice && rep.OfficeC2R != "" {
			// Microsoft 365 apps often license per user (not in this machine store).
			h.Licences = append(h.Licences, HWLicence{Kind: "office", Product: clip("Office Click-to-Run: "+rep.OfficeC2R, 200), Status: "unknown", Detail: "installed; its licence is not in the machine licensing store (often a per-user Microsoft 365 licence)", Source: "registry Office\\ClickToRun\\Configuration ProductReleaseIds"})
		}
	} else {
		h.note("licences", firstNonEmptyStr(rep.LicError, "the licensing service did not answer"))
	}

	for _, d := range rep.PD {
		disk := HWPhysicalDisk{
			Name: clip(firstNonEmptyStr(d.Name, "Disk "+d.ID), 160), Serial: clip(d.Serial, 120), MediaType: mediaTypeName(d.Media), Bus: clip(d.Bus, 40),
			Health: healthName(d.Health), Operational: clip(d.Op, 120), Source: "Get-PhysicalDisk (MSFT_PhysicalDisk)",
		}
		disk.Model = disk.Name
		if d.Size > 0 {
			disk.SizeGB = round1(float64(d.Size) / 1e9)
		}
		switch {
		case d.Rel != nil:
			disk.TemperatureC = optInt(d.Rel.Temp)
			disk.WearPct = optInt(d.Rel.Wear)
			disk.PowerOnHours = optInt(d.Rel.POH)
			disk.ReadErrors = optI64(d.Rel.RErr)
			disk.WriteErrors = optI64(d.Rel.WErr)
			if disk.TemperatureC == nil && disk.WearPct == nil && disk.PowerOnHours == nil && disk.ReadErrors == nil && disk.WriteErrors == nil {
				disk.Reliability = "the disk reports no reliability counters"
			}
		case !rep.Elevated:
			disk.Reliability = "reliability counters need the agent to run as an administrator (the service does)"
		default:
			disk.Reliability = clip(firstNonEmptyStr(d.RelError, "Get-StorageReliabilityCounter returned nothing"), 300)
		}
		h.PhysicalDisks = append(h.PhysicalDisks, disk)
	}
	if len(h.PhysicalDisks) == 0 {
		h.note("physical_disks", firstNonEmptyStr(rep.PDError, "Get-PhysicalDisk listed no disks"))
	}

	for i, b := range rep.Bat {
		bat := HWBattery{Name: clip(firstNonEmptyStr(b.Name, b.ID, "Battery"), 120), Source: "Win32_Battery + root/WMI BatteryStaticData, BatteryFullChargedCapacity, BatteryCycleCount"}
		if b.Charge > 0 {
			bat.ChargePct = intP(b.Charge)
		}
		bat.Status = batteryStatus(b.Status)
		if i < len(rep.BatDesign) && rep.BatDesign[i] > 0 {
			bat.DesignCapacityMWh = intP(int(rep.BatDesign[i]))
		}
		if i < len(rep.BatFull) && rep.BatFull[i] > 0 {
			bat.FullChargeCapacityMWh = intP(int(rep.BatFull[i]))
		}
		if i < len(rep.BatCycles) && rep.BatCycles[i] > 0 {
			bat.CycleCount = intP(int(rep.BatCycles[i]))
		}
		if bat.DesignCapacityMWh != nil && bat.FullChargeCapacityMWh != nil {
			bat.HealthPct = BatteryHealth(*bat.DesignCapacityMWh, *bat.FullChargeCapacityMWh)
		}
		h.Batteries = append(h.Batteries, bat)
	}
	if len(rep.Bat) == 0 {
		h.note("batteries", "no battery (Win32_Battery lists none)")
	} else if rep.BatError != "" && len(rep.BatDesign) == 0 {
		h.note("battery_capacity", "root/WMI battery classes: "+rep.BatError+" (they often need the agent to run as an administrator)")
	}
	return h, nil
}

func batteryStatus(code int) string {
	switch code {
	case 1:
		return "discharging"
	case 2:
		return "on AC power"
	case 3:
		return "fully charged"
	case 4, 5:
		return "low"
	case 6, 7, 8, 9:
		return "charging"
	}
	return ""
}

// blankSerial: firmware placeholders that are not serial numbers.
func blankSerial(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "0", "none", "default string", "to be filled by o.e.m.", "system serial number", "not specified", "n/a", "0123456789", "chassis serial number", "base board serial number":
		return true
	}
	return false
}

func collectWindowsHardware(ctx context.Context, env complianceEnv) Hardware {
	out, err := env.run(ctx, 120*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", windowsHardwareScript)
	h, perr := ParseWindowsHardware([]byte(strings.TrimSpace(out)), env.now())
	if err != nil || perr != nil {
		h = newHardware(env.now())
		why := "hardware script failed: " + errText(out, err)
		for _, part := range []string{"cpus", "memory_modules", "system", "board", "bios", "licences", "physical_disks", "batteries"} {
			h.note(part, why)
		}
	}
	return h
}

// ── Linux ────────────────────────────────────────────────────────────────────────────────────

// ParseLinuxCPUs reads /proc/cpuinfo into one entry per physical package.
func ParseLinuxCPUs(raw string) []HWCPU {
	type pkg struct {
		name, vendor   string
		cores, threads int
		mhz            float64
	}
	pkgs := map[string]*pkg{}
	var order []string
	cur := map[string]string{}
	flush := func() {
		if len(cur) == 0 {
			return
		}
		id := cur["physical id"]
		p, ok := pkgs[id]
		if !ok {
			p = &pkg{}
			pkgs[id] = p
			order = append(order, id)
		}
		p.threads++
		if p.name == "" {
			p.name = firstNonEmptyStr(cur["model name"], cur["cpu model"], cur["hardware"])
		}
		if p.vendor == "" {
			p.vendor = cur["vendor_id"]
		}
		if n, err := strconv.Atoi(cur["cpu cores"]); err == nil {
			p.cores = n
		}
		if f, err := strconv.ParseFloat(cur["cpu mhz"], 64); err == nil && f > p.mhz {
			p.mhz = f
		}
		cur = map[string]string{}
	}
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		i := strings.Index(line, ":")
		if i <= 0 {
			continue
		}
		cur[strings.ToLower(strings.TrimSpace(line[:i]))] = strings.TrimSpace(line[i+1:])
	}
	flush()
	var out []HWCPU
	for _, id := range order {
		p := pkgs[id]
		if p.name == "" {
			continue
		}
		c := HWCPU{Name: clip(p.name, 160), Manufacturer: clip(p.vendor, 120), Threads: p.threads, MaxMHz: int(p.mhz)}
		if p.cores > 0 {
			c.Cores = p.cores
		}
		out = append(out, c)
	}
	return out
}

// ParseDmidecodeMemory reads `dmidecode -t memory` (type 17 devices) into installed modules.
func ParseDmidecodeMemory(raw string) []HWMemoryModule {
	var out []HWMemoryModule
	var cur map[string]string
	flush := func() {
		if cur == nil {
			return
		}
		size := cur["size"]
		mb := 0
		if f := strings.Fields(size); len(f) == 2 {
			n, _ := strconv.Atoi(f[0])
			switch strings.ToUpper(f[1]) {
			case "MB":
				mb = n
			case "GB":
				mb = n * 1024
			case "TB":
				mb = n * 1024 * 1024
			}
		}
		if mb > 0 {
			speed := 0
			for _, k := range []string{"configured memory speed", "configured clock speed", "speed"} {
				if f := strings.Fields(cur[k]); len(f) >= 1 {
					if n, err := strconv.Atoi(f[0]); err == nil && n > 0 {
						speed = n
						break
					}
				}
			}
			mfg := cur["manufacturer"]
			if strings.EqualFold(mfg, "unknown") || strings.EqualFold(mfg, "not specified") {
				mfg = ""
			}
			out = append(out, HWMemoryModule{Slot: clip(cur["locator"], 60), CapacityMB: mb, SpeedMHz: speed, Type: clip(cur["type"], 20), Manufacturer: clip(mfg, 120), PartNumber: clip(cur["part number"], 80)})
		}
		cur = nil
	}
	for _, line := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "Memory Device") {
			flush()
			cur = map[string]string{}
			continue
		}
		if strings.HasPrefix(line, "Handle ") {
			flush()
			continue
		}
		if cur == nil {
			continue
		}
		if i := strings.Index(t, ":"); i > 0 {
			cur[strings.ToLower(strings.TrimSpace(t[:i]))] = strings.TrimSpace(t[i+1:])
		}
	}
	flush()
	return out
}

// lsblkReport is `lsblk -J -b -d -o NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE`.
type lsblkReport struct {
	Blockdevices []struct {
		Name   string          `json:"name"`
		Model  *string         `json:"model"`
		Serial *string         `json:"serial"`
		Size   json.RawMessage `json:"size"`
		Rota   json.RawMessage `json:"rota"`
		Tran   *string         `json:"tran"`
		Type   string          `json:"type"`
	} `json:"blockdevices"`
}

func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// ParseLsblk lists the whole disks (no loop, ram or optical devices).
func ParseLsblk(raw []byte) ([]HWPhysicalDisk, error) {
	var rep lsblkReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, err
	}
	var out []HWPhysicalDisk
	for _, d := range rep.Blockdevices {
		if d.Type != "disk" || strings.HasPrefix(d.Name, "loop") || strings.HasPrefix(d.Name, "ram") || strings.HasPrefix(d.Name, "zram") {
			continue
		}
		size, _ := strconv.ParseFloat(strings.Trim(string(d.Size), `"`), 64)
		rota := strings.Trim(string(d.Rota), `"`)
		media := "unspecified"
		switch rota {
		case "true", "1":
			media = "HDD"
		case "false", "0":
			media = "SSD"
		}
		out = append(out, HWPhysicalDisk{Name: "/dev/" + d.Name, Model: clip(strOr(d.Model), 160), Serial: clip(strOr(d.Serial), 120), MediaType: media, Bus: clip(strOr(d.Tran), 40), SizeGB: round1(size / 1e9), Health: "unknown", Source: "lsblk"})
	}
	return out, nil
}

// smartctlReport is the part of `smartctl -j -H -A /dev/X` used here.
type smartctlReport struct {
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature *struct {
		Current int `json:"current"`
	} `json:"temperature"`
	PowerOnTime *struct {
		Hours int `json:"hours"`
	} `json:"power_on_time"`
	NVMeHealth *struct {
		PercentageUsed int   `json:"percentage_used"`
		MediaErrors    int64 `json:"media_errors"`
	} `json:"nvme_smart_health_information_log"`
}

// ApplySmartctl fills health and counters from smartctl's JSON.
func ApplySmartctl(d *HWPhysicalDisk, raw []byte) error {
	var rep smartctlReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return err
	}
	if rep.SmartStatus != nil {
		if rep.SmartStatus.Passed {
			d.Health = "healthy"
		} else {
			d.Health = "unhealthy"
		}
	}
	if rep.Temperature != nil && rep.Temperature.Current > 0 {
		d.TemperatureC = intP(rep.Temperature.Current)
	}
	if rep.PowerOnTime != nil {
		d.PowerOnHours = intP(rep.PowerOnTime.Hours)
	}
	if rep.NVMeHealth != nil {
		d.WearPct = intP(rep.NVMeHealth.PercentageUsed)
		d.ReadErrors = i64P(rep.NVMeHealth.MediaErrors)
	}
	d.Source = "lsblk + smartctl"
	return nil
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readIntFile(path string) (int, bool) {
	n, err := strconv.Atoi(readTrim(path))
	return n, err == nil
}

// LinuxBatteries reads /sys/class/power_supply/BAT* under root ("/" outside tests). Energy is in
// µWh (energy_*) or, on some machines, charge in µAh (charge_*) with voltage_min_design in µV.
func LinuxBatteries(root string) []HWBattery {
	matches, _ := filepath.Glob(filepath.Join(root, "sys/class/power_supply/BAT*"))
	sort.Strings(matches)
	var out []HWBattery
	for _, dir := range matches {
		b := HWBattery{Name: filepath.Base(dir), Source: "/sys/class/power_supply"}
		if m := readTrim(filepath.Join(dir, "model_name")); m != "" {
			b.Name = clip(b.Name+" "+m, 120)
		}
		design, okD := readIntFile(filepath.Join(dir, "energy_full_design"))
		full, okF := readIntFile(filepath.Join(dir, "energy_full"))
		if !okD || !okF {
			cd, ok1 := readIntFile(filepath.Join(dir, "charge_full_design"))
			cf, ok2 := readIntFile(filepath.Join(dir, "charge_full"))
			v, ok3 := readIntFile(filepath.Join(dir, "voltage_min_design"))
			if ok1 && ok2 && ok3 && v > 0 {
				design, full = int(int64(cd)*int64(v)/1e6), int(int64(cf)*int64(v)/1e6)
				okD, okF = true, true
			}
		}
		if okD && design > 0 {
			b.DesignCapacityMWh = intP(design / 1000)
		}
		if okF && full > 0 {
			b.FullChargeCapacityMWh = intP(full / 1000)
		}
		if b.DesignCapacityMWh != nil && b.FullChargeCapacityMWh != nil {
			b.HealthPct = BatteryHealth(*b.DesignCapacityMWh, *b.FullChargeCapacityMWh)
		}
		if c, ok := readIntFile(filepath.Join(dir, "cycle_count")); ok && c > 0 {
			b.CycleCount = intP(c)
		}
		if c, ok := readIntFile(filepath.Join(dir, "capacity")); ok {
			b.ChargePct = intP(c)
		}
		b.Status = strings.ToLower(readTrim(filepath.Join(dir, "status")))
		out = append(out, b)
	}
	return out
}

func collectLinuxHardware(ctx context.Context, env complianceEnv, root string) Hardware {
	h := newHardware(env.now())
	if raw, err := os.ReadFile(filepath.Join(root, "proc/cpuinfo")); err == nil {
		h.CPUs = append(h.CPUs, ParseLinuxCPUs(string(raw))...)
	}
	if len(h.CPUs) == 0 {
		h.note("cpus", "/proc/cpuinfo has no model name")
	}
	dmi := func(n string) string { return clip(readTrim(filepath.Join(root, "sys/class/dmi/id", n)), 120) }
	h.System = HWSystem{Manufacturer: dmi("sys_vendor"), Model: dmi("product_name"), SKU: dmi("product_sku")}
	if s := dmi("product_serial"); !blankSerial(s) {
		h.System.Serial = s
	} else {
		h.note("system_serial", "/sys/class/dmi/id/product_serial is readable by root only (or the firmware has none)")
	}
	h.Board = HWBoard{Manufacturer: dmi("board_vendor"), Product: dmi("board_name"), Version: dmi("board_version")}
	if s := dmi("board_serial"); !blankSerial(s) {
		h.Board.Serial = s
	}
	if h.Board.Manufacturer == "" && h.Board.Product == "" {
		h.note("board", "no /sys/class/dmi/id board fields (no DMI on this machine)")
	}
	h.BIOS = HWBIOS{Vendor: dmi("bios_vendor"), Version: dmi("bios_version"), ReleaseDate: dmi("bios_date")}
	if h.BIOS.Version == "" {
		h.note("bios", "no /sys/class/dmi/id/bios_version")
	}
	if env.has("dmidecode") {
		out, err := env.run(ctx, 20*time.Second, "dmidecode", "-t", "memory")
		if err == nil {
			h.MemoryModules = append(h.MemoryModules, ParseDmidecodeMemory(out)...)
		}
		if len(h.MemoryModules) == 0 {
			h.note("memory_modules", "dmidecode -t memory: "+errText(out, err)+" (it needs root)")
		}
	} else {
		h.note("memory_modules", "dmidecode is not installed")
	}
	h.note("licences", "Linux has no licence store the agent can read")
	if env.has("lsblk") {
		out, err := env.run(ctx, 15*time.Second, "lsblk", "-J", "-b", "-d", "-o", "NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE")
		disks, perr := ParseLsblk([]byte(out))
		if err != nil || perr != nil {
			h.note("physical_disks", "lsblk: "+errText(out, err))
		}
		smart := env.has("smartctl")
		for i := range disks {
			if !smart {
				disks[i].Reliability = "smartctl (smartmontools) is not installed"
				continue
			}
			sout, serr := env.run(ctx, 20*time.Second, "smartctl", "-j", "-H", "-A", disks[i].Name)
			if aerr := ApplySmartctl(&disks[i], []byte(sout)); aerr != nil {
				disks[i].Reliability = clip("smartctl: "+errText(sout, serr)+" (it needs root)", 300)
			}
		}
		h.PhysicalDisks = append(h.PhysicalDisks, disks...)
	} else {
		h.note("physical_disks", "lsblk is not installed")
	}
	h.Batteries = append(h.Batteries, LinuxBatteries(root)...)
	if len(h.Batteries) == 0 {
		h.note("batteries", "no battery under /sys/class/power_supply")
	}
	return h
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

type spReport struct {
	Hardware []struct {
		MachineModel string          `json:"machine_model"`
		MachineName  string          `json:"machine_name"`
		ChipType     string          `json:"chip_type"`
		CPUType      string          `json:"cpu_type"`
		CPUSpeed     string          `json:"current_processor_speed"`
		Cores        json.RawMessage `json:"number_processors"`
		Serial       string          `json:"serial_number"`
		BootROM      string          `json:"boot_rom_version"`
		Memory       string          `json:"physical_memory"`
	} `json:"SPHardwareDataType"`
	Memory []struct {
		Items []struct {
			Name   string `json:"_name"`
			Size   string `json:"dimm_size"`
			Speed  string `json:"dimm_speed"`
			Type   string `json:"dimm_type"`
			Vendor string `json:"dimm_manufacturer"`
			Part   string `json:"dimm_part_number"`
		} `json:"_items"`
		Type   string `json:"dimm_type"`
		Vendor string `json:"dimm_manufacturer"`
		Global string `json:"SPMemoryDataType"`
	} `json:"SPMemoryDataType"`
	NVMe []struct {
		Items []struct {
			Name   string `json:"_name"`
			Model  string `json:"device_model"`
			Serial string `json:"device_serial"`
			Size   int64  `json:"size_in_bytes"`
			SMART  string `json:"smart_status"`
		} `json:"_items"`
	} `json:"SPNVMeDataType"`
	SATA []struct {
		Items []struct {
			Name   string `json:"_name"`
			Model  string `json:"device_model"`
			Serial string `json:"device_serial"`
			Size   int64  `json:"size_in_bytes"`
			SMART  string `json:"smart_status"`
			Medium string `json:"spsata_medium_type"`
		} `json:"_items"`
	} `json:"SPSerialATADataType"`
	Power []struct {
		Name   string `json:"_name"`
		Health *struct {
			Cycles    int    `json:"sppower_battery_cycle_count"`
			Condition string `json:"sppower_battery_health"`
			MaxCap    string `json:"sppower_battery_health_maximum_capacity"`
		} `json:"sppower_battery_health_info"`
		Charge *struct {
			StateOfCharge int `json:"sppower_battery_state_of_charge"`
		} `json:"sppower_battery_charge_info"`
	} `json:"SPPowerDataType"`
}

// ParseMacCores reads number_processors: a number (Intel) or "proc 10:8:2" (Apple silicon: total
// cores, then performance and efficiency cores).
func ParseMacCores(raw string) int {
	s := strings.TrimSpace(strings.Trim(strings.TrimSpace(raw), `"`))
	s = strings.TrimSpace(strings.TrimPrefix(s, "proc"))
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[:i]
	}
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func parseSize(s string) int {
	f := strings.Fields(s)
	if len(f) != 2 {
		return 0
	}
	n, _ := strconv.Atoi(f[0])
	switch strings.ToUpper(f[1]) {
	case "GB":
		return n * 1024
	case "MB":
		return n
	}
	return 0
}

func smartHealth(s string) string {
	switch strings.ToLower(s) {
	case "verified":
		return "healthy"
	case "failing":
		return "unhealthy"
	}
	return "unknown"
}

// ParseSystemProfiler reads `system_profiler -json SPHardwareDataType SPMemoryDataType
// SPNVMeDataType SPSerialATADataType SPPowerDataType`.
func ParseSystemProfiler(raw []byte, now time.Time) (Hardware, error) {
	h := newHardware(now)
	var rep spReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return h, err
	}
	for _, hw := range rep.Hardware {
		name := firstNonEmptyStr(hw.ChipType, hw.CPUType)
		cores := ParseMacCores(string(hw.Cores))
		if name != "" {
			h.CPUs = append(h.CPUs, HWCPU{Name: clip(name, 160), Manufacturer: "Apple", Cores: cores})
		}
		h.System = HWSystem{Manufacturer: "Apple", Model: clip(firstNonEmptyStr(hw.MachineModel, hw.MachineName), 120), Serial: clip(hw.Serial, 120)}
		h.BIOS = HWBIOS{Vendor: "Apple", Version: clip(hw.BootROM, 120)}
		if len(rep.Memory) > 0 && len(rep.Memory[0].Items) == 0 && hw.Memory != "" {
			// Apple silicon: unified memory, one package on the chip.
			h.MemoryModules = append(h.MemoryModules, HWMemoryModule{Slot: "unified memory", CapacityMB: parseSize(hw.Memory), Type: clip(rep.Memory[0].Type, 20), Manufacturer: clip(rep.Memory[0].Vendor, 120)})
		}
	}
	h.note("board", "Macs report no separate board identity")
	for _, m := range rep.Memory {
		for _, it := range m.Items {
			if mb := parseSize(it.Size); mb > 0 {
				speed, _ := strconv.Atoi(strings.Fields(it.Speed + " 0")[0])
				h.MemoryModules = append(h.MemoryModules, HWMemoryModule{Slot: clip(it.Name, 60), CapacityMB: mb, SpeedMHz: speed, Type: clip(it.Type, 20), Manufacturer: clip(it.Vendor, 120), PartNumber: clip(it.Part, 80)})
			}
		}
	}
	for _, c := range rep.NVMe {
		for _, it := range c.Items {
			h.PhysicalDisks = append(h.PhysicalDisks, HWPhysicalDisk{Name: clip(it.Name, 160), Model: clip(it.Model, 160), Serial: clip(it.Serial, 120), MediaType: "SSD", Bus: "NVMe", SizeGB: round1(float64(it.Size) / 1e9), Health: smartHealth(it.SMART), Reliability: "system_profiler reports the SMART verdict only", Source: "system_profiler SPNVMeDataType"})
		}
	}
	for _, c := range rep.SATA {
		for _, it := range c.Items {
			media := "unspecified"
			if strings.Contains(strings.ToLower(it.Medium), "solid") {
				media = "SSD"
			} else if strings.Contains(strings.ToLower(it.Medium), "rotational") {
				media = "HDD"
			}
			h.PhysicalDisks = append(h.PhysicalDisks, HWPhysicalDisk{Name: clip(it.Name, 160), Model: clip(it.Model, 160), Serial: clip(it.Serial, 120), MediaType: media, Bus: "SATA", SizeGB: round1(float64(it.Size) / 1e9), Health: smartHealth(it.SMART), Reliability: "system_profiler reports the SMART verdict only", Source: "system_profiler SPSerialATADataType"})
		}
	}
	for _, p := range rep.Power {
		if p.Health == nil {
			continue
		}
		b := HWBattery{Name: "Internal battery", Status: clip(p.Health.Condition, 60), Source: "system_profiler SPPowerDataType"}
		if p.Health.Cycles > 0 {
			b.CycleCount = intP(p.Health.Cycles)
		}
		if v, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(p.Health.MaxCap), "%"), 64); err == nil && v > 0 {
			b.HealthPct = f64P(v)
		}
		if p.Charge != nil {
			b.ChargePct = intP(p.Charge.StateOfCharge)
		}
		h.Batteries = append(h.Batteries, b)
	}
	if len(h.Batteries) == 0 {
		h.note("batteries", "no battery reported by system_profiler")
	} else {
		h.note("battery_capacity", "macOS reports maximum capacity as a percentage, not in mWh")
	}
	h.note("licences", "macOS has no licence store the agent can read")
	if len(h.MemoryModules) == 0 {
		h.note("memory_modules", "system_profiler listed no memory")
	}
	if len(h.PhysicalDisks) == 0 {
		h.note("physical_disks", "system_profiler listed no NVMe or SATA disk")
	}
	return h, nil
}

func collectDarwinHardware(ctx context.Context, env complianceEnv) Hardware {
	out, err := env.run(ctx, 90*time.Second, "system_profiler", "-json", "SPHardwareDataType", "SPMemoryDataType", "SPNVMeDataType", "SPSerialATADataType", "SPPowerDataType")
	h, perr := ParseSystemProfiler([]byte(out), env.now())
	if err != nil && perr != nil {
		h = newHardware(env.now())
		for _, part := range []string{"cpus", "memory_modules", "system", "physical_disks", "batteries"} {
			h.note(part, "system_profiler: "+errText(out, err))
		}
	}
	return h
}
