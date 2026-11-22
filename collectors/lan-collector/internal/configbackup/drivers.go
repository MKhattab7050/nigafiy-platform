package configbackup

import "regexp"

// Driver describes how to read the configuration of one vendor family over SSH. Every command
// below is read-only ("show", "display", "export", "get") or changes only the CLI session itself
// (pager / screen width). The lists are closed: a backup never sends anything else. Restoring a
// configuration is a separate, administrator-confirmed operation (restore.go), Junos only.
type Driver struct {
	ID   string
	Name string
	// Exec: run the commands over SSH "exec" channels instead of an interactive shell.
	Exec bool
	// Enable: the CLI has an unprivileged mode (prompt ends with '>') and an "enable" step.
	Enable bool
	// Session-only commands sent first (pager off, wide terminal). Failures are ignored.
	Session []string
	// The read-only backup commands, in order; their outputs are concatenated.
	Commands []string

	// Detection signatures (any may be nil).
	Text      *regexp.Regexp // login banner / probe output
	OUIVendor *regexp.Regexp // IEEE OUI vendor of the device's MAC (from the server)
	SysDescr  *regexp.Regexp // SNMP sysDescr (from the server)
	// Prompt family this driver's CLI prompt belongs to.
	Family string
}

const (
	familyCisco  = "hostname#"     // R1> / R1# / switch# / console#
	familyAtUser = "user@host>"    // admin@srx> / admin@PA-220>
	familyShell  = "user@host:~$"  // root@OpenWrt:~# / ubnt@edge:~$ / vyos@vyos:~$
	familyAngle  = "<hostname>"    // <HUAWEI>
	familyMik    = "[user@host] >" // [admin@MikroTik] >
	familyForti  = "hostname #"    // FGT60F # / FGT (root) #
)

// promptFamilies classify the prompt the device shows after login. A family narrows the candidate
// drivers; it never decides alone between drivers that share it.
var promptFamilies = []struct {
	family string
	re     *regexp.Regexp
}{
	{familyMik, regexp.MustCompile(`^\[[^\]@\s]+@[^\]]+\]\s*>$`)},
	{familyAngle, regexp.MustCompile(`^<[^<>\s]{1,64}>$`)},
	{familyShell, regexp.MustCompile(`^[\w.\-]+@[\w.\-]+:[^\s]*\s?[$#]$`)},
	{familyAtUser, regexp.MustCompile(`^[\w.\-]+@[\w.\-]+(:[\w.\-]+)?\s?[>#%]$`)},
	{familyForti, regexp.MustCompile(`^[\w.\-]+ (\([\w.\-]+\) )?[#$]$`)},
	{familyCisco, regexp.MustCompile(`^[\w.\-/()]{1,64}(\(config[^)]*\))?[>#]$`)},
}

func promptFamily(prompt string) string {
	for _, f := range promptFamilies {
		if f.re.MatchString(prompt) {
			return f.family
		}
	}
	return ""
}

var drivers = []*Driver{
	{
		ID: "cisco_ios", Name: "Cisco IOS / IOS-XE", Enable: true, Family: familyCisco,
		Session:   []string{"terminal length 0", "terminal width 0"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`Cisco IOS[ -]XE Software|Cisco IOS Software|IOS \(tm\)|Cisco Internetwork Operating System`),
		OUIVendor: regexp.MustCompile(`(?i)\bcisco\b`),
		SysDescr:  regexp.MustCompile(`Cisco IOS|IOS-XE`),
	},
	{
		ID: "cisco_nxos", Name: "Cisco NX-OS", Family: familyCisco,
		Session:   []string{"terminal length 0", "terminal width 511"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`Cisco Nexus Operating System|NX-OS`),
		OUIVendor: regexp.MustCompile(`(?i)\bcisco\b`),
		SysDescr:  regexp.MustCompile(`NX-OS|Nexus`),
	},
	{
		ID: "cisco_asa", Name: "Cisco ASA", Enable: true, Family: familyCisco,
		Session:   []string{"terminal pager 0"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`Cisco Adaptive Security Appliance`),
		OUIVendor: regexp.MustCompile(`(?i)\bcisco\b`),
		SysDescr:  regexp.MustCompile(`Adaptive Security Appliance`),
	},
	{
		ID: "aruba_procurve", Name: "Aruba / HPE ProCurve (ArubaOS-Switch)", Family: familyCisco,
		Session:   []string{"no page"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`ProCurve|ArubaOS-Switch|Image stamp:|(HP|HPE|Aruba) J[A-Z]?\d{3,4}[A-Z]?\b`),
		OUIVendor: regexp.MustCompile(`(?i)hewlett|\bhp\b|aruba|procurve`),
		SysDescr:  regexp.MustCompile(`ProCurve|ArubaOS-Switch|HP J\d{4}|Aruba J[A-Z]?\d{3,4}`),
	},
	{
		ID: "aruba_aoscx", Name: "Aruba AOS-CX", Family: familyCisco,
		Session:   []string{"no page"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`ArubaOS-CX|AOS-CX`),
		OUIVendor: regexp.MustCompile(`(?i)hewlett|aruba`),
		SysDescr:  regexp.MustCompile(`ArubaOS-CX|AOS-CX`),
	},
	{
		ID: "juniper_junos", Name: "Juniper Junos", Family: familyAtUser,
		Session:   []string{"set cli screen-length 0", "set cli screen-width 0"},
		Commands:  []string{"show configuration | no-more"},
		Text:      regexp.MustCompile(`JUNOS|Junos:`),
		OUIVendor: regexp.MustCompile(`(?i)juniper`),
		SysDescr:  regexp.MustCompile(`JUNOS|Juniper`),
	},
	{
		ID: "mikrotik_routeros", Name: "MikroTik RouterOS", Exec: true, Family: familyMik,
		Commands:  []string{"/export terse"},
		Text:      regexp.MustCompile(`MikroTik RouterOS|RouterOS v?\d|MikroTik`),
		OUIVendor: regexp.MustCompile(`(?i)routerboard|mikrotik`),
		SysDescr:  regexp.MustCompile(`RouterOS`),
	},
	{
		ID: "fortinet_fortios", Name: "Fortinet FortiOS", Family: familyForti,
		Commands:  []string{"show"},
		Text:      regexp.MustCompile(`FortiGate|FortiWiFi|FortiOS`),
		OUIVendor: regexp.MustCompile(`(?i)fortinet`),
		SysDescr:  regexp.MustCompile(`FortiGate|FortiOS`),
	},
	{
		ID: "vyos_edgeos", Name: "Ubiquiti EdgeOS / VyOS", Family: familyShell,
		Commands:  []string{"show configuration commands | cat"},
		Text:      regexp.MustCompile(`EdgeOS|EdgeRouter|VyOS|Vyatta`),
		OUIVendor: regexp.MustCompile(`(?i)ubiquiti`),
		SysDescr:  regexp.MustCompile(`EdgeOS|EdgeRouter|VyOS|Vyatta`),
	},
	{
		ID: "huawei_vrp", Name: "Huawei VRP", Family: familyAngle,
		Session:   []string{"screen-length 0 temporary"},
		Commands:  []string{"display current-configuration"},
		Text:      regexp.MustCompile(`Huawei Versatile Routing Platform|VRP \(R\) software|HUAWEI`),
		OUIVendor: regexp.MustCompile(`(?i)huawei`),
		SysDescr:  regexp.MustCompile(`Huawei|VRP`),
	},
	{
		ID: "dell_os10", Name: "Dell OS10", Family: familyCisco,
		Session:   []string{"terminal length 0"},
		Commands:  []string{"show running-configuration"},
		Text:      regexp.MustCompile(`OS10|Dell (EMC|SmartFabric) (Networking )?OS10`),
		OUIVendor: regexp.MustCompile(`(?i)\bdell\b`),
		SysDescr:  regexp.MustCompile(`OS10`),
	},
	{
		ID: "dell_os6", Name: "Dell OS6 (N-Series)", Family: familyCisco,
		Session:   []string{"terminal length 0"},
		Commands:  []string{"show running-config"},
		Text:      regexp.MustCompile(`Dell (EMC )?Networking N\d{4}|PowerConnect|Dell N\d{4}`),
		OUIVendor: regexp.MustCompile(`(?i)\bdell\b`),
		SysDescr:  regexp.MustCompile(`Dell (EMC )?Networking N\d|PowerConnect`),
	},
	{
		ID: "openwrt", Name: "OpenWrt / Linux (UCI)", Family: familyShell,
		Commands:  []string{"uci export"},
		Text:      regexp.MustCompile(`OpenWrt|DISTRIB_ID='?OpenWrt|LEDE`),
		SysDescr:  regexp.MustCompile(`OpenWrt`),
		OUIVendor: nil,
	},
	{
		ID: "paloalto_panos", Name: "Palo Alto PAN-OS", Family: familyAtUser,
		Session:   []string{"set cli pager off"},
		Commands:  []string{"show config running"},
		Text:      regexp.MustCompile(`sw-version:|PAN-OS|Palo Alto Networks|model: PA-`),
		OUIVendor: regexp.MustCompile(`(?i)palo alto`),
		SysDescr:  regexp.MustCompile(`Palo Alto Networks|PAN-OS`),
	},
}

// Drivers returns the shipped drivers (for documentation and tests).
func Drivers() []*Driver { return drivers }

// DriverByID returns the driver with this ID, or nil.
func DriverByID(id string) *Driver {
	for _, d := range drivers {
		if d.ID == id {
			return d
		}
	}
	return nil
}

// probes are the read-only commands used to identify a device whose prompt alone does not say what
// it is. Each runs only when the prompt family makes it plausible; outputs are matched against every
// driver's Text signature. A probe the device does not know only produces an error message.
var probes = []struct {
	cmd      string
	families []string
}{
	{"show version", []string{familyCisco, familyAtUser, familyShell, ""}},
	{"show system info", []string{familyAtUser}},
	{"display version", []string{familyAngle, familyCisco, ""}},
	{"get system status", []string{familyForti, familyCisco, ""}},
	{"cat /etc/openwrt_release", []string{familyShell}},
}
