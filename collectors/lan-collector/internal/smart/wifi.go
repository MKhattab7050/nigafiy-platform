package smart

import (
	"errors"
	"sort"
	"strconv"
	"strings"
)

// Wi-Fi analyzer input: what the collector host's own Wi-Fi adapter reports about its current link
// and the networks it lists. The platform readers (wifi_windows.go: Native Wi-Fi API; wifi_linux.go:
// NetworkManager) fill these; the server does the analysis.

// WiFiNetwork is one access point (BSSID) the adapter hears.
type WiFiNetwork struct {
	SSID         string `json:"ssid"`
	BSSID        string `json:"bssid"`
	Channel      int    `json:"channel,omitempty"`
	Band         string `json:"band,omitempty"`
	FrequencyMHz int    `json:"frequency_mhz,omitempty"`
	SignalPct    *int   `json:"signal_pct,omitempty"`
	RSSIdBm      *int   `json:"rssi_dbm,omitempty"`
	Security     string `json:"security,omitempty"`
	Auth         string `json:"auth,omitempty"`
	Cipher       string `json:"cipher,omitempty"`
}

// WiFiLink is the network the adapter is connected to, with its negotiated rates.
type WiFiLink struct {
	WiFiNetwork
	RxMbps *float64 `json:"rx_mbps,omitempty"`
	TxMbps *float64 `json:"tx_mbps,omitempty"`
	PHY    string   `json:"phy,omitempty"`
}

// WiFiReport is one reading.
type WiFiReport struct {
	Platform  string        `json:"platform"`
	Interface string        `json:"interface,omitempty"`
	Connected bool          `json:"connected"`
	Link      *WiFiLink     `json:"link,omitempty"`
	Networks  []WiFiNetwork `json:"networks"`
	Truncated bool          `json:"truncated,omitempty"`
}

// WiFiError says why the Wi-Fi could not be read; Kind is one of the protocol's error kinds.
type WiFiError struct {
	Kind    string
	Message string
}

func (e *WiFiError) Error() string { return e.Message }

// ErrNoWiFi: the host has no Wi-Fi adapter (or it is off).
var ErrNoWiFi = &WiFiError{Kind: "no_interface", Message: "this host has no Wi-Fi adapter that is turned on"}

const maxNetworks = 256

// ChannelOf converts a centre frequency in MHz to (channel, band).
func ChannelOf(mhz int) (int, string) {
	switch {
	case mhz == 2484:
		return 14, "2.4"
	case mhz >= 2412 && mhz <= 2472:
		return (mhz - 2407) / 5, "2.4"
	case mhz >= 5955 && mhz <= 7115:
		return (mhz - 5950) / 5, "6"
	case mhz >= 5150 && mhz <= 5925:
		return (mhz - 5000) / 5, "5"
	}
	return 0, ""
}

// Security labels shared by every platform reader (the server classifies them with regexes).
func securityLabel(wpa3, wpa2, wpa1, enterprise, owe, privacy bool) (security, auth string) {
	switch {
	case owe:
		return "Enhanced Open (OWE)", "OWE"
	case wpa3 && wpa2 && !enterprise:
		return "WPA2/WPA3-Personal", "WPA2-PSK+SAE"
	case wpa3 && enterprise:
		return "WPA3-Enterprise", "802.1X"
	case wpa3:
		return "WPA3-Personal", "SAE"
	case wpa2 && enterprise:
		return "WPA2-Enterprise", "802.1X"
	case wpa2:
		return "WPA2-Personal", "WPA2-PSK"
	case wpa1 && enterprise:
		return "WPA-Enterprise", "WPA-802.1X"
	case wpa1:
		return "WPA-Personal", "WPA-PSK"
	case privacy:
		return "WEP", "WEP"
	}
	return "Open", "Open"
}

var cipherNames = map[byte]string{1: "WEP-40", 2: "TKIP", 4: "CCMP", 5: "WEP-104", 8: "GCMP", 9: "GCMP-256", 10: "CCMP-256"}

type suites struct {
	pairwise []string
	akm      []byte
}

// parseSuites reads the cipher/AKM lists of an RSN (IE 48) or WPA (vendor IE) body that starts at the version field.
func parseSuites(b []byte) (suites, bool) {
	var s suites
	if len(b) < 2 {
		return s, false
	}
	b = b[2:] // version
	if len(b) >= 4 {
		b = b[4:] // group cipher
	} else {
		return s, true
	}
	if len(b) >= 2 {
		n := int(b[0]) | int(b[1])<<8
		b = b[2:]
		for i := 0; i < n && len(b) >= 4; i++ {
			if name, ok := cipherNames[b[3]]; ok {
				s.pairwise = append(s.pairwise, name)
			}
			b = b[4:]
		}
	}
	if len(b) >= 2 {
		n := int(b[0]) | int(b[1])<<8
		b = b[2:]
		for i := 0; i < n && len(b) >= 4; i++ {
			s.akm = append(s.akm, b[3])
			b = b[4:]
		}
	}
	return s, true
}

// SecurityFromIEs derives security, authentication and cipher from a beacon's information elements
// and the privacy capability bit.
func SecurityFromIEs(ies []byte, privacy bool) (security, auth, cipher string) {
	var rsn, wpa *suites
	for len(ies) >= 2 {
		id, n := ies[0], int(ies[1])
		if len(ies) < 2+n {
			break
		}
		body := ies[2 : 2+n]
		switch {
		case id == 48:
			if s, ok := parseSuites(body); ok {
				rsn = &s
			}
		case id == 221 && n >= 4 && body[0] == 0x00 && body[1] == 0x50 && body[2] == 0xf2 && body[3] == 1:
			if s, ok := parseSuites(body[4:]); ok {
				wpa = &s
			}
		}
		ies = ies[2+n:]
	}
	var wpa3, wpa2, wpa1, enterprise, owe bool
	var ciphers []string
	if rsn != nil {
		ciphers = rsn.pairwise
		for _, a := range rsn.akm {
			switch a {
			case 1, 3, 5, 11, 12, 13:
				enterprise = true
				wpa2 = wpa2 || a != 12 && a != 13
				wpa3 = wpa3 || a == 12 || a == 13
			case 2, 4, 6:
				wpa2 = true
			case 8, 9, 24, 25:
				wpa3 = true
			case 18:
				owe = true
			}
		}
		if len(rsn.akm) == 0 {
			wpa2 = true
		}
	}
	if wpa != nil {
		wpa1 = true
		if len(ciphers) == 0 {
			ciphers = wpa.pairwise
		}
		for _, a := range wpa.akm {
			if a == 1 {
				enterprise = true
			}
		}
	}
	security, auth = securityLabel(wpa3, wpa2, wpa1, enterprise, owe, privacy)
	switch {
	case len(ciphers) > 0:
		cipher = strings.Join(dedupe(ciphers), "+")
	case security == "WEP":
		cipher = "WEP"
	case security == "Open":
		cipher = "None"
	}
	return security, auth, cipher
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ── NetworkManager (Linux) ──

// SplitNmcliTerse splits one line of `nmcli -t` output (':' separated, '\:' and '\\' escaped).
func SplitNmcliTerse(line string) []string {
	var out []string
	var cur strings.Builder
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '\\' && i+1 < len(line) {
			cur.WriteByte(line[i+1])
			i++
			continue
		}
		if c == ':' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(out, cur.String())
}

// ParseNmcliWifi parses `nmcli -t -f IN-USE,SSID,BSSID,FREQ,SIGNAL,SECURITY,RATE device wifi list`.
// The line marked in use is the link. FREQ is like "2437 MHz", RATE like "130 Mbit/s".
func ParseNmcliWifi(out string) (WiFiReport, error) {
	r := WiFiReport{Platform: "linux", Networks: []WiFiNetwork{}}
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := SplitNmcliTerse(line)
		if len(f) < 7 {
			return r, errors.New("unexpected nmcli output")
		}
		mac := strings.ToLower(strings.TrimSpace(f[2]))
		if len(mac) != 17 {
			continue
		}
		n := WiFiNetwork{SSID: cleanText(f[1], 64), BSSID: mac}
		if mhz, err := strconv.Atoi(strings.Fields(f[3] + " 0")[0]); err == nil && mhz > 0 {
			n.FrequencyMHz = mhz
			n.Channel, n.Band = ChannelOf(mhz)
		}
		if pct, err := strconv.Atoi(strings.TrimSpace(f[4])); err == nil && pct >= 0 && pct <= 100 {
			n.SignalPct = &pct
		}
		sec := strings.TrimSpace(f[5])
		n.Security, n.Auth, n.Cipher = nmcliSecurity(sec)
		if strings.TrimSpace(f[0]) == "*" && r.Link == nil {
			link := &WiFiLink{WiFiNetwork: n}
			if rate, err := strconv.ParseFloat(strings.Fields(f[6] + " 0")[0], 64); err == nil && rate > 0 {
				link.RxMbps, link.TxMbps = &rate, &rate
			}
			r.Link, r.Connected = link, true
		}
		if len(r.Networks) >= maxNetworks {
			r.Truncated = true
			continue
		}
		r.Networks = append(r.Networks, n)
	}
	sort.SliceStable(r.Networks, func(i, j int) bool { return r.Networks[i].BSSID < r.Networks[j].BSSID })
	return r, nil
}

// nmcliSecurity maps NetworkManager's SECURITY column ("WPA2", "WPA1 WPA2", "WPA3", "WEP", "", "WPA2 802.1X").
func nmcliSecurity(s string) (security, auth, cipher string) {
	u := strings.ToUpper(s)
	wpa3 := strings.Contains(u, "WPA3") || strings.Contains(u, "SAE")
	wpa2 := strings.Contains(u, "WPA2")
	wpa1 := strings.Contains(u, "WPA1") || (strings.Contains(u, "WPA") && !wpa2 && !wpa3)
	enterprise := strings.Contains(u, "802.1X") || strings.Contains(u, "EAP")
	owe := strings.Contains(u, "OWE")
	wep := strings.Contains(u, "WEP")
	security, auth = securityLabel(wpa3, wpa2, wpa1 && !wpa2 && !wpa3, enterprise, owe, wep)
	if security == "Open" {
		cipher = "None"
	}
	return security, auth, cipher
}
