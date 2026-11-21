// Package netinfo reads what the collector's own host already knows about the local network:
// the neighbour (ARP) table, the default gateway and the interface addresses.
// It only reads operating-system state; it never sends packets.
package netinfo

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Neighbor is one entry of the host's neighbour table.
type Neighbor struct {
	MAC string
	// Reachable means the OS confirmed two-way reachability recently. A stale entry still tells us
	// which MAC an address had, but is not evidence that the device is present right now.
	Reachable bool
}

var macRe = regexp.MustCompile(`^[0-9a-fA-F]{1,2}([:-][0-9a-fA-F]{1,2}){5}$`)

// NormalizeMAC returns lower-case colon-separated form, or "" for addresses that do not identify
// a single device (broadcast, multicast, all-zero, malformed).
func NormalizeMAC(raw string) string {
	if !macRe.MatchString(raw) {
		return ""
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ':' || r == '-' })
	for i, p := range parts {
		if len(p) == 1 {
			p = "0" + p
		}
		parts[i] = strings.ToLower(p)
	}
	mac := strings.Join(parts, ":")
	first, _ := strconv.ParseUint(parts[0], 16, 8)
	if mac == "00:00:00:00:00:00" || mac == "ff:ff:ff:ff:ff:ff" || first&1 == 1 {
		return ""
	}
	return mac
}

func isIPv4(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil && !strings.Contains(s, ":")
}

// ParseIPNeigh parses `ip -4 neigh show` (Linux).
//
//	192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
func ParseIPNeigh(out string) map[string]Neighbor {
	res := map[string]Neighbor{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 || !isIPv4(f[0]) {
			continue
		}
		mac, state := "", f[len(f)-1]
		for i := 1; i < len(f)-1; i++ {
			if f[i] == "lladdr" {
				mac = NormalizeMAC(f[i+1])
			}
		}
		if mac == "" || state == "FAILED" || state == "INCOMPLETE" {
			continue
		}
		res[f[0]] = Neighbor{MAC: mac, Reachable: state == "REACHABLE" || state == "DELAY" || state == "PROBE"}
	}
	return res
}

// ParseProcARP parses /proc/net/arp (Linux fallback).
func ParseProcARP(content string) map[string]Neighbor {
	res := map[string]Neighbor{}
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 6 || !isIPv4(f[0]) {
			continue
		}
		flags, err := strconv.ParseUint(strings.TrimPrefix(f[2], "0x"), 16, 32)
		if err != nil || flags&0x2 == 0 { // 0x2 = ATF_COM (completed entry)
			continue
		}
		if mac := NormalizeMAC(f[3]); mac != "" {
			res[f[0]] = Neighbor{MAC: mac, Reachable: true}
		}
	}
	return res
}

// ParseStateTable parses "ip mac state" lines (the format we ask PowerShell's Get-NetNeighbor for).
func ParseStateTable(out string) map[string]Neighbor {
	res := map[string]Neighbor{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 || !isIPv4(f[0]) {
			continue
		}
		mac := NormalizeMAC(f[1])
		if mac == "" || f[2] == "Unreachable" || f[2] == "Incomplete" {
			continue
		}
		res[f[0]] = Neighbor{MAC: mac, Reachable: f[2] == "Reachable" || f[2] == "Delay" || f[2] == "Probe"}
	}
	return res
}

var arpARe = regexp.MustCompile(`\(?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)?\s+(?:at\s+)?([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})`)

// ParseArpA parses `arp -a` / `arp -an` output (macOS, BSD, Windows).
func ParseArpA(out string) map[string]Neighbor {
	res := map[string]Neighbor{}
	for _, m := range arpARe.FindAllStringSubmatch(out, -1) {
		if mac := NormalizeMAC(m[2]); mac != "" && isIPv4(m[1]) {
			res[m[1]] = Neighbor{MAC: mac, Reachable: true}
		}
	}
	return res
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	out, err := cmd.Output()
	return string(out), err
}

// Neighbors returns the host's current IPv4 neighbour table.
func Neighbors(ctx context.Context) (map[string]Neighbor, error) {
	switch runtime.GOOS {
	case "linux":
		if out, err := run(ctx, "ip", "-4", "neigh", "show"); err == nil {
			return ParseIPNeigh(out), nil
		}
		raw, err := os.ReadFile("/proc/net/arp")
		if err != nil {
			return nil, fmt.Errorf("neighbour table unavailable: %w", err)
		}
		return ParseProcARP(string(raw)), nil
	case "windows":
		out, err := run(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command",
			`Get-NetNeighbor -AddressFamily IPv4 | ForEach-Object { "$($_.IPAddress) $($_.LinkLayerAddress) $($_.State)" }`)
		if err == nil {
			return ParseStateTable(out), nil
		}
		out, err = run(ctx, "arp", "-a")
		if err != nil {
			return nil, fmt.Errorf("neighbour table unavailable: %w", err)
		}
		return ParseArpA(out), nil
	default:
		out, err := run(ctx, "arp", "-an")
		if err != nil {
			return nil, fmt.Errorf("neighbour table unavailable: %w", err)
		}
		return ParseArpA(out), nil
	}
}

// ParseProcRoute extracts the default gateway from /proc/net/route (Linux).
func ParseProcRoute(content string) string {
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 || f[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err != nil || flags&0x2 == 0 { // RTF_GATEWAY
			continue
		}
		gw, err := strconv.ParseUint(f[2], 16, 32)
		if err != nil || gw == 0 {
			continue
		}
		// Stored in host byte order of a little-endian dump: lowest byte is the first octet.
		return fmt.Sprintf("%d.%d.%d.%d", gw&0xff, (gw>>8)&0xff, (gw>>16)&0xff, (gw>>24)&0xff)
	}
	return ""
}

// ParseRoutePrint extracts the default gateway from Windows `route print -4`.
func ParseRoutePrint(out string) string {
	bestGW := ""
	bestMetric := int(^uint(0) >> 1)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 4 && f[0] == "0.0.0.0" && f[1] == "0.0.0.0" && isIPv4(f[2]) {
			metric := int(^uint(0) >> 1)
			if len(f) >= 5 {
				if m, err := strconv.Atoi(f[4]); err == nil && m >= 0 {
					metric = m
				}
			}
			if bestGW == "" || metric < bestMetric {
				bestGW = f[2]
				bestMetric = metric
			}
		}
	}
	return bestGW
}

// ParseRouteGet extracts the default gateway from macOS/BSD `route -n get default`.
func ParseRouteGet(out string) string {
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if v, ok := strings.CutPrefix(line, "gateway:"); ok && isIPv4(strings.TrimSpace(v)) {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// DefaultGateway returns the IPv4 default gateway of this host, or "" when there is none.
func DefaultGateway(ctx context.Context) string {
	switch runtime.GOOS {
	case "linux":
		raw, err := os.ReadFile("/proc/net/route")
		if err != nil {
			return ""
		}
		return ParseProcRoute(string(raw))
	case "windows":
		out, err := run(ctx, "route", "print", "-4")
		if err != nil {
			return ""
		}
		return ParseRoutePrint(out)
	default:
		out, err := run(ctx, "route", "-n", "get", "default")
		if err != nil {
			return ""
		}
		return ParseRouteGet(out)
	}
}

// LocalMACs maps each IPv4 address of this host to the MAC of the interface that carries it.
// A host never appears in its own neighbour table, so this is the only way to know its own MAC.
func LocalMACs() map[string]string {
	out := map[string]string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		mac := NormalizeMAC(i.HardwareAddr.String())
		if mac == "" {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				out[ipn.IP.String()] = mac
			}
		}
	}
	return out
}

// LocalDownAddrs lists IPv4 addresses still configured on this host's interfaces that are NOT up
// (for example a disconnected Wi-Fi adapter). The OS answers pings to them locally, which would
// otherwise make them look like devices on the network.
func LocalDownAddrs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagUp != 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				out = append(out, ipn.IP.String())
			}
		}
	}
	return out
}

// Interface describes one active, non-loopback interface of the collector host.
type Interface struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

func Interfaces() []Interface {
	var out []Interface
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		var list []string
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				list = append(list, ipn.String())
			}
		}
		if len(list) > 0 && len(out) < 32 {
			if len(list) > 16 {
				list = list[:16]
			}
			out = append(out, Interface{Name: i.Name, Addresses: list})
		}
	}
	return out
}
