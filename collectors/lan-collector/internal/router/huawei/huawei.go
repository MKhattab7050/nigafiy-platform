// Package huawei drives Huawei home/ISP VDSL & Fiber gateways (DG8045, HG630, HG633, HG8145V5,
// WS5200, AX3 — widely deployed by WE, Etisalat, STC, Orange, Vodafone) over their HTTP(S) web API.
// It registers itself as vendor "huawei".
//
// Mechanisms used:
//   - login:    Huawei SCRAM-SHA-256 challenge-response (/api/system/user_login_nonce →
//               /api/system/user_login_proof) with CSRF tokens from <meta name="csrf_param|csrf_token">
//   - identify: GET /api/system/deviceinfo
//   - clients:  GET /api/system/HostInfo
//   - block:    GET/POST /api/ntwk/macfilter (adds/removes LD:-tagged blacklist entries while
//               refusing to overwrite an administrator's whitelist mode or admin rules)
//   - logout:   POST /api/system/user_logout.
package huawei

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// Vendor is the registry key.
const Vendor = "huawei"

const (
	ldTagPrefix = "LD:"
	mechBlock   = "Huawei gateway MAC blacklist (/api/ntwk/macfilter)"
)

func init() {
	router.Register(Vendor, func(t router.Target, creds router.CredentialSource) (router.Driver, error) {
		return New(t, creds)
	})
}

var _ router.Driver = (*Driver)(nil)

var (
	reCSRFParam = regexp.MustCompile(`<meta\s+name=["']csrf_param["']\s+content=["']([^"']+)["']`)
	reCSRFToken = regexp.MustCompile(`<meta\s+name=["']csrf_token["']\s+content=["']([^"']+)["']`)
)

// Driver talks to one Huawei home/ISP gateway.
type Driver struct {
	target    router.Target
	base      string
	http      *http.Client
	creds     router.CredentialSource
	cookies   [][]byte
	csrfParam []byte
	csrfToken []byte
	loggedIn  bool
	info      *router.Info
}

// New builds a Huawei gateway driver for t.
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
	router.Zero(d.csrfParam)
	router.Zero(d.csrfToken)
	d.cookies = nil
	d.csrfParam = nil
	d.csrfToken = nil
	d.loggedIn = false
}

func (d *Driver) setCSRF(param, token string) {
	if param != "" {
		router.Zero(d.csrfParam)
		d.csrfParam = []byte(param)
	}
	if token != "" {
		router.Zero(d.csrfToken)
		d.csrfToken = []byte(token)
	}
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

func (d *Driver) rawDo(ctx context.Context, op, method, path string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if len(d.cookies) > 0 {
		parts := make([]string, len(d.cookies))
		for i, c := range d.cookies {
			parts[i] = string(c)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
	}
	if len(d.csrfToken) > 0 && method != http.MethodGet {
		req.Header.Set("_ResponseSource", "Broswer")
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
	if p := resp.Header.Get("csrf_param"); p != "" {
		d.setCSRF(p, resp.Header.Get("csrf_token"))
	}
	return resp.StatusCode, raw, nil
}

// cleanJSON strips Huawei's anti-XSS JSON prefix (`while(1); /*...*/`).
func cleanJSON(raw []byte) []byte {
	s := strings.TrimSpace(string(raw))
	s = strings.TrimPrefix(s, "while(1);")
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "/*") && strings.HasSuffix(s, "*/") {
		s = strings.TrimSpace(s[2 : len(s)-2])
	}
	return []byte(s)
}

func (d *Driver) fetchInitialCSRF(ctx context.Context) error {
	for _, p := range []string{"/", "/html/index.html"} {
		st, raw, err := d.rawDo(ctx, "login", http.MethodGet, p, nil)
		if err != nil {
			return err
		}
		if st != http.StatusOK {
			continue
		}
		pm := reCSRFParam.FindSubmatch(raw)
		tm := reCSRFToken.FindSubmatch(raw)
		if len(pm) == 2 && len(tm) == 2 {
			d.setCSRF(string(pm[1]), string(tm[1]))
			return nil
		}
	}
	return nil
}

// pbkdf2SHA256 derives a 32-byte key with PBKDF2-HMAC-SHA256 using only the Go standard library.
func pbkdf2SHA256(password, salt []byte, iter int) []byte {
	if iter <= 0 {
		iter = 100
	}
	mac := hmac.New(sha256.New, password)
	mac.Write(salt)
	mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	out := append([]byte(nil), u...)
	for i := 1; i < iter; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(u[:0])
		for j := range out {
			out[j] ^= u[j]
		}
	}
	router.Zero(u)
	return out
}

// huaweiClientProof implements Huawei's SCRAM-SHA-256 variant (swapped HMAC key/data order).
func huaweiClientProof(password []byte, saltHex string, iterations int, firstNonce, serverNonce string) (string, error) {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		salt = []byte(saltHex)
	}
	salted := pbkdf2SHA256(password, salt, iterations)
	defer router.Zero(salted)

	// Huawei variant: HMAC-SHA256(key="Client Key", data=saltedPassword)
	ckMAC := hmac.New(sha256.New, []byte("Client Key"))
	ckMAC.Write(salted)
	clientKey := ckMAC.Sum(nil)
	defer router.Zero(clientKey)

	storedKey := sha256.Sum256(clientKey)
	authMsg := firstNonce + "," + serverNonce + "," + serverNonce
	// Huawei variant: HMAC-SHA256(key=authMsg, data=storedKey)
	sigMAC := hmac.New(sha256.New, []byte(authMsg))
	sigMAC.Write(storedKey[:])
	clientSig := sigMAC.Sum(nil)
	defer router.Zero(clientSig)

	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ clientSig[i]
	}
	out := hex.EncodeToString(proof)
	router.Zero(proof)
	return out, nil
}

func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login", Detail: "no credential source"}
	}
	if err := d.fetchInitialCSRF(ctx); err != nil {
		return err
	}
	user, pass, err := d.creds(ctx)
	if err != nil {
		return err
	}
	defer router.Zero(pass)

	nonceBytes := make([]byte, 32)
	_, _ = rand.Read(nonceBytes)
	firstNonce := hex.EncodeToString(nonceBytes)

	nonceReq, _ := json.Marshal(map[string]any{
		"csrf": map[string]string{"csrf_param": string(d.csrfParam), "csrf_token": string(d.csrfToken)},
		"data": map[string]string{"username": user, "firstnonce": firstNonce},
	})
	st, raw, err := d.rawDo(ctx, "login", http.MethodPost, "/api/system/user_login_nonce", nonceReq)
	if err != nil {
		return err
	}
	if st != http.StatusOK {
		return router.Errorf(router.ErrProtocol, "login", "user_login_nonce returned HTTP %d", st)
	}
	var nr struct {
		Err         int    `json:"err"`
		Salt        string `json:"salt"`
		Iterations  int    `json:"iterations"`
		ServerNonce string `json:"servernonce"`
		CSRFParam   string `json:"csrf_param"`
		CSRFToken   string `json:"csrf_token"`
	}
	if err := json.Unmarshal(cleanJSON(raw), &nr); err != nil || nr.ServerNonce == "" {
		return router.Errorf(router.ErrProtocol, "login", "unreadable Huawei login nonce response")
	}
	d.setCSRF(nr.CSRFParam, nr.CSRFToken)

	proof, err := huaweiClientProof(pass, nr.Salt, nr.Iterations, firstNonce, nr.ServerNonce)
	if err != nil {
		return err
	}
	proofReq, _ := json.Marshal(map[string]any{
		"csrf": map[string]string{"csrf_param": string(d.csrfParam), "csrf_token": string(d.csrfToken)},
		"data": map[string]string{"clientproof": proof, "finalnonce": nr.ServerNonce},
	})
	defer router.Zero(proofReq)

	st, raw, err = d.rawDo(ctx, "login", http.MethodPost, "/api/system/user_login_proof", proofReq)
	if err != nil {
		return err
	}
	var pr struct {
		Err          int    `json:"err"`
		ErrorCat     string `json:"errorCategory"`
		Count        int    `json:"count"`
		RetryTime    int    `json:"retryTime"`
		CSRFParam    string `json:"csrf_param"`
		CSRFToken    string `json:"csrf_token"`
		ServerSignature string `json:"serversignature"`
	}
	if err := json.Unmarshal(cleanJSON(raw), &pr); err != nil {
		return router.Errorf(router.ErrProtocol, "login", "unreadable Huawei login proof response (HTTP %d)", st)
	}
	d.setCSRF(pr.CSRFParam, pr.CSRFToken)
	if pr.RetryTime > 0 || pr.Err == 3 || strings.Contains(strings.ToLower(pr.ErrorCat), "lock") {
		return &router.Error{Kind: router.ErrLockedOut, Op: "login", Detail: "Huawei gateway locked logins", RetryAfter: time.Duration(pr.RetryTime) * time.Second}
	}
	if st == http.StatusUnauthorized || pr.Err != 0 {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: fmt.Sprintf("Huawei login rejected (err=%d)", pr.Err)}
	}
	d.loggedIn = true
	return nil
}

func (d *Driver) getJSON(ctx context.Context, op, path string) ([]byte, error) {
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
	return cleanJSON(raw), nil
}

func (d *Driver) postJSON(ctx context.Context, op, path string, data any) ([]byte, error) {
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return nil, err
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"csrf": map[string]string{"csrf_param": string(d.csrfParam), "csrf_token": string(d.csrfToken)},
		"data": data,
	})
	st, raw, err := d.rawDo(ctx, op, http.MethodPost, path, payload)
	if err != nil {
		return nil, err
	}
	if st != http.StatusOK {
		return nil, router.Errorf(router.ErrRejected, op, "%s returned HTTP %d", path, st)
	}
	cleaned := cleanJSON(raw)
	var meta struct {
		CSRFParam string `json:"csrf_param"`
		CSRFToken string `json:"csrf_token"`
		Err       int    `json:"err"`
	}
	if json.Unmarshal(cleaned, &meta) == nil {
		d.setCSRF(meta.CSRFParam, meta.CSRFToken)
		if meta.Err != 0 {
			return nil, router.Errorf(router.ErrRejected, op, "Huawei API returned err=%d", meta.Err)
		}
	}
	return cleaned, nil
}

func (d *Driver) Identify(ctx context.Context) (router.Info, error) {
	raw, err := d.getJSON(ctx, "identify", "/api/system/deviceinfo")
	if err != nil {
		return router.Info{}, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return router.Info{}, router.Errorf(router.ErrProtocol, "identify", "unreadable Huawei deviceinfo")
	}
	info := router.Info{
		Vendor:   "Huawei",
		Model:    first(str(m["DeviceName"]), str(m["ProductName"]), str(m["ModelName"]), "Huawei Gateway"),
		Firmware: first(str(m["SoftwareVersion"]), str(m["FirmwareVersion"])),
		Extra:    map[string]string{},
	}
	if hw := str(m["HardwareVersion"]); hw != "" {
		info.Extra["hardware"] = hw
	}
	if sn := str(m["SerialNumber"]); sn != "" {
		info.Extra["serial"] = sn
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
		{Capability: router.CapClients, Supported: true, Mechanism: "Huawei gateway /api/system/HostInfo"},
		{Capability: router.CapDHCPLeases, Supported: true, Mechanism: "Huawei gateway HostInfo lease fields"},
		{Capability: router.CapBlock, Supported: true, Mechanism: mechBlock, Note: "Manages LD:-tagged entries in MAC blacklist mode; never alters whitelist mode or admin entries"},
		{Capability: router.CapRateLimit, Supported: false, Note: "Not uniformly supported across Huawei VDSL/ONT firmware builds"},
		{Capability: router.CapSchedule, Supported: false, Note: "Parental-control schedules differ across ISP firmware customizations"},
		{Capability: router.CapOverview, Supported: true, Mechanism: mechOverview},
		{Capability: router.CapWiFi, Supported: true, Mechanism: mechWiFi},
		{Capability: router.CapReservations, Supported: true, Mechanism: mechReservation},
		{Capability: router.CapPortForward, Supported: true, Mechanism: mechPortForward},
		{Capability: router.CapRename, Supported: true, Mechanism: mechRename},
		{Capability: router.CapReboot, Supported: true, Mechanism: mechReboot},
	}, nil
}

func (d *Driver) Clients(ctx context.Context) ([]router.Client, error) {
	raw, err := d.getJSON(ctx, "clients", "/api/system/HostInfo")
	if err != nil {
		return nil, err
	}
	var hosts []map[string]any
	if err := json.Unmarshal(raw, &hosts); err != nil {
		return nil, router.Errorf(router.ErrProtocol, "clients", "unexpected HostInfo JSON array")
	}
	blockedMACs := map[string]bool{}
	if bl, err := d.Blocked(ctx); err == nil {
		for _, b := range bl {
			blockedMACs[b.MAC] = true
		}
	}
	var out []router.Client
	for _, h := range hosts {
		mac, err := router.NormalizeMAC(str(h["MACAddress"]))
		if err != nil {
			continue
		}
		active := boolOf(h["Active"])
		blk := blockedMACs[mac] || boolOf(h["Blacklist"])
		c := router.Client{
			MAC:        mac,
			IP:         str(h["IPAddress"]),
			Hostname:   first(str(h["HostName"]), str(h["ActualName"])),
			Connection: huaweiConn(first(str(h["InterfaceType"]), str(h["Layer2Interface"]))),
			Interface:  first(str(h["Layer2Interface"]), str(h["SSID"])),
			Active:     &active,
			Blocked:    &blk,
			Raw:        map[string]string{},
		}
		if sig, err := strconv.Atoi(strings.TrimSpace(str(h["SignalStrength"]))); err == nil && sig < 0 && sig > -120 {
			c.SignalDBm = &sig
		}
		if src := strings.ToLower(str(h["AddressSource"])); src != "" || str(h["LeaseTime"]) != "" {
			lease := &router.Lease{Source: src}
			if secs, err := strconv.Atoi(str(h["LeaseTime"])); err == nil && secs > 0 {
				dur := time.Duration(secs) * time.Second
				lease.Remaining = &dur
			}
			c.Lease = lease
		}
		for k, v := range h {
			if s := str(v); s != "" {
				c.Raw[k] = s
			}
		}
		out = append(out, c)
	}
	router.SortClients(out)
	return out, nil
}

type macFilterCfg struct {
	Enable  bool             `json:"Enable"`
	Mode    string           `json:"Mode"` // "Blacklist" or "Whitelist"
	Entries []macFilterEntry `json:"Entries"`
}

type macFilterEntry struct {
	MAC  string `json:"MACAddress"`
	Name string `json:"DeviceName"`
}

func (d *Driver) readMacFilter(ctx context.Context, op string) (macFilterCfg, error) {
	raw, err := d.getJSON(ctx, op, "/api/ntwk/macfilter")
	if err != nil {
		return macFilterCfg{}, err
	}
	var cfg macFilterCfg
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return macFilterCfg{}, router.Errorf(router.ErrProtocol, op, "unreadable Huawei macfilter JSON")
	}
	return cfg, nil
}

func (d *Driver) Blocked(ctx context.Context) ([]router.BlockEntry, error) {
	cfg, err := d.readMacFilter(ctx, "blocked")
	if err != nil {
		return nil, err
	}
	if !cfg.Enable || strings.EqualFold(cfg.Mode, "whitelist") {
		return nil, nil
	}
	var out []router.BlockEntry
	for _, e := range cfg.Entries {
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
	cfg, err := d.readMacFilter(ctx, "block")
	if err != nil {
		return router.Change{}, err
	}
	if cfg.Enable && strings.EqualFold(cfg.Mode, "whitelist") {
		return router.Change{}, router.Errorf(router.ErrRejected, "block", "Huawei MAC filter is in Whitelist (Allow) mode; refusing to overwrite administrator policy")
	}
	for _, e := range cfg.Entries {
		if m, err := router.NormalizeMAC(e.MAC); err == nil && m == mac && cfg.Enable {
			return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "MAC is already in Huawei blacklist", Undo: undoBlock(mac)}, nil
		}
	}
	cfg.Enable = true
	cfg.Mode = "Blacklist"
	cfg.Entries = append(cfg.Entries, macFilterEntry{MAC: strings.ToUpper(mac), Name: ldTagPrefix + mac})
	if _, err := d.postJSON(ctx, "block", "/api/ntwk/macfilter", cfg); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "block", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: "added " + strings.ToUpper(mac) + " to Huawei MAC blacklist", Undo: undoBlock(mac)}, nil
}

func (d *Driver) Unblock(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	cfg, err := d.readMacFilter(ctx, "unblock")
	if err != nil {
		return router.Change{}, err
	}
	var kept []macFilterEntry
	removed := 0
	for _, e := range cfg.Entries {
		if m, err := router.NormalizeMAC(e.MAC); err == nil && m == mac && strings.HasPrefix(e.Name, ldTagPrefix) {
			removed++
			continue
		}
		kept = append(kept, e)
	}
	if removed == 0 {
		return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: false, AlreadyInEffect: true, Detail: "no managed Huawei blacklist entry found"}, nil
	}
	cfg.Entries = kept
	if _, err := d.postJSON(ctx, "unblock", "/api/ntwk/macfilter", cfg); err != nil {
		return router.Change{}, err
	}
	return router.Change{Action: "unblock", MAC: mac, Mechanism: mechBlock, Applied: true, Detail: fmt.Sprintf("removed %d managed Huawei blacklist entry(s)", removed), Undo: "Block the device again in LAN Detective"}, nil
}

func (d *Driver) Close(ctx context.Context) error {
	defer d.wipeSession()
	if d.loggedIn {
		_, _ = d.postJSON(ctx, "logout", "/api/system/user_logout", map[string]any{})
	}
	return nil
}

func undoBlock(mac string) string {
	return fmt.Sprintf("Unblock in LAN Detective, or remove %s%s under Security → MAC Filter on the Huawei gateway", ldTagPrefix, mac)
}

func huaweiConn(s string) router.ConnectionType {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "6g"):
		return router.ConnWiFi6
	case strings.Contains(l, "5g") || strings.Contains(l, "5."):
		return router.ConnWiFi5
	case strings.Contains(l, "2.4") || strings.Contains(l, "2g"):
		return router.ConnWiFi24
	case strings.Contains(l, "802.11") || strings.Contains(l, "wifi") || strings.Contains(l, "wlan"):
		return router.ConnWiFi
	case strings.Contains(l, "eth") || strings.Contains(l, "lan"):
		return router.ConnWired
	default:
		return router.ConnUnknown
	}
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

func boolOf(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x == "1" || strings.EqualFold(x, "true")
	default:
		return false
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
