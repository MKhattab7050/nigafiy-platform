package sysinfo

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/agent/internal/config"
)

var hwNow = time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)

const winHardwareSample = `{"elevated":false,
"cpu":[{"name":"Intel(R) Core(TM) i7-1185G7 @ 3.00GHz","mfg":"GenuineIntel","cores":4,"threads":8,"mhz":3000,"socket":"U3E1"}],
"mem":[{"slot":"DIMM A","bank":"BANK 0","cap":17179869184,"speed":3200,"speed2":3200,"type":26,"mfg":"Samsung","part":"M471A2K43DB1-CWE"},{"slot":"","bank":"BANK 2","cap":0,"speed":0,"speed2":0,"type":0,"mfg":"","part":""}],
"sys":{"mfg":"Dell Inc.","model":"Latitude 7420","sku":"0A43","serial":"To be filled by O.E.M.","uuid_serial":"ABC1234"},
"board":{"mfg":"Dell Inc.","product":"07MHG4","version":"A00","serial":"/ABC1234/CNWS0001/"},
"bios":{"vendor":"Dell Inc.","version":"1.24.0","date":"2025-06-10"},
"lic":[{"name":"Windows(R), Professional edition","desc":"Windows(R) Operating System, OEM_DM channel","status":1,"app":"55c92734-d682-4d71-983e-d6ec3f16059f"}],
"lic_ok":true,"edition":"Professional","office_c2r":"O365ProPlusRetail",
"pd":[{"id":"0","name":"NVMe PM9A1 NVMe Samsung 512GB","serial":"S6R0NX0T","media":"SSD","bus":"NVMe","size":512110190592,"health":"Healthy","op":"OK"}],
"bat":[{"name":"DELL M033W","id":"1","charge":87,"status":2}],
"bat_design":[63000],"bat_full":[51660],"bat_cycles":[212]}`

func TestParseWindowsHardware(t *testing.T) {
	h, err := ParseWindowsHardware([]byte(winHardwareSample), hwNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.CPUs) != 1 || h.CPUs[0].Cores != 4 || h.CPUs[0].Threads != 8 {
		t.Fatalf("cpus: %+v", h.CPUs)
	}
	if len(h.MemoryModules) != 1 || h.MemoryModules[0].CapacityMB != 16384 || h.MemoryModules[0].Type != "DDR4" || h.MemoryModules[0].Slot != "DIMM A" {
		t.Fatalf("an empty slot is not a module: %+v", h.MemoryModules)
	}
	if h.System.Serial != "ABC1234" {
		t.Fatalf("a firmware placeholder serial falls back to the product identifying number: %+v", h.System)
	}
	if len(h.Licences) != 2 || h.Licences[0].Status != "licensed" || h.Licences[1].Kind != "office" || h.Licences[1].Status != "unknown" {
		t.Fatalf("licences: %+v", h.Licences)
	}
	if d := h.PhysicalDisks[0]; d.Health != "healthy" || d.MediaType != "SSD" || d.SizeGB != 512.1 || !strings.Contains(d.Reliability, "administrator") {
		t.Fatalf("not elevated: the counters say why they are missing: %+v", d)
	}
	b := h.Batteries[0]
	if *b.DesignCapacityMWh != 63000 || *b.FullChargeCapacityMWh != 51660 || *b.HealthPct != 82 || *b.CycleCount != 212 || b.Status != "on AC power" {
		t.Fatalf("battery: %+v", b)
	}
	if _, ok := h.Unmeasured["licences"]; ok {
		t.Fatal("licences were measured")
	}
	raw, _ := json.Marshal(h)
	for _, forbidden := range []string{"PartialProductKey", "ProductKey", "OA3xOriginalProductKey"} {
		if strings.Contains(string(raw), forbidden) || strings.Contains(windowsHardwareScript, forbidden) {
			t.Fatalf("the inventory never reads or carries a product key (%s)", forbidden)
		}
	}
	if !strings.Contains(windowsHardwareScript, "-Property Name,Description,LicenseStatus,ApplicationID") {
		t.Fatal("the licensing query must ask only for name, description and status")
	}
}

func TestWindowsHardwareUnmeasuredParts(t *testing.T) {
	h, err := ParseWindowsHardware([]byte(`{"elevated":true,"cpu":[],"mem":[],"mem_error":"Access denied","sys":{},"board":{},"bios":{},"lic_error":"RPC unavailable","pd_error":"Invalid class","bat":[]}`), hwNow)
	if err != nil {
		t.Fatal(err)
	}
	for part, want := range map[string]string{"memory_modules": "Access denied", "licences": "RPC unavailable", "physical_disks": "Invalid class", "batteries": "no battery", "bios": "Win32_BIOS", "cpus": "Win32_Processor"} {
		if !strings.Contains(h.Unmeasured[part], want) {
			t.Fatalf("%s: %q", part, h.Unmeasured[part])
		}
	}
	if len(h.Licences) != 0 {
		t.Fatal("no licence is invented when the licensing service did not answer")
	}
	// No Windows product with a licence: stated as unlicensed, with the edition.
	h, _ = ParseWindowsHardware([]byte(`{"lic_ok":true,"lic":[],"edition":"Core"}`), hwNow)
	if len(h.Licences) != 1 || h.Licences[0].Status != "unlicensed" || !strings.Contains(h.Licences[0].Product, "Core") {
		t.Fatalf("%+v", h.Licences)
	}
}

func TestParseLinuxCPUsAndMemory(t *testing.T) {
	cpu := "processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC 7B13\nphysical id\t: 0\ncpu cores\t: 2\ncpu MHz\t\t: 2450.000\n\nprocessor\t: 1\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC 7B13\nphysical id\t: 0\ncpu cores\t: 2\ncpu MHz\t\t: 2450.000\n\n"
	c := ParseLinuxCPUs(cpu)
	if len(c) != 1 || c[0].Threads != 2 || c[0].Cores != 2 || c[0].MaxMHz != 2450 {
		t.Fatalf("%+v", c)
	}
	mem := "Handle 0x0040, DMI type 17, 92 bytes\nMemory Device\n\tSize: 8 GB\n\tLocator: ChannelA-DIMM0\n\tType: DDR4\n\tSpeed: 3200 MT/s\n\tManufacturer: Micron\n\tPart Number: 8ATF1G64HZ-3G2J1\n\tConfigured Memory Speed: 2933 MT/s\n\nHandle 0x0041, DMI type 17, 92 bytes\nMemory Device\n\tSize: No Module Installed\n\tLocator: ChannelB-DIMM0\n"
	m := ParseDmidecodeMemory(mem)
	if len(m) != 1 || m[0].CapacityMB != 8192 || m[0].SpeedMHz != 2933 || m[0].Slot != "ChannelA-DIMM0" {
		t.Fatalf("%+v", m)
	}
}

func TestLinuxHardwareWithFakeRoot(t *testing.T) {
	root := t.TempDir()
	write := func(rel, v string) {
		p := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/cpuinfo", "processor\t: 0\nmodel name\t: Intel Xeon\n\n")
	write("sys/class/dmi/id/sys_vendor", "LENOVO")
	write("sys/class/dmi/id/product_name", "20XW")
	write("sys/class/dmi/id/bios_version", "N32ET80W")
	write("sys/class/dmi/id/board_name", "20XW0055")
	write("sys/class/power_supply/BAT0/charge_full_design", "4000000")
	write("sys/class/power_supply/BAT0/charge_full", "3000000")
	write("sys/class/power_supply/BAT0/voltage_min_design", "11400000")
	write("sys/class/power_supply/BAT0/cycle_count", "301")
	write("sys/class/power_supply/BAT0/status", "Discharging")
	env, _ := fakeEnv("linux", []string{"lsblk"}, map[string]string{
		"lsblk -J -b -d -o NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE": `{"blockdevices":[{"name":"nvme0n1","model":"WDC PC SN730","serial":"2015","size":512110190592,"rota":false,"tran":"nvme","type":"disk"},{"name":"loop0","model":null,"serial":null,"size":1000,"rota":false,"tran":null,"type":"loop"}]}`,
	}, nil)
	h := collectLinuxHardware(context.Background(), env, root)
	if h.System.Manufacturer != "LENOVO" || h.BIOS.Version != "N32ET80W" || !strings.Contains(h.Unmeasured["system_serial"], "root") {
		t.Fatalf("%+v %+v", h.System, h.Unmeasured)
	}
	if len(h.PhysicalDisks) != 1 || h.PhysicalDisks[0].MediaType != "SSD" || h.PhysicalDisks[0].Health != "unknown" || !strings.Contains(h.PhysicalDisks[0].Reliability, "smartctl") {
		t.Fatalf("without smartctl the health is unknown, with the reason: %+v", h.PhysicalDisks)
	}
	if !strings.Contains(h.Unmeasured["memory_modules"], "dmidecode") {
		t.Fatalf("%+v", h.Unmeasured)
	}
	b := h.Batteries[0]
	if *b.DesignCapacityMWh != 45600 || *b.FullChargeCapacityMWh != 34200 || *b.HealthPct != 75 || *b.CycleCount != 301 {
		t.Fatalf("charge (µAh) times voltage gives energy: %+v", b)
	}
}

func TestApplySmartctl(t *testing.T) {
	d := HWPhysicalDisk{Name: "/dev/nvme0n1", Health: "unknown"}
	if err := ApplySmartctl(&d, []byte(`{"smart_status":{"passed":false},"temperature":{"current":41},"power_on_time":{"hours":9001},"nvme_smart_health_information_log":{"percentage_used":12,"media_errors":3}}`)); err != nil {
		t.Fatal(err)
	}
	if d.Health != "unhealthy" || *d.TemperatureC != 41 || *d.PowerOnHours != 9001 || *d.WearPct != 12 || *d.ReadErrors != 3 {
		t.Fatalf("%+v", d)
	}
}

func TestParseSystemProfiler(t *testing.T) {
	raw := `{"SPHardwareDataType":[{"machine_model":"Mac14,2","chip_type":"Apple M2","number_processors":"proc 8:4:4","serial_number":"C02XYZ","boot_rom_version":"10151.1.1","physical_memory":"16 GB"}],
"SPMemoryDataType":[{"dimm_type":"LPDDR5","dimm_manufacturer":"Hynix","SPMemoryDataType":"16 GB"}],
"SPNVMeDataType":[{"_items":[{"_name":"APPLE SSD AP0512Z","device_model":"APPLE SSD AP0512Z","device_serial":"0ba0","size_in_bytes":500277790720,"smart_status":"Verified"}]}],
"SPPowerDataType":[{"_name":"spbattery_information","sppower_battery_health_info":{"sppower_battery_cycle_count":143,"sppower_battery_health":"Good","sppower_battery_health_maximum_capacity":"91%"},"sppower_battery_charge_info":{"sppower_battery_state_of_charge":64}},{"_name":"sppower_ac_charger_information"}]}`
	h, err := ParseSystemProfiler([]byte(raw), hwNow)
	if err != nil {
		t.Fatal(err)
	}
	if h.CPUs[0].Cores != 8 || h.System.Serial != "C02XYZ" || h.MemoryModules[0].CapacityMB != 16384 || h.MemoryModules[0].Type != "LPDDR5" {
		t.Fatalf("%+v %+v %+v", h.CPUs, h.System, h.MemoryModules)
	}
	if h.PhysicalDisks[0].Health != "healthy" || *h.Batteries[0].HealthPct != 91 || *h.Batteries[0].CycleCount != 143 {
		t.Fatalf("%+v %+v", h.PhysicalDisks, h.Batteries)
	}
	if ParseMacCores("8") != 8 || ParseMacCores(`"proc 10:8:2"`) != 10 {
		t.Fatal("cores")
	}
}

func TestLocalAdminEvidence(t *testing.T) {
	env := fixedEnv("windows")
	ev := LocalAdminEvidence(env, "Administrators", "Get-LocalGroupMember", []string{"PC\\Administrator", "AzureAD\\Sara", "PC\\Administrator", " "})
	if len(ev) != 2 || ev[0].Subject != "AzureAD\\Sara" || ev[0].State != "info" || *ev[0].Count != 2 || ev[0].Check != checkLocalAdmins {
		t.Fatalf("%+v", ev)
	}
	many := make([]string, 25)
	for i := range many {
		many[i] = "user" + string(rune('a'+i))
	}
	ev = LocalAdminEvidence(env, "Administrators", "x", many)
	if len(ev) != maxAdminItems+1 || ev[maxAdminItems].State != "unknown" || !strings.Contains(ev[maxAdminItems].Value, "5 more") {
		t.Fatalf("a list cut short says so: %+v", ev[len(ev)-1])
	}
	g, m := ParseGetentGroups("sudo:x:27:alice,bob\nwheel:x:10:\n")
	if strings.Join(g, ",") != "sudo,wheel" || strings.Join(m, ",") != "alice,bob" {
		t.Fatalf("%v %v", g, m)
	}
	if m, ok := ParseDsclMembership("GroupMembership: root alice\n"); !ok || len(m) != 2 {
		t.Fatalf("%v", m)
	}

	lenv, _ := fakeEnv("linux", []string{"getent"}, map[string]string{"getent group sudo wheel admin": "sudo:x:27:alice\n"}, nil)
	ev = localAdminsChecks(context.Background(), lenv)
	if len(ev) != 2 || ev[0].Subject != "alice" || ev[1].Subject != "root" {
		t.Fatalf("%+v", ev)
	}
	wenv, _ := fakeEnv("windows", nil, map[string]string{}, nil)
	ev = localAdminsChecks(context.Background(), wenv)
	if len(ev) != 1 || ev[0].State != "unknown" || !strings.Contains(ev[0].Reason, "could not read") {
		t.Fatalf("not measured is said, never an empty list: %+v", ev)
	}
}

// TestLiveHardwareOnThisMachine prints this computer's real hardware inventory. Opt-in:
// NIGAFIY_LIVE_HARDWARE=1 go test ./internal/sysinfo -run LiveHardware -v
func TestLiveHardwareOnThisMachine(t *testing.T) {
	if config.Getenv("NIGAFIY_LIVE_HARDWARE") != "1" {
		t.Skip("set NIGAFIY_LIVE_HARDWARE=1 to read this machine's hardware")
	}
	h := CollectHardware(context.Background())
	raw, _ := json.MarshalIndent(h, "", "  ")
	t.Log(string(raw))
	ev := localAdminsChecks(context.Background(), defaultComplianceEnv())
	for _, e := range ev {
		t.Logf("local admin: %s %s %s %s", e.Subject, e.State, e.Source, e.Reason)
	}
	if len(h.CPUs) == 0 {
		t.Fatal("no CPU measured")
	}
}
