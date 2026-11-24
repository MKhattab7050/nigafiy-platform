// Package tenda drives Tenda home routers (F3, AC6, AC10, AC11, AC15, AC23) via their embedded
// web CGI API (/login/Auth, /goform/getQos, /goform/setQos, /goform/setBlackRule).
// It registers itself as vendor "tenda".
//
// Mechanisms used:
//   - login:      POST /login/Auth (username + base64(password)) → session cookie
//   - identify:   GET /goform/getSysTools?modules=sysVersion
//   - clients:    GET /goform/getQos?modules=onlineList,blackList
//   - block:      POST /goform/setQos (sets qosListAccess="false" for the MAC; unblocks via
//                 POST /goform/delBlackRule or /goform/setQos qosListAccess="true")
//   - rate limit: POST /goform/setQos (per-MAC download/upload speed limit in KB/s)
//   - rename:     POST /goform/SetOnlineDevName (V15.03 firmware family only; rename.go)
//   - logout:     GET /goform/loginOut.
package tenda

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

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "tenda"

const (
	mechBlock = "Tenda Bandwidth Control / Blacklist (/goform/setQos)"
	mechLimit = "Tenda per-device bandwidth limit (/goform/setQos)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var (
	_ router.Driver      = (*Driver)(nil)
	_ router.RateLimiter = (*Driver)(nil)
)

// Driver talks to one Tenda home router.
type Driver struct {
	target   router.Target
	base     string
	http     *http.Client
	creds    router.CredentialSource
	cookies  [][]byte
	loggedIn bool
	info     *router.Info
}

// New builds a Tenda driver for t.
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
	d.cookies = nil
	d.loggedIn = false
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
	for _, c := range resp.Cookies() {
		d.cookies = append(d.cookies, []byte(c.Name+"="+c.Value))
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

	enc := make([]byte, base64.StdEncoding.EncodedLen(len(pass)))
	base64.StdEncoding.Encode(enc, pass)
	form := url.Values{"username": {user}, "password": {string(enc)}}
	router.Zero(enc)

	st, raw, err := d.rawDo(ctx, "login", http.MethodPost, "/login/Auth", form)
	if err != nil {
		return err
	}
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("HTTP %d", st)}
	}
	var res struct {
		ErrCode any `json:"errCode"`
	}
	if json.Unmarshal(raw, &res) == nil {
		ec := str(res.ErrCode)
		if ec != "" && ec != "0" {
			return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "Tenda login error " + ec}
		}
	}
	if len(d.cookies) == 0 && st != http.StatusOK && st != http.StatusFound {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "no session cookie returned"}
	}
	d.loggedIn = true
	return nil
}

func (d *Driver) getJSON(ctx context.Context, op, path string) (map[string]any, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
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
		return nil, router.Errorf(router.ErrProtocol, op, "%s returned HTTP %d", path, st)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable Tenda JSON from %s", path)
	}
	return m, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	m, err := d.getJSON(ctx, "identify", "/goform/getSysTools?modules=sysVersion")
	if err != nil {
		return router.Info{}, err
	}
	ver, _ := m["sysVersion"].(map[string]any)
	if ver == nil {
		ver = m
	}
	info := router.Info{
		Vendor:   "Tenda",
		Model:    first(str(ver["product"]), str(ver["model"]), "Tenda Router"),
		Firmware: first(str(ver["softVersion"]), str(ver["sysVersion"]), str(ver["version"])),
	}
	if info.Firmware == "" && info.Model == "Tenda Router" {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "not a Tenda sysVersion response")
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
		{Capability: router.CapClients, Supported: true, Mechanism: "Tenda /goform/getQos (onlineList + blackList)"},
		{Capability: router.CapDHCPLeases, Supported: false, Note: "Tenda onlineList reports client IPs without lease expiry"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Blocks/unblocks the device MAC in Tenda's online/blacklist table"},
		{Capability: router.CapRateLimit, Supported: true, Mechanism: mechLimit, Note: "Sets per-MAC download/upload speed limits in Tenda Bandwidth Control"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not offered: Tenda V15.03 firmware has /goform/saveParentControlInfo (CVE-2024-2850, CVE-2024-2852 on the AC15), but only its urls field is publicly documented; its device, day and time fields are not, so Nigafiy does not guess them. Nigafiy enforces a schedule itself with the router's block instead."},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		renameCapability(d.info),
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

type qosPayload struct {
	Online []map[string]any
	Black  []map[string]any
}

func (d *Driver) readQos(ctx context.Context, op string) (qosPayload, error) {
	m, err := d.getJSON(ctx, op, "/goform/getQos?modules=onlineList,blackList")
	if err != nil {
		return qosPayload{}, err
	}
	var q qosPayload
	q.Online = sliceOfMaps(m["onlineList"])
	q.Black = sliceOfMaps(m["blackList"])
	return q, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	q, err := d.readQos(ctx, "clients")
	if err != nil {
		return nil, err
	}
	byMAC := map[string]*router.Client{}
	for _, row := range q.Online {
		mac, err := router.NormalizeMAC(first(str(row["qosListMac"]), str(row["mac"])))
		if err != nil {
			continue
		}
		active := true
		blk := strings.EqualFold(str(row["qosListAccess"]), "false")
		c := &router.Client{
			MAC:        mac,
			IP:         first(str(row["qosListIP"]), str(row["ip"])),
			Hostname:   first(str(row["qosListRemark"]), str(row["qosListDevName"]), str(row["devName"])),
			Connection: tendaConn(first(str(row["qosListConnectType"]), str(row["connectType"]))),
			Active:     &active,
			Blocked:    &blk,
			Raw:        map[string]string{},
		}
		for k, v := range row {
			if s := str(v); s != "" {
				c.Raw[k] = s
			}
		}
		byMAC[mac] = c
	}
	for _, row := range q.Black {
		mac, err := router.NormalizeMAC(first(str(row["qosListMac"]), str(row["mac"])))
		if err != nil {
			continue
		}
		c, ok := byMAC[mac]
		if !ok {
			f := false
			c = &router.Client{MAC: mac, Connection: router.ConnUnknown, Active: &f, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		t := true
		c.Blocked = &t
		if hn := first(str(row["qosListRemark"]), str(row["qosListDevName"])); hn != "" && c.Hostname == "" {
			c.Hostname = hn
		}
	}
	out := make([]router.Client, 0, len(byMAC))
	for _, c := range byMAC {
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	q, err := d.readQos(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, row := range q.Black {
		mac, err := router.NormalizeMAC(first(str(row["qosListMac"]), str(row["mac"])))
		if err != nil {
			continue
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      first(str(row["qosListRemark"]), str(row["qosListDevName"])),
			Mechanism: mechBlock,
			Owner:     router.OwnerUnknown,
			Managed:   true,
		})
	}
	return out, nil
}

func (d *Driver) Block(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	blocked, err := d.Blocked(ctx)
	if err != nil {
		return router.Change{}, err
	}
	for _, b := range blocked {
		if b.MAC == mac {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "device is already in Tenda blacklist", Undo: undoBlock(mac)}, nil
		}
	}
	form := url.Values{
		"qosList": {fmt.Sprintf("%s\t\t0\t0\tfalse", strings.ToLower(mac))},
	}
	st, _, err := d.rawDo(ctx, "block", http.MethodPost, "/goform/setQos", form)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "Tenda setQos returned HTTP %d", st)
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "blocked " + mac + " on Tenda router", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	blocked, err := d.Blocked(ctx)
	if err != nil {
		return router.Change{}, err
	}
	found := false
	for _, b := range blocked {
		if b.MAC == mac {
			found = true
			break
		}
	}
	if !found {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "device is not in Tenda blacklist"}, nil
	}
	st, _, err := d.rawDo(ctx, "unblock", http.MethodPost, "/goform/delBlackRule", url.Values{"mac": {strings.ToLower(mac)}})
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "unblock", "Tenda delBlackRule returned HTTP %d", st)
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "removed " + mac + " from Tenda blacklist", Undo: "Block the device again in Nigafiy"}, nil
}

func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if limit.DownKbps <= 0 && limit.UpKbps <= 0 {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "rate_limit", "down_kbps or up_kbps must be > 0")
	}
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return router.Change{}, err
		}
	}
	// Tenda setQos uses KB/s (1 KB/s = 8 kbps); 0 means unlimited.
	downKB := limit.DownKbps / 8
	if limit.DownKbps > 0 && downKB == 0 {
		downKB = 1
	}
	upKB := limit.UpKbps / 8
	if limit.UpKbps > 0 && upKB == 0 {
		upKB = 1
	}
	form := url.Values{
		"qosList": {fmt.Sprintf("%s\t\t%d\t%d\ttrue", strings.ToLower(mac), upKB, downKB)},
	}
	st, _, err := d.rawDo(ctx, "rate_limit", http.MethodPost, "/goform/setQos", form)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "Tenda setQos returned HTTP %d", st)
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("set Tenda bandwidth limit for %s (down=%d KB/s, up=%d KB/s)", mac, downKB, upKB),
		Undo:      "Clear rate limit in Nigafiy, or set limits to Unlimited in Tenda Bandwidth Control",
	}, nil
}

func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return router.Change{}, err
		}
	}
	form := url.Values{
		"qosList": {fmt.Sprintf("%s\t\t0\t0\ttrue", strings.ToLower(mac))},
	}
	st, _, err := d.rawDo(ctx, "clear_rate_limit", http.MethodPost, "/goform/setQos", form)
	if err != nil {
		return router.Change{}, err
	}
	if st != http.StatusOK {
		return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "Tenda setQos returned HTTP %d", st)
	}
	return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: true, Detail: "cleared Tenda bandwidth limit for " + mac}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		_, _, _ = d.rawDo(ctx, "logout", http.MethodGet, "/goform/loginOut", nil)
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in Nigafiy, or remove %s from Bandwidth Control → Blocked Devices on Tenda", mac)
}

func tendaConn(s string) router.ConnectionType {
	switch strings.ToLower(s) {
	case "0", "wired", "lan":
		return router.ConnWired
	case "1", "2.4g", "wifi_2.4g":
		return router.ConnWiFi24
	case "2", "5g", "wifi_5g":
		return router.ConnWiFi5
	default:
		if strings.Contains(strings.ToLower(s), "wifi") {
			return router.ConnWiFi
		}
		return router.ConnUnknown
	}
}

func sliceOfMaps(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, x := range arr {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
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
