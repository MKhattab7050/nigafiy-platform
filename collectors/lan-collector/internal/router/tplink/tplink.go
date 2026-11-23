// Package tplink drives TP-Link Home Wi-Fi / Archer / VDSL routers (Archer C6, C80, AX10, AX23,
// AX53, AX73, VR400, VR600, VX230v) via their /cgi-bin/luci/;stok=<token>/admin/* JSON API with
// RSA-PKCS1v1.5 encrypted login. It registers itself as vendor "tplink_archer".
//
// Mechanisms used:
//   - login:    POST /cgi-bin/luci/;stok=/login?form=login (operation=read → RSA n,e →
//               RSA-PKCS1v1.5 encrypt password → operation=login → stok + sysauth cookie)
//   - identify: POST /cgi-bin/luci/;stok=<tok>/admin/firmware?form=upgrade (operation=read)
//   - clients:  merges admin/dhcps?form=client and admin/access_control?form=black_devices
//   - block:    admin/access_control?form=mode & form=black_list (LD:-tagged entries; refuses
//               to overwrite administrator whitelist mode or admin entries)
//   - logout:   POST /cgi-bin/luci/;stok=<tok>/admin/system?form=logout.
package tplink

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "tplink_archer"

const (
	ldTagPrefix = "LD:"
	mechBlock   = "TP-Link Archer Access Control blacklist (/admin/access_control)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

// Driver talks to one TP-Link Home/Archer router.
type Driver struct {
	target   router.Target
	base     string
	http     *http.Client
	creds    router.CredentialSource
	stok     []byte
	cookies  [][]byte
	loggedIn bool
	info     *router.Info
}

// New builds a TP-Link Archer driver for t.
func New(t router.Target, creds router.CredentialSource) (*Driver, error) {
	c, err := router.HTTPClient(t)
	if err != nil {
		return nil, err
	}
	return &Driver{target: t, base: t.BaseURL(), http: c, creds: creds}, nil
}

func (d *Driver) wipeSession() {
	router.Zero(d.stok)
	for _, c := range d.cookies {
		router.Zero(c)
	}
	d.stok = nil
	d.cookies = nil
	d.loggedIn = false
}

func (d *Driver) rawPost(ctx context.Context, op, path string, form url.Values) (int, []byte, error) {
	body := []byte(form.Encode())
	defer router.Zero(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
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

func encryptRSAPassword(pass []byte, nHex, eHex string) (string, error) {
	n := new(big.Int)
	if _, ok := n.SetString(strings.TrimSpace(nHex), 16); !ok || n.Sign() <= 0 {
		return "", router.Errorf(router.ErrProtocol, "login", "invalid TP-Link RSA modulus")
	}
	eBig := new(big.Int)
	if _, ok := eBig.SetString(strings.TrimSpace(eHex), 16); !ok || !eBig.IsInt64() {
		return "", router.Errorf(router.ErrProtocol, "login", "invalid TP-Link RSA exponent")
	}
	pub := &rsa.PublicKey{N: n, E: int(eBig.Int64())}
	ct, err := rsa.EncryptPKCS1v15(rand.Reader, pub, pass)
	if err != nil {
		return "", router.Errorf(router.ErrProtocol, "login", "RSA password encryption failed")
	}
	return hex.EncodeToString(ct), nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	// Step 1: fetch RSA public key parameters (n, e).
	st, raw, err := d.rawPost(ctx, "login", "/cgi-bin/luci/;stok=/login?form=login", url.Values{"operation": {"read"}})
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrProtocol, "login", "TP-Link login key read returned HTTP %d", st)
	}
	var keyResp struct {
		Success bool `json:"success"`
		Data    struct {
			Password []string `json:"password"` // [modulusHex, exponentHex]
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &keyResp); err != nil || !keyResp.Success || len(keyResp.Data.Password) < 2 {
		return router.Errorf(router.ErrProtocol, "login", "not a TP-Link Archer LuCI login response")
	}

	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	encPass, err := encryptRSAPassword(pass, keyResp.Data.Password[0], keyResp.Data.Password[1])
	if err != nil {
		return err
	}

	st, raw, err = d.rawPost(ctx, "login", "/cgi-bin/luci/;stok=/login?form=login", url.Values{
		"operation": {"login"},
		"username":  {user},
		"password":  {encPass},
	})
	if err != nil {
		return err
	}
	var loginResp struct {
		Success   bool   `json:"success"`
		ErrorCode string `json:"errorcode"`
		Data      struct {
			Stok     string `json:"stok"`
			Attempts int    `json:"attemptsAllowed"`
			LockTime int    `json:"failureCount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &loginResp); err != nil {
		return router.Errorf(router.ErrProtocol, "login", "unreadable TP-Link login response (HTTP %d)", st)
	}
	if !loginResp.Success || loginResp.Data.Stok == "" {
		if strings.Contains(strings.ToLower(loginResp.ErrorCode), "exceed") || strings.Contains(strings.ToLower(loginResp.ErrorCode), "lock") {
			return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: loginResp.ErrorCode}
		}
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: first(loginResp.ErrorCode, fmt.Sprintf("HTTP %d", st))}
	}
	router.Zero(d.stok)
	d.stok = []byte(loginResp.Data.Stok)
	d.loggedIn = true
	return nil
}

func (d *Driver) adminCall(ctx context.Context, op, relPath string, form url.Values) (json.RawMessage, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	path := "/cgi-bin/luci/;stok=" + string(d.stok) + relPath
	st, raw, err := d.rawPost(ctx, op, path, form)
	if err != nil {
		return nil, err
	}
	if st == http.StatusUnauthorized || st == http.StatusForbidden {
		d.wipeSession()
		if err := d.login(ctx); err != nil {
			return nil, err
		}
		path = "/cgi-bin/luci/;stok=" + string(d.stok) + relPath
		st, raw, err = d.rawPost(ctx, op, path, form)
		if err != nil {
			return nil, err
		}
	}
	var env struct {
		Success   bool            `json:"success"`
		ErrorCode string          `json:"errorcode"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, router.Errorf(router.ErrProtocol, op, "unreadable TP-Link admin reply (HTTP %d)", st)
	}
	if !env.Success {
		return nil, router.Errorf(router.ErrRejected, op, "TP-Link error: %s", first(env.ErrorCode, "failed"))
	}
	return env.Data, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	data, err := d.adminCall(ctx, "identify", "/admin/firmware?form=upgrade", url.Values{"operation": {"read"}})
	if err != nil {
		return router.Info{}, err
	}
	var fw struct {
		Model    string `json:"model"`
		Firmware string `json:"firmware_version"`
		Hardware string `json:"hardware_version"`
	}
	if err := json.Unmarshal(data, &fw); err != nil {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unexpected firmware payload")
	}
	info := router.Info{
		Vendor:   "TP-Link",
		Model:    first(fw.Model, "Archer"),
		Firmware: fw.Firmware,
		Extra:    map[string]string{},
	}
	if fw.Hardware != "" {
		info.Extra["hardware"] = fw.Hardware
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
		{Capability: router.CapClients, Supported: true, Mechanism: "TP-Link DHCP client list and Access Control online devices"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "/admin/dhcps?form=client"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Manages LD:-tagged blacklist entries; refuses to alter administrator whitelist mode"},
		{Capability: router.CapRateLimit, Supported: false, Note: "TP-Link home Archer QoS uses priority levels rather than uniform per-MAC kbps limits"},
		{Capability: router.CapSchedule, Supported: false, Note: "Not exposed uniformly across Archer firmware"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: false, Note: "TP-Link Archer firmware does not expose a client alias API"},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	byMAC := map[string]*router.Client{}
	ensure := func(mac string) *router.Client {
		c, ok := byMAC[mac]
		if !ok {
			c = &router.Client{MAC: mac, Connection: router.ConnUnknown, Raw: map[string]string{}}
			byMAC[mac] = c
		}
		return c
	}

	if data, err := d.adminCall(ctx, "clients", "/admin/dhcps?form=client", url.Values{"operation": {"load"}}); err == nil {
		var rows []map[string]any
		if json.Unmarshal(data, &rows) == nil {
			for _, r := range rows {
				mac, err := router.NormalizeMAC(first(str(r["macaddr"]), str(r["mac"])))
				if err != nil {
					continue
				}
				c := ensure(mac)
				if ip := first(str(r["ipaddr"]), str(r["ip"])); ip != "" {
					c.IP = ip
				}
				if hn := str(r["name"]); hn != "" && hn != "--" {
					c.Hostname = hn
				}
				lease := &router.Lease{Source: "dhcp"}
				if lt := str(r["leasetime"]); lt == "Permanent" {
					lease.Source = "reserved"
				} else if dur, ok := parseHMS(lt); ok {
					lease.Remaining = &dur
				}
				c.Lease = lease
				for k, v := range r {
					if s := str(v); s != "" {
						c.Raw["dhcp."+k] = s
					}
				}
			}
		}
	}

	if data, err := d.adminCall(ctx, "clients", "/admin/access_control?form=black_devices", url.Values{"operation": {"load"}}); err == nil {
		var rows []map[string]any
		if json.Unmarshal(data, &rows) == nil {
			for _, r := range rows {
				mac, err := router.NormalizeMAC(first(str(r["mac"]), str(r["macaddr"])))
				if err != nil {
					continue
				}
				c := ensure(mac)
				t := true
				c.Active = &t
				if ip := first(str(r["ipaddr"]), str(r["ip"])); ip != "" && c.IP == "" {
					c.IP = ip
				}
				if hn := str(r["name"]); hn != "" && hn != "--" && c.Hostname == "" {
					c.Hostname = hn
				}
				c.Connection = tplinkConn(str(r["conn_type"]))
				for k, v := range r {
					if s := str(v); s != "" {
						c.Raw["ac."+k] = s
					}
				}
			}
		}
	}

	blockedMACs := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedMACs[b.MAC] = true
		}
	}
	out := make([]router.Client, 0, len(byMAC))
	for mac, c := range byMAC {
		b := blockedMACs[mac]
		c.Blocked = &b
		out = append(out, *c)
	}
	router.SortClients(out)
	return out, nil
}

type blackEntry struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	MAC  string `json:"mac"`
}

func (d *Driver) readAccessMode(ctx context.Context, op string) (enabled bool, mode string) {
	data, err := d.adminCall(ctx, op, "/admin/access_control?form=enable", url.Values{"operation": {"read"}})
	if err == nil {
		var m struct{ Enable string `json:"enable"` }
		if json.Unmarshal(data, &m) == nil {
			enabled = strings.EqualFold(m.Enable, "on")
		}
	}
	mdata, merr := d.adminCall(ctx, op, "/admin/access_control?form=mode", url.Values{"operation": {"read"}})
	if merr == nil {
		var m struct{ AccessMode string `json:"access_mode"` }
		if json.Unmarshal(mdata, &m) == nil {
			mode = strings.ToLower(m.AccessMode)
		}
	}
	return enabled, mode
}

func (d *Driver) readBlackList(ctx context.Context, op string) ([]blackEntry, error) {
	data, err := d.adminCall(ctx, op, "/admin/access_control?form=black_list", url.Values{"operation": {"load"}})
	if err != nil {
		return nil, err
	}
	var list []blackEntry
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, nil
	}
	return list, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	enabled, mode := d.readAccessMode(ctx, "blocked")
	if !enabled || mode == "white" {
		return nil, nil
	}
	list, err := d.readBlackList(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	var out []router.BlockEntry
	for _, e := range list {
		mac, err := router.NormalizeMAC(e.MAC)
		if err != nil {
			continue
		}
		managed := strings.HasPrefix(e.Name, ldTagPrefix)
		owner := router.OwnerAdmin
		if managed {
			owner = router.OwnerProduct
		}
		out = append(out, router.BlockEntry{
			MAC:       mac,
			Name:      strings.TrimPrefix(e.Name, ldTagPrefix),
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
	enabled, mode := d.readAccessMode(ctx, "block")
	if enabled && mode == "white" {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "TP-Link Access Control is in Whitelist mode; refusing to overwrite administrator policy")
	}
	list, err := d.readBlackList(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	for _, e := range list {
		if m, err := router.NormalizeMAC(e.MAC); err == nil && m == mac && enabled {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is already in TP-Link blacklist", Undo: undoBlock(mac)}, nil
		}
	}
	if !enabled {
		_, _ = d.adminCall(ctx, "block", "/admin/access_control?form=enable", url.Values{"operation": {"write"}, "enable": {"on"}})
	}
	if mode != "black" {
		_, _ = d.adminCall(ctx, "block", "/admin/access_control?form=mode", url.Values{"operation": {"write"}, "access_mode": {"black"}})
	}
	newJSON, _ := json.Marshal(map[string]string{
		"name": ldTagPrefix + mac,
		"mac":  strings.ToUpper(strings.ReplaceAll(mac, ":", "-")),
	})
	if _, err := d.adminCall(ctx, "block", "/admin/access_control?form=black_list", url.Values{
		"operation": {"insert"},
		"key":       {"add"},
		"index":     {"0"},
		"old":       {"add"},
		"new":       {string(newJSON)},
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to TP-Link Access Control blacklist", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	list, err := d.readBlackList(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	var targetKey string
	var targetIdx int
	for i, e := range list {
		if m, err := router.NormalizeMAC(e.MAC); err == nil && m == mac && strings.HasPrefix(e.Name, ldTagPrefix) {
			targetKey = first(e.Key, fmt.Sprintf("key-%d", i))
			targetIdx = i
			break
		}
	}
	if targetKey == "" {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "no managed TP-Link blacklist entry found"}, nil
	}
	if _, err := d.adminCall(ctx, "unblock", "/admin/access_control?form=black_list", url.Values{
		"operation": {"remove"},
		"key":       {targetKey},
		"index":     {strconv.Itoa(targetIdx)},
	}); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "removed managed TP-Link blacklist entry for " + strings.ToUpper(mac), Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn && len(d.stok) > 0 {
		_, _, _ = d.rawPost(ctx, "logout", "/cgi-bin/luci/;stok="+string(d.stok)+"/admin/system?form=logout", url.Values{"operation": {"write"}})
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s%s under Security → Access Control → Blacklist on TP-Link", ldTagPrefix, mac)
}

func tplinkConn(s string) router.ConnectionType {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5g"):
		return router.ConnWiFi5
	case strings.Contains(l, "2.4") || strings.Contains(l, "2g"):
		return router.ConnWiFi24
	case strings.Contains(l, "wireless") || strings.Contains(l, "wifi") || strings.Contains(l, "wlan"):
		return router.ConnWiFi
	case strings.Contains(l, "wired") || strings.Contains(l, "lan") || l == "0":
		return router.ConnWired
	default:
		return router.ConnUnknown
	}
}

func parseHMS(s string) (time.Duration, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 3 {
		return 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	sec, err3 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, false
	}
	return time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(sec)*time.Second, true
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
