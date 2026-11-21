//go:build windows

package smart

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows: the Native Wi-Fi API (wlanapi.dll) — the same source `netsh wlan` reads, but in
// structures rather than localized text, with the signal in dBm. Only cached results are read
// (the BSS list the adapter keeps from its own background scans); no scan is triggered.
//
// Windows 11 24H2 and later only give BSSIDs and nearby networks to apps allowed to use location:
// when the list comes back empty or access is denied, the error says so.

var (
	wlanapi                    = windows.NewLazySystemDLL("wlanapi.dll")
	procWlanOpenHandle         = wlanapi.NewProc("WlanOpenHandle")
	procWlanCloseHandle        = wlanapi.NewProc("WlanCloseHandle")
	procWlanEnumInterfaces     = wlanapi.NewProc("WlanEnumInterfaces")
	procWlanGetNetworkBssList  = wlanapi.NewProc("WlanGetNetworkBssList")
	procWlanQueryInterface     = wlanapi.NewProc("WlanQueryInterface")
	procWlanFreeMemory         = wlanapi.NewProc("WlanFreeMemory")
)

const (
	wlanIntfOpcodeCurrentConnection = 7
	wlanInterfaceStateConnected     = 1
	dot11BssTypeAny                 = 3
	errorInvalidState               = 5023
	errorServiceNotActive           = 1062
	errorAccessDenied               = 5

	sizeofInterfaceInfo = 16 + 512 + 4 // GUID + WCHAR[256] + state
	sizeofBssEntry      = 360
)

type guid [16]byte

func wlanErr(op string, r uintptr) error {
	switch r {
	case errorServiceNotActive:
		return &WiFiError{Kind: "not_supported", Message: "the WLAN AutoConfig service is not running (no Wi-Fi on this host)"}
	case errorAccessDenied:
		return &WiFiError{Kind: "not_supported", Message: "Windows denied access to Wi-Fi information: allow location access for desktop apps (Settings → Privacy & security → Location)"}
	}
	return &WiFiError{Kind: "command_failed", Message: fmt.Sprintf("%s failed: %s", op, syscall.Errno(r).Error())}
}

// ReadWiFi reads the first Wi-Fi adapter's link and the networks it lists.
func ReadWiFi(ctx context.Context) (WiFiReport, error) {
	if err := wlanapi.Load(); err != nil {
		return WiFiReport{}, &WiFiError{Kind: "not_supported", Message: "the Native Wi-Fi API (wlanapi.dll) is not available on this Windows edition"}
	}
	var negotiated uint32
	var h windows.Handle
	if r, _, _ := procWlanOpenHandle.Call(2, 0, uintptr(unsafe.Pointer(&negotiated)), uintptr(unsafe.Pointer(&h))); r != 0 {
		return WiFiReport{}, wlanErr("WlanOpenHandle", r)
	}
	defer procWlanCloseHandle.Call(uintptr(h), 0)

	var list unsafe.Pointer
	if r, _, _ := procWlanEnumInterfaces.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&list))); r != 0 {
		return WiFiReport{}, wlanErr("WlanEnumInterfaces", r)
	}
	defer procWlanFreeMemory.Call(uintptr(list))
	count := *(*uint32)(list)
	if count == 0 {
		return WiFiReport{}, ErrNoWiFi
	}
	// Prefer a connected adapter.
	infos := unsafe.Slice((*byte)(unsafe.Add(list, 8)), int(count)*sizeofInterfaceInfo)
	pick := 0
	for i := 0; i < int(count); i++ {
		state := binary.LittleEndian.Uint32(infos[i*sizeofInterfaceInfo+528:])
		if state == wlanInterfaceStateConnected {
			pick = i
			break
		}
	}
	entry := infos[pick*sizeofInterfaceInfo : (pick+1)*sizeofInterfaceInfo]
	var g guid
	copy(g[:], entry[:16])
	desc := utf16z(entry[16:528])

	report := WiFiReport{Platform: "windows", Interface: cleanText(desc, 120), Networks: []WiFiNetwork{}}
	freqOf := map[string]int{}

	var bss unsafe.Pointer
	if r, _, _ := procWlanGetNetworkBssList.Call(uintptr(h), uintptr(unsafe.Pointer(&g)), 0, dot11BssTypeAny, 0, 0, uintptr(unsafe.Pointer(&bss))); r == 0 {
		total := *(*uint32)(bss)
		n := *(*uint32)(unsafe.Add(bss, 4))
		raw := unsafe.Slice((*byte)(bss), int(total))
		for i := 0; i < int(n) && ctx.Err() == nil; i++ {
			off := 8 + i*sizeofBssEntry
			if off+sizeofBssEntry > len(raw) {
				break
			}
			nw, ok := parseBssEntry(raw, off)
			if !ok {
				continue
			}
			freqOf[nw.BSSID] = nw.FrequencyMHz
			if len(report.Networks) >= maxNetworks {
				report.Truncated = true
				continue
			}
			report.Networks = append(report.Networks, nw)
		}
		procWlanFreeMemory.Call(uintptr(bss))
	} else if r == errorAccessDenied {
		return report, wlanErr("WlanGetNetworkBssList", r)
	}

	var size uint32
	var data unsafe.Pointer
	var valueType uint32
	r, _, _ := procWlanQueryInterface.Call(uintptr(h), uintptr(unsafe.Pointer(&g)), wlanIntfOpcodeCurrentConnection, 0,
		uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&valueType)))
	switch {
	case r == errorInvalidState:
		return report, nil // not connected
	case r != 0:
		return report, wlanErr("WlanQueryInterface", r)
	}
	defer procWlanFreeMemory.Call(uintptr(data))
	if size < 604 {
		return report, &WiFiError{Kind: "protocol", Message: "unexpected connection attributes from the Native Wi-Fi API"}
	}
	attrs := unsafe.Slice((*byte)(data), int(size))
	link := parseConnection(attrs)
	if f, ok := freqOf[link.BSSID]; ok && f > 0 {
		link.FrequencyMHz = f
		link.Channel, link.Band = ChannelOf(f)
	}
	// Security of the link as the beacon announces it (same labels as the neighbours) when listed.
	for _, n := range report.Networks {
		if n.BSSID == link.BSSID {
			link.Security, link.Auth, link.Cipher = n.Security, n.Auth, n.Cipher
			if link.RSSIdBm == nil {
				link.RSSIdBm = n.RSSIdBm
			}
		}
	}
	report.Link, report.Connected = &link, true
	return report, nil
}

func utf16z(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return windows.UTF16ToString(u)
}

func ssidOf(b []byte) string {
	n := int(binary.LittleEndian.Uint32(b[0:4]))
	if n > 32 {
		n = 32
	}
	return cleanText(string(b[4:4+n]), 64)
}

// parseBssEntry reads one WLAN_BSS_ENTRY (360 bytes) at off; its IEs follow at off+ulIeOffset.
func parseBssEntry(raw []byte, off int) (WiFiNetwork, bool) {
	e := raw[off : off+sizeofBssEntry]
	mac := net.HardwareAddr(e[40:46]).String()
	if mac == "00:00:00:00:00:00" {
		return WiFiNetwork{}, false
	}
	n := WiFiNetwork{SSID: ssidOf(e[0:36]), BSSID: mac}
	rssi := int(int32(binary.LittleEndian.Uint32(e[56:60])))
	if rssi >= -120 && rssi <= 0 {
		n.RSSIdBm = &rssi
	}
	if q := int(binary.LittleEndian.Uint32(e[60:64])); q <= 100 {
		n.SignalPct = &q
	}
	caps := binary.LittleEndian.Uint16(e[88:90])
	khz := int(binary.LittleEndian.Uint32(e[92:96]))
	if khz > 0 {
		n.FrequencyMHz = khz / 1000
		n.Channel, n.Band = ChannelOf(n.FrequencyMHz)
		if n.Band == "" {
			n.FrequencyMHz = 0
		}
	}
	ieOff := int(binary.LittleEndian.Uint32(e[352:356]))
	ieSize := int(binary.LittleEndian.Uint32(e[356:360]))
	var ies []byte
	if ieOff > 0 && ieSize > 0 && off+ieOff+ieSize <= len(raw) {
		ies = raw[off+ieOff : off+ieOff+ieSize]
	}
	n.Security, n.Auth, n.Cipher = SecurityFromIEs(ies, caps&0x0010 != 0)
	return n, true
}

var phyNames = map[uint32]string{4: "802.11a", 5: "802.11b", 6: "802.11g", 7: "802.11n", 8: "802.11ac", 10: "802.11ax", 11: "802.11be"}
var authNames = map[uint32]string{1: "Open", 2: "Shared key (WEP)", 3: "WPA-Enterprise", 4: "WPA-PSK", 6: "WPA2-Enterprise", 7: "WPA2-PSK", 8: "WPA3-Enterprise 192-bit", 9: "WPA3-SAE", 10: "OWE", 11: "WPA3-Enterprise"}
var cipherAlgo = map[uint32]string{0: "None", 1: "WEP-40", 2: "TKIP", 4: "CCMP", 5: "WEP-104", 8: "GCMP", 9: "GCMP-256", 10: "CCMP-256", 0x101: "WEP"}

// parseConnection reads WLAN_CONNECTION_ATTRIBUTES: association attributes at 520, security at 588.
func parseConnection(a []byte) WiFiLink {
	assoc := a[520:588]
	l := WiFiLink{WiFiNetwork: WiFiNetwork{SSID: ssidOf(assoc[0:36]), BSSID: net.HardwareAddr(assoc[40:46]).String()}}
	if phy, ok := phyNames[binary.LittleEndian.Uint32(assoc[48:52])]; ok {
		l.PHY = phy
	}
	if q := int(binary.LittleEndian.Uint32(assoc[56:60])); q <= 100 {
		l.SignalPct = &q
	}
	rx := float64(binary.LittleEndian.Uint32(assoc[60:64])) / 1000
	tx := float64(binary.LittleEndian.Uint32(assoc[64:68])) / 1000
	if rx > 0 {
		l.RxMbps = &rx
	}
	if tx > 0 {
		l.TxMbps = &tx
	}
	sec := a[588:604]
	enabled := binary.LittleEndian.Uint32(sec[0:4]) != 0
	auth := authNames[binary.LittleEndian.Uint32(sec[8:12])]
	cipher := cipherAlgo[binary.LittleEndian.Uint32(sec[12:16])]
	if !enabled {
		auth, cipher = "Open", "None"
	}
	l.Auth, l.Cipher = auth, cipher
	switch auth {
	case "WPA2-PSK":
		l.Security = "WPA2-Personal"
	case "WPA-PSK":
		l.Security = "WPA-Personal"
	case "WPA3-SAE":
		l.Security = "WPA3-Personal"
	case "Open":
		l.Security = "Open"
	default:
		l.Security = auth
	}
	return l
}
