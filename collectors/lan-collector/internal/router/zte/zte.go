// Package zte drives ZTE ZXHN broadband gateways and fiber ONTs (H168N, H188A, H108N, F660, F670L,
// F680 — widely distributed by WE Egypt, Orange, Etisalat, Maroc Telecom and regional ISPs) via the
// CGILua XML web API (?_type=loginData&_tag=login_entry and ?_type=menuData&_tag=*_lua.lua).
// It registers itself as vendor "zte".
//
// Mechanisms used:
//   - login:    GET/POST /?_type=loginData&_tag=login_entry (SHA-256(password + LoginRandom))
//   - identify: GET /?_type=menuData&_tag=devmgr_statusmgr_lua.lua
//   - clients:  GET /?_type=menuData&_tag=accessdev_landev_lua.lua
//   - block:    GET/POST /?_type=menuData&_tag=localnet_macfilter_lua.lua (adds/removes LD:-tagged
//               MAC blacklist entries while refusing to modify whitelist mode or admin entries)
//   - logout:   POST /?_type=loginData&_tag=logout_entry.
package zte

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

// Vendor is the registry key.
const Vendor = "zte"

const (
	ldTagPrefix = "LD:"
	mechBlock   = "ZTE ZXHN MAC filter blacklist (localnet_macfilter_lua)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

var reSessionToken = regexp.MustCompile(`_sessionTOKEN["']?\s*[:=]\s*["']([^"']+)["']`)

// Driver talks to one ZTE ZXHN router over its CGILua web interface.
type Driver struct {
	target    router.Target
	base      string
	http      *http.Client
	creds     router.CredentialSource
	cookies   [][]byte
	sessToken []byte
	loggedIn  bool
	info      *router.Info
}

// New builds a ZTE ZXHN driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	for _, c := range d.cookies {
		router.Zero(c)
	}
	router.Zero(d.sessToken)
	d.cookies = nil
	d.sessToken = nil
	d.loggedIn = false
}

func (d *Driver) storeCookies(cs []*http.Cookie) {
	for _, c := range cs {
		kv := []byte(c.Name + "=" + c.Value)
		prefix := c.Name + "="
		replaced := false
		for i, ex := range d.cookies {
			if strings.HasPrefix(string(ex), prefix) {
				router.Zero(ex)
				d.cookies[i] = kv
				replaced = true
				break
			}
		}
		if !replaced {
			d.cookies = append(d.cookies, kv)
		}
	}
}

func (d *Driver) rawDo(ctx context.Context, op, method, path string, form url.Values) (int, []byte, error) {
	var body []byte
	if form != nil {
		body = []byte(form.Encode())
		defer router.Zero(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if len(d.cookies) > 0 {
		parts := make([]string, len(d.cookies))
		for i, c := range d.cookies {
			parts[i] = string(c)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
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
	d.storeCookies(resp.Cookies())
	if m := reSessionToken.FindSubmatch(raw); len(m) == 2 {
		router.Zero(d.sessToken)
		d.sessToken = append([]byte(nil), m[1]...)
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	// Step 1: fetch login challenge / token.
	st, raw, err := d.rawDo(ctx, "login", http.MethodGet, "/?_type=loginData&_tag=login_entry", nil)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrProtocol, "login", "ZTE login_entry returned HTTP %d", st)
	}
	var entry struct {
		LoginRandom string `json:"loginRandom"`
		LoginToken  string `json:"loginToken"`
		SessToken   string `json:"sess_token"`
		LockingTime int    `json:"lockingTime"`
	}
	_ = json.Unmarshal(raw, &entry)
	if entry.SessToken != "" {
		router.Zero(d.sessToken)
		d.sessToken = []byte(entry.SessToken)
	}
	// Also parse XML login_entry variant if not JSON.
	if entry.LoginRandom == "" && entry.LoginToken == "" {
		kv := parseZTEInstances(raw)
		if len(kv) > 0 {
			entry.LoginRandom = first(kv[0]["LoginRandom"], kv[0]["loginRandom"])
			entry.LoginToken = first(kv[0]["loginToken"], kv[0]["LoginToken"])
		}
	}
	if entry.LockingTime > 0 {
		return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "ZTE gateway locked logins", RetryAfter: time.Duration(entry.LockingTime) * time.Second}
	}

	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	// ZTE SHA-256(password + loginRandom)
	h := sha256.New()
	h.Write(pass)
	h.Write([]byte(first(entry.LoginRandom, entry.LoginToken)))
	passHash := hex.EncodeToString(h.Sum(nil))

	form := url.Values{
		"action":   {"login"},
		"Username": {user},
		"Password": {passHash},
	}
	if len(d.sessToken) > 0 {
		form.Set("_sessionTOKEN", string(d.sessToken))
	}
	st, postRaw, err := d.rawDo(ctx, "login", http.MethodPost, "/?_type=loginData&_tag=login_entry", form)
	if err != nil {
		return err
	}
	var loginRes struct {
		LoginNeedRefresh int    `json:"login_need_refresh"`
		LoginErrMsg      string `json:"loginErrMsg"`
		LockingTime      int    `json:"lockingTime"`
		SessToken        string `json:"sess_token"`
	}
	if json.Unmarshal(postRaw, &loginRes) == nil {
		if loginRes.SessToken != "" {
			router.Zero(d.sessToken)
			d.sessToken = []byte(loginRes.SessToken)
		}
		if loginRes.LockingTime > 0 {
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: loginRes.LoginErrMsg, RetryAfter: time.Duration(loginRes.LockingTime) * time.Second}
		}
		if loginRes.LoginErrMsg != "" {
			return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: loginRes.LoginErrMsg}
		}
	}
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("HTTP %d", st)}
	}
	if len(d.cookies) == 0 && len(d.sessToken) == 0 {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "ZTE did not issue a session"}
	}
	d.loggedIn = true
	return nil
}

func (d *Driver) getMenuData(ctx context.Context, op, tag string) ([]byte, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	path := "/?_type=menuData&_tag=" + url.QueryEscape(tag)
	st, raw, err := d.rawDo(ctx, op, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		st, raw, err = d.rawDo(ctx, op, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "ZTE %s returned HTTP %d", tag, st)
	}
	return raw, nil
}

// parseZTEInstances parses ZTE's CGILua XML `<Instance><ParaName>K</ParaName><ParaValue>V</ParaValue>...</Instance>` format.
func parseZTEInstances(raw []byte) []map[string]string {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var out []map[string]string
	var cur map[string]string
	var inInst bool
	var curTag, pendingName string
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "Instance":
				inInst = true
				cur = map[string]string{}
				pendingName = ""
			case "ParaName", "ParaValue":
				curTag = t.Name.Local
			default:
				if inInst {
					curTag = t.Name.Local
				}
			}
		case xml.CharData:
			if !inInst || curTag == "" {
				continue
			}
			val := strings.TrimSpace(string(t))
			switch curTag {
			case "ParaName":
				pendingName = val
			case "ParaValue":
				if pendingName != "" {
					cur[pendingName] = val
					pendingName = ""
				}
			default:
				if val != "" {
					cur[curTag] = val
				}
			}
		case xml.EndElement:
			if t.Name.Local == "Instance" && inInst {
				if len(cur) > 0 {
					out = append(out, cur)
				}
				inInst = false
			}
			curTag = ""
		}
	}
	return out
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	raw, err := d.getMenuData(ctx, "identify", "devmgr_statusmgr_lua.lua")
	if err != nil {
		return router.Info{}, err
	}
	insts := parseZTEInstances(raw)
	merged := map[string]string{}
	for _, m := range insts {
		for k, v := range m {
			if merged[k] == "" && v != "" {
				merged[k] = v
			}
		}
	}
	model := first(merged["ModelName"], merged["ProductClass"], "ZXHN")
	fw := first(merged["SoftwareVer"], merged["SoftwareVersion"])
	if model == "ZXHN" && fw == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a ZTE ZXHN XML status response")
	}
	info := router.Info{Vendor: "ZTE", Model: model, Firmware: fw, Extra: map[string]string{}}
	if sn := merged["SerialNumber"]; sn != "" {
		info.Extra["serial"] = sn
	}
	if hw := merged["HardwareVer"]; hw != "" {
		info.Extra["hardware"] = hw
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
		{Capability: router.CapClients, Supported: true, Mechanism: "ZTE ZXHN accessdev_landev_lua XML"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "ZTE ZXHN lease fields"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Adds LD:-tagged MAC filter blacklist entries without touching whitelist mode or admin rules"},
		{Capability: router.CapRateLimit, Supported: false, Note: "ZTE ZXHN ISP firmware varies in QoS class definitions"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not uniformly exposed across ZXHN builds"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: false, Note: "ZTE CGILua does not provide a uniform client alias API"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	raw, err := d.getMenuData(ctx, "clients", "accessdev_landev_lua.lua")
	if err != nil {
		return nil, err
	}
	insts := parseZTEInstances(raw)
	blockedMACs := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedMACs[b.MAC] = true
		}
	}
	byMAC := map[string]*router.Client{}
	for _, m := range insts {
		mac, err := router.NormalizeMAC(first(m["MACAddress"], m["MacAddress"]))
		if err != nil {
			continue
		}
		active := m["Active"] == "" || m["Active"] == "1" || strings.EqualFold(m["Active"], "true")
		blk := blockedMACs[mac]
		c := &router.Client{
			MAC:        mac,
			IP:         first(m["IPAddress"], m["IpAddress"]),
			Hostname:   first(m["HostName"], m["DeviceName"]),
			Connection: zteConn(first(m["InterfaceType"], m["Interface"], m["Port"])),
			Interface:  first(m["SSID"], m["Interface"], m["Port"]),
			Active:     &active,
			Blocked:    &blk,
			Raw:        m,
		}
		if rssi, err := strconv.Atoi(strings.TrimSpace(m["RSSI"])); err == nil && rssi < 0 && rssi > -120 {
			c.SignalDBm = &rssi
		}
		if secs, err := strconv.Atoi(strings.TrimSpace(m["LeaseTime"])); err == nil && secs > 0 {
			dur := time.Duration(secs) * time.Second
			c.Lease = &router.Lease{Source: "dhcp", Remaining: &dur}
		}
		byMAC[mac] = c
	}
	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) macFilterInstances(ctx context.Context, op string) (mode string, entries []map[string]string, err error) {
	raw, err := d.getMenuData(ctx, op, "localnet_macfilter_lua.lua")
	if err != nil {
		return "", nil, err
	}
	for _, m := range parseZTEInstances(raw) {
		if md := first(m["FilterMode"], m["Mode"]); md != "" {
			mode = md
		}
		if first(m["MACAddress"], m["SrcMacAddr"]) != "" {
			entries = append(entries, m)
		}
	}
	return mode, entries, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	mode, entries, err := d.macFilterInstances(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(mode, "white") || strings.EqualFold(mode, "whitelist") || strings.EqualFold(mode, "allow") {
		return nil, nil
	}
	var out []router.BlockEntry
	for _, e := range entries {
		if e["Enable"] == "0" {
			continue
		}
		mac, err := router.NormalizeMAC(first(e["MACAddress"], e["SrcMacAddr"]))
		if err != nil {
			continue
		}
		name := first(e["Name"], e["Alias"], e["Description"])
		managed := strings.HasPrefix(name, ldTagPrefix)
		owner := router.OwnerAdmin
		if managed {
			owner = router.OwnerProduct
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      strings.TrimPrefix(name, ldTagPrefix),
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
	mode, entries, err := d.macFilterInstances(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	if strings.EqualFold(mode, "white") || strings.EqualFold(mode, "whitelist") || strings.EqualFold(mode, "allow") {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "ZTE MAC filter is in Whitelist mode; refusing to overwrite administrator policy")
	}
	for _, e := range entries {
		if e["Enable"] != "0" {
			if m, err := router.NormalizeMAC(first(e["MACAddress"], e["SrcMacAddr"])); err == nil && m == mac {
				return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is already blocked on ZTE gateway", Undo: undoBlock(mac)}, nil
			}
		}
	}
	form := url.Values{
		"IF_ACTION":  {"Apply"},
		"FilterMode": {"Black"},
		"Enable":     {"1"},
		"Name":       {ldTagPrefix + mac},
		"MACAddress": {strings.ToUpper(mac)},
		"SrcMacAddr": {strings.ToUpper(mac)},
	}
	if len(d.sessToken) > 0 {
		form.Set("_sessionTOKEN", string(d.sessToken))
	}
	st, _, err := d.rawDo(ctx, "block", http.MethodPost, "/?_type=menuData&_tag=localnet_macfilter_lua.lua", form)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "ZTE macfilter apply returned HTTP %d", st)
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to ZTE MAC blacklist", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	_, entries, err := d.macFilterInstances(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	var instID string
	for _, e := range entries {
		m, err := router.NormalizeMAC(first(e["MACAddress"], e["SrcMacAddr"]))
		if err != nil || m != mac {
			continue
		}
		name := first(e["Name"], e["Alias"], e["Description"])
		if !strings.HasPrefix(name, ldTagPrefix) {
			continue
		}
		instID = first(e["_InstID"], e["InstID"], mac)
		break
	}
	if instID == "" {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "no managed ZTE block entry found"}, nil
	}
	form := url.Values{
		"IF_ACTION":  {"Delete"},
		"_InstID":    {instID},
		"MACAddress": {strings.ToUpper(mac)},
	}
	if len(d.sessToken) > 0 {
		form.Set("_sessionTOKEN", string(d.sessToken))
	}
	st, _, err := d.rawDo(ctx, "unblock", http.MethodPost, "/?_type=menuData&_tag=localnet_macfilter_lua.lua", form)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "ZTE macfilter delete returned HTTP %d", st)
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "removed managed ZTE block rule for " + strings.ToUpper(mac), Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		form := url.Values{"IF_LogOff": {"1"}}
		if len(d.sessToken) > 0 {
			form.Set("_sessionTOKEN", string(d.sessToken))
		}
		_, _, _ = d.rawDo(ctx, "logout", http.MethodPost, "/?_type=loginData&_tag=logout_entry", form)
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s%s under Internet → Security → Filter Criteria on the ZTE gateway", ldTagPrefix, mac)
}

func zteConn(s string) router.ConnectionType {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5g"):
		return router.ConnWiFi5
	case strings.Contains(l, "2.4") || strings.Contains(l, "2g"):
		return router.ConnWiFi24
	case strings.Contains(l, "wlan") || strings.Contains(l, "wifi"):
		return router.ConnWiFi
	case strings.Contains(l, "lan") || strings.Contains(l, "eth"):
		return router.ConnWired
	default:
		return router.ConnUnknown
	}
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
