// Package dlink drives D-Link home and mesh routers (DIR-825, DIR-842, DIR-878, DIR-882, EXO,
// COVR) via the HNAP1 SOAP protocol (/HNAP1/) using HMAC-MD5 challenge-response authentication.
// It registers itself as vendor "dlink".
//
// Mechanisms used:
//   - login:    HNAP1 Login (Action=request → Challenge, Cookie, PublicKey → HMAC-MD5 PrivateKey →
//               Action=login + HNAP_AUTH header on every subsequent SOAP call)
//   - identify: GetDeviceSettings
//   - clients:  GetClientInfo
//   - block:    GetMACFilters2 / SetMACFilters2 (LD:-tagged entries in deny mode; refuses to
//               overwrite administrator allow-list mode or admin entries)
//   - logout:   Logout.
package dlink

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "dlink"

const (
	hnapNS      = "http://purenetworks.com/HNAP1/"
	ldTagPrefix = "LD:"
	mechBlock   = "D-Link HNAP1 MAC filter blacklist (SetMACFilters2)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one D-Link HNAP1 router.
type Driver struct {
	target     router.Target
	base       string
	http       *http.Client
	creds      router.CredentialSource
	uidCookie  []byte
	privateKey []byte
	loggedIn   bool
	info       *router.Info
}

// New builds a D-Link HNAP1 driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	router.Zero(d.uidCookie)
	router.Zero(d.privateKey)
	d.uidCookie = nil
	d.privateKey = nil
	d.loggedIn = false
}

func hmacMD5Upper(key, data []byte) string {
	m := hmac.New(md5.New, key)
	m.Write(data)
	return strings.ToUpper(hex.EncodeToString(m.Sum(nil)))
}

func soapEnvelope(inner string) []byte {
	return []byte(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` + inner + `</soap:Body></soap:Envelope>`)
}

func (d *Driver) soapRaw(ctx context.Context, op, action, innerXML string, signed bool) (int, []byte, error) {
	soapAction := `"` + hnapNS + action + `"`
	body := soapEnvelope(innerXML)
	defer router.Zero(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+"/HNAP1/", bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req.Header.Set("SOAPAction", soapAction)
	if len(d.uidCookie) > 0 {
		req.Header.Set("Cookie", "uid="+string(d.uidCookie))
	}
	if signed && len(d.privateKey) > 0 {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		auth := hmacMD5Upper(d.privateKey, []byte(ts+soapAction)) + " " + ts
		req.Header.Set("HNAP_AUTH", auth)
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
	return resp.StatusCode, raw, nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	// Phase 1: request challenge.
	req1 := fmt.Sprintf(`<Login xmlns="%s"><Action>request</Action><Username>%s</Username><LoginPassword/><Captcha/></Login>`, hnapNS, xmlEscape(user))
	st, raw, err := d.soapRaw(ctx, "login", "Login", req1, false)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrProtocol, "login", "HNAP1 Login request returned HTTP %d", st)
	}
	var env1 struct {
		Res struct {
			Result    string `xml:"LoginResult"`
			Challenge string `xml:"Challenge"`
			Cookie    string `xml:"Cookie"`
			PublicKey string `xml:"PublicKey"`
		} `xml:"Body>LoginResponse"`
	}
	if err := xml.Unmarshal(raw, &env1); err != nil || env1.Res.Challenge == "" || env1.Res.PublicKey == "" {
		return router.Errorf(router.ErrProtocol, "login", "not a D-Link HNAP1 Login challenge")
	}
	router.Zero(d.uidCookie)
	d.uidCookie = []byte(env1.Res.Cookie)

	// Phase 2: derive PrivateKey and LoginPassword.
	pkData := make([]byte, 0, len(env1.Res.PublicKey)+len(pass))
	pkData = append(pkData, env1.Res.PublicKey...)
	pkData = append(pkData, pass...)
	privKey := hmacMD5Upper([]byte(env1.Res.Challenge), pkData)
	router.Zero(pkData)
	loginPwd := hmacMD5Upper([]byte(privKey), []byte(env1.Res.Challenge))

	router.Zero(d.privateKey)
	d.privateKey = []byte(privKey)

	// Phase 3: submit Login response.
	req2 := fmt.Sprintf(`<Login xmlns="%s"><Action>login</Action><Username>%s</Username><LoginPassword>%s</LoginPassword><Captcha/></Login>`, hnapNS, xmlEscape(user), loginPwd)
	st, raw, err = d.soapRaw(ctx, "login", "Login", req2, false)
	if err != nil {
		d.wipeSession()
		return err
	}
	var env2 struct {
		Res struct {
			Result string `xml:"LoginResult"`
		} `xml:"Body>LoginResponse"`
	}
	if err := xml.Unmarshal(raw, &env2); err != nil || !strings.EqualFold(env2.Res.Result, "OK") {
		d.wipeSession()
		if strings.Contains(strings.ToLower(env2.Res.Result), "lock") {
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: env2.Res.Result}
		}
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: first(env2.Res.Result, fmt.Sprintf("HTTP %d", st))}
	}
	d.loggedIn = true
	return nil
}

func (d *Driver) call(ctx context.Context, op, action, innerXML string) ([]byte, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	st, raw, err := d.soapRaw(ctx, op, action, innerXML, true)
	if err != nil {
		return nil, err
	}
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		st, raw, err = d.soapRaw(ctx, op, action, innerXML, true)
		if err != nil {
			return nil, err
		}
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "HNAP1 %s returned HTTP %d", action, st)
	}
	return raw, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	raw, err := d.call(ctx, "identify", "GetDeviceSettings", fmt.Sprintf(`<GetDeviceSettings xmlns="%s"/>`, hnapNS))
	if err != nil {
		return router.Info{}, err
	}
	var env struct {
		Res struct {
			Vendor   string `xml:"VendorName"`
			Model    string `xml:"ModelName"`
			Firmware string `xml:"FirmwareVersion"`
			Hardware string `xml:"HardwareVersion"`
		} `xml:"Body>GetDeviceSettingsResponse"`
	}
	if err := xml.Unmarshal(raw, &env); err != nil || env.Res.Model == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unreadable HNAP1 GetDeviceSettings")
	}
	info := router.Info{
		Vendor:   first(env.Res.Vendor, "D-Link"),
		Model:    env.Res.Model,
		Firmware: env.Res.Firmware,
		Extra:    map[string]string{},
	}
	if env.Res.Hardware != "" {
		info.Extra["hardware"] = env.Res.Hardware
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
		{Capability: router.CapClients, Supported: true, Mechanism: "D-Link HNAP1 GetClientInfo"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "HNAP1 GetClientInfo reports IPv4 addresses without remaining lease seconds"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Adds LD:-tagged entries in deny mode; refuses to overwrite administrator allow-list mode"},
		{Capability: router.CapRateLimit, Supported: false, Note: "HNAP1 QoS uses priority queues rather than per-MAC kbps limits"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not uniformly supported across HNAP1 firmware"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: false, Note: "HNAP1 client nicknames vary across DIR/COVR firmware revisions"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	raw, err := d.call(ctx, "clients", "GetClientInfo", fmt.Sprintf(`<GetClientInfo xmlns="%s"/>`, hnapNS))
	if err != nil {
		return nil, err
	}
	var env struct {
		Clients []struct {
			MacAddress string `xml:"MacAddress"`
			IPv4       string `xml:"IPv4Address"`
			DeviceName string `xml:"DeviceName"`
			NickName   string `xml:"NickName"`
			Type       string `xml:"Type"`
		} `xml:"Body>GetClientInfoResponse>ClientInfoLists>ClientInfo"`
	}
	if err := xml.Unmarshal(raw, &env); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "clients", "unreadable HNAP1 GetClientInfo XML")
	}
	blockedMACs := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedMACs[b.MAC] = true
		}
	}
	var out []router.Client
	for _, cl := range env.Clients {
		mac, err := router.NormalizeMAC(cl.MacAddress)
		if err != nil {
			continue
		}
		active := true
		blk := blockedMACs[mac]
		out = append(out, router.Client{
			MAC:        mac,
			IP:         strings.TrimSpace(cl.IPv4),
			Hostname:   first(cl.NickName, cl.DeviceName),
			Connection: dlinkConn(cl.Type),
			Active:     &active,
			Blocked:    &blk,
			Raw:        map[string]string{"Type": cl.Type, "DeviceName": cl.DeviceName, "IPv4Address": cl.IPv4},
		})
	}
	router.SortClients(out)
	return out, nil
}

type macFilterInfo struct {
	Enabled     bool
	IsAllowList bool
	Entries     []macFilterEntry
}

type macFilterEntry struct {
	DeviceName string `xml:"DeviceName"`
	MacAddress string `xml:"MacAddress"`
}

func (d *Driver) getMACFilters(ctx context.Context, op string) (macFilterInfo, error) {
	raw, err := d.call(ctx, op, "GetMACFilters2", fmt.Sprintf(`<GetMACFilters2 xmlns="%s"/>`, hnapNS))
	if err != nil {
		return macFilterInfo{}, err
	}
	var env struct {
		Res struct {
			Enabled     string           `xml:"Enabled"`
			IsAllowList string           `xml:"IsAllowList"`
			Entries     []macFilterEntry `xml:"MACList>MACInfo"`
		} `xml:"Body>GetMACFilters2Response"`
	}
	if err := xml.Unmarshal(raw, &env); err != nil {
		return macFilterInfo{}, router.Errorf(router.ErrProtocol, op, "unreadable GetMACFilters2 XML")
	}
	return macFilterInfo{
		Enabled:     strings.EqualFold(env.Res.Enabled, "true"),
		IsAllowList: strings.EqualFold(env.Res.IsAllowList, "true"),
		Entries:     env.Res.Entries,
	}, nil
}

func (d *Driver) setMACFilters(ctx context.Context, op string, info macFilterInfo) error {
	var b strings.Builder
	fmt.Fprintf(&b, `<SetMACFilters2 xmlns="%s"><Enabled>%v</Enabled><IsAllowList>%v</IsAllowList><MACList>`, hnapNS, info.Enabled, info.IsAllowList)
	for _, e := range info.Entries {
		fmt.Fprintf(&b, `<MACInfo><MacAddress>%s</MacAddress><DeviceName>%s</DeviceName></MACInfo>`, xmlEscape(strings.ToUpper(e.MacAddress)), xmlEscape(e.DeviceName))
	}
	b.WriteString(`</MACList></SetMACFilters2>`)
	raw, err := d.call(ctx, op, "SetMACFilters2", b.String())
	if err != nil {
		return err
	}
	var env struct {
		Res struct {
			Result string `xml:"SetMACFilters2Result"`
		} `xml:"Body>SetMACFilters2Response"`
	}
	if xml.Unmarshal(raw, &env) == nil && env.Res.Result != "" && !strings.EqualFold(env.Res.Result, "OK") && !strings.EqualFold(env.Res.Result, "REBOOT") {
		return router.Errorf(router.ErrRejected, op, "SetMACFilters2 returned %s", env.Res.Result)
	}
	return nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	info, err := d.getMACFilters(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	if !info.Enabled || info.IsAllowList {
		return nil, nil
	}
	var out []router.BlockEntry
	for _, e := range info.Entries {
		mac, err := router.NormalizeMAC(e.MacAddress)
		if err != nil {
			continue
		}
		managed := strings.HasPrefix(e.DeviceName, ldTagPrefix)
		owner := router.OwnerAdmin
		if managed {
			owner = router.OwnerProduct
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      strings.TrimPrefix(e.DeviceName, ldTagPrefix),
			Mechanism: mechBlock,
			Owner:     owner,
			Managed:   managed,
		})
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	info, err := d.getMACFilters(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	if info.Enabled && info.IsAllowList {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "D-Link MAC filter is in Allow-list mode; refusing to overwrite administrator policy")
	}
	for _, e := range info.Entries {
		if m, err := router.NormalizeMAC(e.MacAddress); err == nil && m == mac && info.Enabled {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is already in D-Link MAC deny list", Undo: undoBlock(mac)}, nil
		}
	}
	info.Enabled = true
	info.IsAllowList = false
	info.Entries = append(info.Entries, macFilterEntry{MacAddress: strings.ToUpper(mac), DeviceName: ldTagPrefix + mac})
	if err := d.setMACFilters(ctx, "block", info); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to D-Link MAC deny list", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	info, err := d.getMACFilters(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	var kept []macFilterEntry
	removed := 0
	for _, e := range info.Entries {
		if m, err := router.NormalizeMAC(e.MacAddress); err == nil && m == mac && strings.HasPrefix(e.DeviceName, ldTagPrefix) {
			removed++
			continue
		}
		kept = append(kept, e)
	}
	if removed == 0 {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "no managed D-Link MAC block entry found"}, nil
	}
	info.Entries = kept
	if err := d.setMACFilters(ctx, "unblock", info); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "removed managed D-Link MAC block for " + strings.ToUpper(mac), Undo: "Block the device again in Nigafiy"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		_, _, _ = d.soapRaw(ctx, "logout", "Logout", fmt.Sprintf(`<Logout xmlns="%s"/>`, hnapNS), true)
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or remove %s%s under Features → Website / MAC Filter on D-Link", ldTagPrefix, mac)
}

func dlinkConn(t string) router.ConnectionType {
	l := strings.ToLower(t)
	switch {
	case strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5g"):
		return router.ConnWiFi5
	case strings.Contains(l, "2.4") || strings.Contains(l, "2g"):
		return router.ConnWiFi24
	case strings.Contains(l, "wifi") || strings.Contains(l, "wlan"):
		return router.ConnWiFi
	case strings.Contains(l, "lan") || strings.Contains(l, "eth"):
		return router.ConnWired
	default:
		return router.ConnUnknown
	}
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
