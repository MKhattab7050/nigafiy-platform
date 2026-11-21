// Package asus drives ASUS routers running Asuswrt / Asuswrt-Merlin via the built-in HTTP API
// (/login.cgi, /appGet.cgi, /applyapp.cgi). It registers itself as vendor "asus".
//
// Mechanisms used:
//   - login:    POST /login.cgi (login_authorization=base64(user:pass)) → asus_token cookie
//   - identify: POST /appGet.cgi hook=nvram_get(productid);nvram_get(firmver);nvram_get(buildno)
//   - clients:  POST /appGet.cgi hook=get_clientlist();nvram_get(MULTIFILTER_ENABLE);nvram_get(MULTIFILTER_MAC);nvram_get(MULTIFILTER_DEVICENAME)
//   - block:    POST /applyapp.cgi updating MULTIFILTER_* NVRAM entries + restart_firewall.
//               Product-created entries are prefixed with "LD:" in MULTIFILTER_DEVICENAME so
//               pre-existing administrator entries are preserved untouched.
package asus

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lan-detective/lan-collector/internal/router"
)

// Vendor is the registry key.
const Vendor = "asus"

const (
	userAgent   = "asusrouter-Android-DUTUtil-1.0.0.245"
	ldTagPrefix = "LD:"
	mechBlock   = "Asuswrt Parental Controls internet block (MULTIFILTER_MAC)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one ASUS Asuswrt router.
type Driver struct {
	target router.Target
	base   string
	http   *http.Client
	creds  router.CredentialSource
	token  []byte
	info   *router.Info
}

// New builds an ASUS driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	router.Zero(d.token)
	d.token = nil
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
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if len(d.token) > 0 {
		req.Header.Set("Cookie", "asus_token="+string(d.token))
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
		if c.Name == "asus_token" && c.Value != "" {
			router.Zero(d.token)
			d.token = []byte(c.Value)
		}
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
	cred := make([]byte, 0, len(user)+1+len(pass))
	cred = append(cred, user...)
	cred = append(cred, ':')
	cred = append(cred, pass...)
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(cred)))
	base64.StdEncoding.Encode(enc, cred)
	router.Zero(cred)

	form := url.Values{"login_authorization": {string(enc)}}
	router.Zero(enc)
	st, raw, err := d.rawDo(ctx, "login", http.MethodPost, "/login.cgi", form)
	if err != nil {
		return err
	}
	var rep struct {
		Token       string `json:"asus_token"`
		ErrorStatus string `json:"error_status"`
	}
	if json.Unmarshal(raw, &rep) == nil {
		if rep.Token != "" {
			router.Zero(d.token)
			d.token = []byte(rep.Token)
			return nil
		}
		if rep.ErrorStatus == "7" || rep.ErrorStatus == "11" {
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "Asuswrt locked logins (status " + rep.ErrorStatus + ")"}
		}
		if rep.ErrorStatus != "" {
			return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "Asuswrt login rejected (status " + rep.ErrorStatus + ")"}
		}
	}
	if len(d.token) > 0 && st == http.StatusOK {
		return nil
	}
	return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("HTTP %d", st)}
}

func (d *Driver) appGet(ctx context.Context, op, hook string) (map[string]any, error) {
	if len(d.token) == 0 {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	st, raw, err := d.rawDo(ctx, op, http.MethodPost, "/appGet.cgi", url.Values{"hook": {hook}})
	if err != nil {
		return nil, err
	}
	if st == http.StatusUnauthorized || strings.Contains(string(raw), `"error_status"`) {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		st, raw, err = d.rawDo(ctx, op, http.MethodPost, "/appGet.cgi", url.Values{"hook": {hook}})
		if err != nil {
			return nil, err
		}
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrProtocol, op, "appGet.cgi returned HTTP %d", st)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable appGet.cgi JSON")
	}
	return m, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	m, err := d.appGet(ctx, "identify", "nvram_get(productid);nvram_get(firmver);nvram_get(buildno);nvram_get(extendno)")
	if err != nil {
		return router.Info{}, err
	}
	model := str(m["productid"])
	fw := strings.TrimSpace(str(m["firmver"]))
	if b := str(m["buildno"]); b != "" {
		fw = strings.TrimPrefix(fw+"."+b, ".")
	}
	if e := str(m["extendno"]); e != "" {
		fw += "_" + e
	}
	if model == "" && fw == "" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not an Asuswrt appGet response")
	}
	info := router.Info{Vendor: "ASUS", Model: first(model, "Asuswrt"), Firmware: fw}
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
		{Capability: router.CapClients, Supported: true, Mechanism: "Asuswrt appGet.cgi get_clientlist()"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "get_clientlist reports active IPs without remaining lease seconds"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Adds a dedicated LD:-tagged entry to MULTIFILTER_MAC without altering administrator rules"},
		{Capability: router.CapRateLimit, Supported: false, Note: "Asuswrt bandwidth limiter NVRAM format varies across firmware generations"},
		{Capability: router.CapSchedule, Supported: false, Note: "Time-scheduling uses per-firmware bitmasks not uniformly exposed"},
	}, nil
}

type mfRow struct {
	enable string // "0", "1" (schedule), "2" (block)
	mac    string // normalized
	name   string
	day    string
}

func (d *Driver) readMultifilter(ctx context.Context, op string) ([]mfRow, error) {
	m, err := d.appGet(ctx, op, "nvram_get(MULTIFILTER_ENABLE);nvram_get(MULTIFILTER_MAC);nvram_get(MULTIFILTER_DEVICENAME);nvram_get(MULTIFILTER_MACFILTER_DAYTIME)")
	if err != nil {
		return nil, err
	}
	en := splitNVRAM(str(m["MULTIFILTER_ENABLE"]))
	macs := splitNVRAM(str(m["MULTIFILTER_MAC"]))
	names := splitNVRAM(str(m["MULTIFILTER_DEVICENAME"]))
	days := splitNVRAM(str(m["MULTIFILTER_MACFILTER_DAYTIME"]))
	var rows []mfRow
	for i, rawMAC := range macs {
		norm, err := router.NormalizeMAC(rawMAC)
		if err != nil {
			continue
		}
		rows = append(rows, mfRow{
			enable: at(en, i, "2"),
			mac:    norm,
			name:   at(names, i, ""),
			day:    at(days, i, "<"),
		})
	}
	return rows, nil
}

func (d *Driver) writeMultifilter(ctx context.Context, op string, rows []mfRow) error {
	en := make([]string, len(rows))
	macs := make([]string, len(rows))
	names := make([]string, len(rows))
	days := make([]string, len(rows))
	for i, r := range rows {
		en[i] = r.enable
		macs[i] = strings.ToUpper(r.mac)
		names[i] = r.name
		days[i] = r.day
	}
	form := url.Values{
		"action_mode":                   {"apply"},
		"rc_service":                    {"restart_firewall"},
		"MULTIFILTER_ALL":               {"1"},
		"MULTIFILTER_ENABLE":            {strings.Join(en, ">")},
		"MULTIFILTER_MAC":               {strings.Join(macs, ">")},
		"MULTIFILTER_DEVICENAME":        {strings.Join(names, ">")},
		"MULTIFILTER_MACFILTER_DAYTIME": {strings.Join(days, ">")},
	}
	st, _, err := d.rawDo(ctx, op, http.MethodPost, "/applyapp.cgi", form)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrRejected, op, "applyapp.cgi returned HTTP %d", st)
	}
	return nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	m, err := d.appGet(ctx, "clients", "get_clientlist()")
	if err != nil {
		return nil, err
	}
	clMap, _ := m["get_clientlist"].(map[string]any)
	blocked := map[string]bool{}
	if rows, err := d.readMultifilter(ctx, "clients"); err == nil {
		for _, r := range rows {
			if r.enable == "2" {
				blocked[r.mac] = true
			}
		}
	}

	var out []router.Client
	for rawMAC, val := range clMap {
		entry, ok := val.(map[string]any)
		if !ok {
			continue
		}
		mac, err := router.NormalizeMAC(rawMAC)
		if err != nil {
			continue
		}
		on := str(entry["isOnline"]) == "1"
		blk := blocked[mac]
		c := router.Client{
			MAC:        mac,
			IP:         str(entry["ip"]),
			Hostname:   first(str(entry["nickName"]), str(entry["name"])),
			Connection: asusConn(str(entry["isWL"])),
			Active:     &on,
			Blocked:    &blk,
			Raw:        map[string]string{},
		}
		if rssi, err := strconv.Atoi(str(entry["rssi"])); err == nil && rssi < 0 && rssi > -120 {
			c.SignalDBm = &rssi
		}
		for k, v := range entry {
			if s := str(v); s != "" {
				c.Raw[k] = s
			}
		}
		out = append(out, c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	rows, err := d.readMultifilter(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, r := range rows {
		if r.enable != "2" && r.enable != "1" {
			continue
		}
		managed := strings.HasPrefix(r.name, ldTagPrefix) && r.enable == "2"
		owner := router.OwnerAdmin
		if managed {
			owner = router.OwnerProduct
		}
		out = append(out, router.BlockEntry{
			MAC:       r.mac,
			Name:      strings.TrimPrefix(r.name, ldTagPrefix),
			Mechanism: mechBlock,
			Owner:     owner,
			Partial:   r.enable == "1",
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
	rows, err := d.readMultifilter(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range rows {
		if r.mac == mac && r.enable == "2" {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "device is already blocked in Asuswrt MULTIFILTER_MAC", Undo: undoBlock(mac)}, nil
		}
	}
	rows = append(rows, mfRow{enable: "2", mac: mac, name: ldTagPrefix + mac, day: "<"})
	if err := d.writeMultifilter(ctx, "block", rows); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to Asuswrt MULTIFILTER_MAC", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readMultifilter(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	var kept []mfRow
	removed := 0
	for _, r := range rows {
		if r.mac == mac && strings.HasPrefix(r.name, ldTagPrefix) {
			removed++
			continue
		}
		kept = append(kept, r)
	}
	if removed == 0 {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "no managed Asuswrt block entry found for this MAC"}, nil
	}
	if err := d.writeMultifilter(ctx, "unblock", kept); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: fmt.Sprintf("removed %d managed MULTIFILTER entry(s)", removed), Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if len(d.token) > 0 {
		_, _, _ = d.rawDo(ctx, "logout", http.MethodGet, "/Logout.asp", nil)
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s%s under AiProtection → Parental Controls in Asuswrt", ldTagPrefix, mac)
}

func asusConn(isWL string) router.ConnectionType {
	switch isWL {
	case "0":
		return router.ConnWired
	case "1":
		return router.ConnWiFi24
	case "2":
		return router.ConnWiFi5
	case "3":
		return router.ConnWiFi6
	default:
		return router.ConnUnknown
	}
}

func splitNVRAM(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Split(s, ">")
}

func at(xs []string, i int, def string) string {
	if i < len(xs) && xs[i] != "" {
		return xs[i]
	}
	return def
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	default:
		return ""
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
