// Package huaweilte drives Huawei 4G/5G Home CPE routers (B315, B525, B535, B818, H122, H155 —
// widely used across STC, Zain, Mobily, Vodafone, WE and Orange Home 4G/5G) over the HiLink XML API.
// It registers itself as vendor "huawei_lte".
//
// Mechanisms used:
//   - session:  GET /api/webserver/SesTokInfo → SessionID cookie + __RequestVerificationToken
//   - login:    POST /api/user/login (password_type=4: Base64(hex(SHA256(user + Base64(hex(SHA256(pass))) + token))))
//   - identify: GET /api/device/information
//   - clients:  GET /api/wlan/host-list
//   - block:    GET/POST /api/wlan/multi-macfilter-settings (deny/blacklist mode WifiMacFilterStatus=2;
//               refuses to overwrite an administrator's whitelist mode WifiMacFilterStatus=1)
//   - logout:   POST /api/user/logout.
package huaweilte

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"net/http"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "huawei_lte"

const (
	mechBlock = "Huawei HiLink WLAN MAC blacklist (/api/wlan/multi-macfilter-settings)"
	maxSlots  = 10
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one Huawei 4G/5G HiLink CPE router.
type Driver struct {
	target   router.Target
	base     string
	http     *http.Client
	creds    router.CredentialSource
	sesInfo  []byte
	tokInfo  []byte
	loggedIn bool
	info     *router.Info
}

// New builds a Huawei HiLink 4G/5G driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	router.Zero(d.sesInfo)
	router.Zero(d.tokInfo)
	d.sesInfo = nil
	d.tokInfo = nil
	d.loggedIn = false
}

func (d *Driver) rawDo(ctx context.Context, op, method, path string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	if len(d.sesInfo) > 0 {
		req.Header.Set("Cookie", string(d.sesInfo))
	}
	if len(d.tokInfo) > 0 && method != http.MethodGet {
		req.Header.Set("__RequestVerificationToken", string(d.tokInfo))
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return 0, nil, router.TransportError(op, err)
	}
	defer resp.Body.Close()
	raw, err := router.ReadBody(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	for _, c := range resp.Cookies() {
		if c.Name == "SessionID" {
			router.Zero(d.sesInfo)
			d.sesInfo = []byte("SessionID=" + c.Value)
		}
	}
	if tok := resp.Header.Get("__RequestVerificationToken"); tok != "" {
		// HiLink may return multiple '#' separated tokens; use the first.
		firstTok := strings.SplitN(tok, "#", 2)[0]
		if firstTok != "" {
			router.Zero(d.tokInfo)
			d.tokInfo = []byte(firstTok)
		}
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) refreshSesTok(ctx context.Context, op string) error {
	st, raw, err := d.rawDo(ctx, op, http.MethodGet, "/api/webserver/SesTokInfo", nil)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrProtocol, op, "SesTokInfo returned HTTP %d", st)
	}
	var res struct {
		SesInfo string `xml:"SesInfo"`
		TokInfo string `xml:"TokInfo"`
	}
	if err := xml.Unmarshal(raw, &res); err != nil || res.TokInfo == "" {
		return router.Errorf(router.ErrProtocol, op, "not a Huawei HiLink SesTokInfo response")
	}
	if res.SesInfo != "" {
		router.Zero(d.sesInfo)
		d.sesInfo = []byte(res.SesInfo)
	}
	router.Zero(d.tokInfo)
	d.tokInfo = []byte(res.TokInfo)
	return nil
}

func hiLinkPasswordType4(user string, pass []byte, token string) string {
	h1 := sha256.Sum256(pass)
	b1 := base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(h1[:])))
	combined := user + b1 + token
	h2 := sha256.Sum256([]byte(combined))
	return base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(h2[:])))
}

func parseHiLinkError(raw []byte) (int, bool) {
	var e struct {
		XMLName xml.Name `xml:"error"`
		Code    int      `xml:"code"`
	}
	if xml.Unmarshal(raw, &e) == nil && e.XMLName.Local == "error" {
		return e.Code, true
	}
	return 0, false
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	if err := d.refreshSesTok(ctx, "login"); err != nil {
		return err
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	pwHash := hiLinkPasswordType4(user, pass, string(d.tokInfo))
	body := []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><request><Username>%s</Username><Password>%s</Password><password_type>4</password_type></request>`,
		xmlEscape(user), pwHash))
	defer router.Zero(body)

	st, raw, err := d.rawDo(ctx, "login", http.MethodPost, "/api/user/login", body)
	if err != nil {
		return err
	}
	if code, isErr := parseHiLinkError(raw); isErr {
		switch code {
		case 108003, 108007:
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: fmt.Sprintf("HiLink lockout (code %d)", code)}
		case 108002, 108006:
			return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("HiLink rejected credentials (code %d)", code)}
		default:
			return router.Errorf(router.ErrBadCredentials, "login", "HiLink login error %d", code)
		}
	}
	if st != http.StatusOK || !strings.Contains(string(raw), "OK") {
		return router.Errorf(router.ErrProtocol, "login", "unexpected HiLink login reply (HTTP %d)", st)
	}
	d.loggedIn = true
	return nil
}

func (d *Driver) getXML(ctx context.Context, op, path string) ([]byte, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	st, raw, err := d.rawDo(ctx, op, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if code, isErr := parseHiLinkError(raw); isErr && (code == 125002 || code == 125003 || code == 100003) {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		st, raw, err = d.rawDo(ctx, op, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
	}
	if code, isErr := parseHiLinkError(raw); isErr {
		return nil, router.Errorf(router.ErrRejected, op, "HiLink error %d", code)
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "%s returned HTTP %d", path, st)
	}
	return raw, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	raw, err := d.getXML(ctx, "identify", "/api/device/information")
	if err != nil {
		return router.Info{}, err
	}
	var dev struct {
		DeviceName      string `xml:"DeviceName"`
		SoftwareVersion string `xml:"SoftwareVersion"`
		HardwareVersion string `xml:"HardwareVersion"`
		SerialNumber    string `xml:"SerialNumber"`
		WebUIVersion    string `xml:"WebUIVersion"`
	}
	if err := xml.Unmarshal(raw, &dev); err != nil || dev.DeviceName == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unreadable HiLink device information")
	}
	info := router.Info{
		Vendor:   "Huawei (4G/5G CPE)",
		Model:    dev.DeviceName,
		Firmware: dev.SoftwareVersion,
		Extra:    map[string]string{},
	}
	if dev.HardwareVersion != "" {
		info.Extra["hardware"] = dev.HardwareVersion
	}
	if dev.SerialNumber != "" {
		info.Extra["serial"] = dev.SerialNumber
	}
	d.info = &info
	return info, nil
}

func (d *Driver) Capabilities(ctx context.Context) (router.Capabilities, error) {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return nil, err
		}
	}
	return router.Capabilities{
		{Capability: router.CapClients, Supported: true, Mechanism: "Huawei HiLink /api/wlan/host-list"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "HiLink host-list reports associated duration rather than lease remaining"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Blocks Wi-Fi MACs in blacklist mode (up to 10 slots per SSID); never alters whitelist mode"},
		{Capability: router.CapRateLimit, Supported: false, Note: "Huawei HiLink 4G/5G CPEs do not expose per-MAC speed limits"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not exposed via HiLink XML API"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: false, Note: "HiLink 4G/5G CPEs do not expose a uniform static DHCP reservation endpoint"},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward, Note: "Supports single-port virtual server entries"},
		{Capability: router.CapRename, Supported: false, Note: "HiLink host-list device names are read-only"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	raw, err := d.getXML(ctx, "clients", "/api/wlan/host-list")
	if err != nil {
		return nil, err
	}
	var resp struct {
		Hosts []struct {
			ID             string `xml:"ID"`
			MacAddress     string `xml:"MacAddress"`
			IpAddress      string `xml:"IpAddress"`
			HostName       string `xml:"HostName"`
			AssociatedTime string `xml:"AssociatedTime"`
			Active         string `xml:"Active"`
		} `xml:"Hosts>Host"`
	}
	if err := xml.Unmarshal(raw, &resp); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "clients", "unreadable HiLink host-list XML")
	}
	blockedMACs := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedMACs[b.MAC] = true
		}
	}
	var out []router.Client
	for _, h := range resp.Hosts {
		mac, err := router.NormalizeMAC(h.MacAddress)
		if err != nil {
			continue
		}
		active := h.Active == "" || h.Active == "1"
		blk := blockedMACs[mac]
		// HiLink may report comma-separated IPv4/IPv6; keep first IPv4.
		ip := strings.Split(h.IpAddress, ";")[0]
		out = append(out, router.Client{
			MAC:        mac,
			IP:         strings.TrimSpace(ip),
			Hostname:   strings.TrimSpace(h.HostName),
			Connection: router.ConnWiFi,
			Active:     &active,
			Blocked:    &blk,
			Raw: map[string]string{
				"MacAddress":     h.MacAddress,
				"IpAddress":      h.IpAddress,
				"HostName":       h.HostName,
				"AssociatedTime": h.AssociatedTime,
			},
		})
	}
	router.SortClients(out)
	return out, nil
}

type ssidFilter struct {
	Index  string   `xml:"Index"`
	Status string   `xml:"WifiMacFilterStatus"` // 0=off, 1=allow/whitelist, 2=deny/blacklist
	MACs   [10]string
}

func parseMultiMacFilter(raw []byte) ([]ssidFilter, error) {
	type rawSSID struct {
		Index  string `xml:"Index"`
		Status string `xml:"WifiMacFilterStatus"`
		M0     string `xml:"WifiMacFilterMac0"`
		M1     string `xml:"WifiMacFilterMac1"`
		M2     string `xml:"WifiMacFilterMac2"`
		M3     string `xml:"WifiMacFilterMac3"`
		M4     string `xml:"WifiMacFilterMac4"`
		M5     string `xml:"WifiMacFilterMac5"`
		M6     string `xml:"WifiMacFilterMac6"`
		M7     string `xml:"WifiMacFilterMac7"`
		M8     string `xml:"WifiMacFilterMac8"`
		M9     string `xml:"WifiMacFilterMac9"`
	}
	var doc struct {
		Ssids []rawSSID `xml:"Ssids>Ssid"`
	}
	if err := xml.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make([]ssidFilter, 0, len(doc.Ssids))
	for _, s := range doc.Ssids {
		out = append(out, ssidFilter{
			Index:  s.Index,
			Status: s.Status,
			MACs:   [10]string{s.M0, s.M1, s.M2, s.M3, s.M4, s.M5, s.M6, s.M7, s.M8, s.M9},
		})
	}
	return out, nil
}

func renderMultiMacFilter(ssids []ssidFilter) []byte {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><request><Ssids>`)
	for _, s := range ssids {
		b.WriteString(`<Ssid>`)
		if s.Index != "" {
			fmt.Fprintf(&b, `<Index>%s</Index>`, xmlEscape(s.Index))
		}
		fmt.Fprintf(&b, `<WifiMacFilterStatus>%s</WifiMacFilterStatus>`, xmlEscape(s.Status))
		for i, m := range s.MACs {
			fmt.Fprintf(&b, `<WifiMacFilterMac%d>%s</WifiMacFilterMac%d>`, i, xmlEscape(m), i)
		}
		b.WriteString(`</Ssid>`)
	}
	b.WriteString(`</Ssids></request>`)
	return b.Bytes()
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	raw, err := d.getXML(ctx, "blocked", "/api/wlan/multi-macfilter-settings")
	if err != nil {
		return nil, err
	}
	ssids, err := parseMultiMacFilter(raw)
	if err != nil {
		return nil, router.Errorf(router.ErrProtocol, "blocked", "unreadable multi-macfilter-settings XML")
	}
	seen := map[string]bool{}
	var out []router.BlockEntry
	for _, s := range ssids {
		if s.Status != "2" {
			continue
		}
		for _, rawM := range s.MACs {
			m, err := router.NormalizeMAC(rawM)
			if err != nil || seen[m] {
				continue
			}
			seen[m] = true
			out = append(out, router.BlockEntry{
				MAC:       m,
				Mechanism: mechBlock,
				Owner:     router.OwnerUnknown, // HiLink stores only MAC slots without comments.
				Managed:   true,
			})
		}
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	raw, err := d.getXML(ctx, "block", "/api/wlan/multi-macfilter-settings")
	if err != nil {
		return router.Change{}, err
	}
	ssids, err := parseMultiMacFilter(raw)
	if err != nil || len(ssids) == 0 {
		return router.Change{}, router.Errorf(router.ErrProtocol, "block", "unreadable HiLink MAC filter table")
	}
	for _, s := range ssids {
		if s.Status == "1" {
			return router.Change{}, router.Errorf(router.ErrRejected, "block", "HiLink WLAN MAC filter is in Allow (Whitelist) mode; refusing to overwrite administrator policy")
		}
	}
	alreadyAll := true
	for i := range ssids {
		found := false
		freeIdx := -1
		for j, cur := range ssids[i].MACs {
			if m, err := router.NormalizeMAC(cur); err == nil && m == mac {
				found = true
			} else if strings.TrimSpace(cur) == "" && freeIdx < 0 {
				freeIdx = j
			}
		}
		if ssids[i].Status != "2" || !found {
			alreadyAll = false
		}
		if !found {
			if freeIdx < 0 {
				return router.Change{}, router.Errorf(router.ErrRejected, "block", "Huawei HiLink MAC filter table is full (%d entries)", maxSlots)
			}
			ssids[i].MACs[freeIdx] = strings.ToUpper(mac)
		}
		ssids[i].Status = "2"
	}
	if alreadyAll {
		return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is already in Huawei HiLink blacklist", Undo: undoBlock(mac)}, nil
	}
	if err := d.refreshSesTok(ctx, "block"); err != nil {
		return router.Change{}, err
	}
	st, postRaw, err := d.rawDo(ctx, "block", http.MethodPost, "/api/wlan/multi-macfilter-settings", renderMultiMacFilter(ssids))
	if err != nil {
		return router.Change{}, err
	}
	if code, isErr := parseHiLinkError(postRaw); isErr || st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "HiLink macfilter update failed (HTTP %d, code %d)", st, code)
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to Huawei HiLink WLAN blacklist", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	raw, err := d.getXML(ctx, "unblock", "/api/wlan/multi-macfilter-settings")
	if err != nil {
		return router.Change{}, err
	}
	ssids, err := parseMultiMacFilter(raw)
	if err != nil || len(ssids) == 0 {
		return router.Change{}, router.Errorf(router.ErrProtocol, "unblock", "unreadable HiLink MAC filter table")
	}
	removed := 0
	for i := range ssids {
		if ssids[i].Status != "2" {
			continue
		}
		for j, cur := range ssids[i].MACs {
			if m, err := router.NormalizeMAC(cur); err == nil && m == mac {
				ssids[i].MACs[j] = ""
				removed++
			}
		}
	}
	if removed == 0 {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is not in Huawei HiLink blacklist"}, nil
	}
	if err := d.refreshSesTok(ctx, "unblock"); err != nil {
		return router.Change{}, err
	}
	st, postRaw, err := d.rawDo(ctx, "unblock", http.MethodPost, "/api/wlan/multi-macfilter-settings", renderMultiMacFilter(ssids))
	if err != nil {
		return router.Change{}, err
	}
	if code, isErr := parseHiLinkError(postRaw); isErr || st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "HiLink macfilter update failed (HTTP %d, code %d)", st, code)
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "removed " + strings.ToUpper(mac) + " from Huawei HiLink WLAN blacklist", Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		_ = d.refreshSesTok(ctx, "logout")
		_, _, _ = d.rawDo(ctx, "logout", http.MethodPost, "/api/user/logout", []byte(`<?xml version="1.0" encoding="UTF-8"?><request><Logout>1</Logout></request>`))
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s under Wi-Fi → Wi-Fi MAC Filter on the Huawei 4G/5G CPE", strings.ToUpper(mac))
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
