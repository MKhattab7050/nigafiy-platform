package smart

import (
	"reflect"
	"testing"
)

func TestChannelOf(t *testing.T) {
	cases := []struct {
		mhz     int
		channel int
		band    string
	}{
		{2412, 1, "2.4"}, {2437, 6, "2.4"}, {2472, 13, "2.4"}, {2484, 14, "2.4"},
		{5180, 36, "5"}, {5500, 100, "5"}, {5825, 165, "5"},
		{5935, 2, "6"}, {5955, 1, "6"}, {6115, 33, "6"}, {7115, 233, "6"},
		{2400, 0, ""}, {0, 0, ""}, {7200, 0, ""},
	}
	for _, c := range cases {
		if ch, band := ChannelOf(c.mhz); ch != c.channel || band != c.band {
			t.Errorf("ChannelOf(%d) = %d %q, want %d %q", c.mhz, ch, band, c.channel, c.band)
		}
	}
}

func TestSecurityFromIEs(t *testing.T) {
	sec, auth, cipher := SecurityFromIEs(readHex(t, "beacon_ies_wpa2_wpa3.hex"), true)
	if sec != "WPA2/WPA3-Personal" || auth != "WPA2-PSK+SAE" || cipher != "CCMP" {
		t.Errorf("WPA2/WPA3 transition: %q %q %q", sec, auth, cipher)
	}
	sec, auth, cipher = SecurityFromIEs(readHex(t, "beacon_ies_wpa_tkip.hex"), true)
	if sec != "WPA-Personal" || auth != "WPA-PSK" || cipher != "TKIP" {
		t.Errorf("WPA/TKIP: %q %q %q", sec, auth, cipher)
	}
	// FT-SAE only (AKM 9) is WPA3.
	ftsae := []byte{48, 14, 1, 0, 0, 0x0f, 0xac, 4, 1, 0, 0, 0x0f, 0xac, 4, 1, 0, 0, 0x0f, 0xac, 9}
	ftsae[1] = byte(len(ftsae) - 2)
	if sec, auth, _ := SecurityFromIEs(ftsae, true); sec != "WPA3-Personal" || auth != "SAE" {
		t.Errorf("FT-SAE: %q %q", sec, auth)
	}
	if sec, _, cipher := SecurityFromIEs(nil, true); sec != "WEP" || cipher != "WEP" {
		t.Errorf("privacy bit only: %q %q", sec, cipher)
	}
	if sec, _, cipher := SecurityFromIEs([]byte{0, 3, 'a', 'b', 'c'}, false); sec != "Open" || cipher != "None" {
		t.Errorf("open: %q %q", sec, cipher)
	}
	// A truncated element stops parsing without a panic.
	if sec, _, _ := SecurityFromIEs([]byte{48, 40, 1, 0}, false); sec != "Open" {
		t.Errorf("truncated RSN: %q", sec)
	}
}

func TestSplitNmcliTerse(t *testing.T) {
	got := SplitNmcliTerse(`*:Cafe\: Free\\Wifi:AA\:BB::x`)
	want := []string{"*", `Cafe: Free\Wifi`, "AA:BB", "", "x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestParseNmcliWifiEscapedColons(t *testing.T) {
	r, err := ParseNmcliWifi(string(fixture(t, "nmcli_wifi.txt")))
	if err != nil {
		t.Fatal(err)
	}
	if r.Platform != "linux" || !r.Connected || r.Link == nil || len(r.Networks) != 5 {
		t.Fatalf("got %+v", r)
	}
	l := r.Link
	if l.SSID != "HomeNet" || l.BSSID != "aa:bb:cc:00:11:22" || l.Channel != 36 || l.Band != "5" || l.FrequencyMHz != 5180 ||
		*l.SignalPct != 78 || *l.RxMbps != 866 || l.Security != "WPA2/WPA3-Personal" {
		t.Fatalf("link %+v", l)
	}
	byBSSID := map[string]WiFiNetwork{}
	for _, n := range r.Networks {
		byBSSID[n.BSSID] = n
	}
	cafe := byBSSID["de:ad:be:ef:00:01"]
	if cafe.SSID != `Cafe: Free\Wifi` || cafe.Channel != 1 || cafe.Security != "Open" || cafe.Cipher != "None" {
		t.Errorf("escaped SSID network %+v", cafe)
	}
	if corp := byBSSID["de:ad:be:ef:00:02"]; corp.Band != "6" || corp.Channel != 1 || corp.Security != "WPA2-Enterprise" {
		t.Errorf("6 GHz enterprise %+v", corp)
	}
	if hidden := byBSSID["de:ad:be:ef:00:03"]; hidden.SSID != "" || hidden.Security != "WPA-Personal" {
		t.Errorf("hidden WPA1 %+v", hidden)
	}
	if _, err := ParseNmcliWifi("garbage line\n"); err == nil {
		t.Error("unexpected output was accepted")
	}
}

func TestNormalizeDropsWhatTheProtocolCannotCarry(t *testing.T) {
	q := 50
	r := WiFiReport{Platform: "windows", Connected: true,
		Link: &WiFiLink{WiFiNetwork: WiFiNetwork{BSSID: "aa:bb:cc:00:00:01", SignalPct: &q}},
		Networks: []WiFiNetwork{
			{BSSID: "aa:bb:cc:00:00:01"},
			{BSSID: "aa:bb:cc:00:00:02", FrequencyMHz: 2437, Channel: 6, Band: "2.4"},
		}}
	r.Normalize()
	if r.Link != nil || !r.Connected || len(r.Networks) != 1 || r.Networks[0].BSSID != "aa:bb:cc:00:00:02" {
		t.Fatalf("got %+v", r)
	}
	empty := WiFiReport{Platform: "linux"}
	empty.Normalize()
	if empty.Networks == nil {
		t.Error("networks must encode as [] not null")
	}
}
