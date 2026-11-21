// Package zyxeltest is a TEST DOUBLE of a Zyxel ZCFG/DAL web API, used only by `go test`.
//
// It speaks the same RSA + AES-256-CBC login and encrypted DAL bodies as the real firmware so the
// zyxel driver can be exercised end to end, with invented data. It is never part of a product
// binary: only _test.go files may import it, and internal/router's TestProductBinariesExcludeTestDouble
// fails the build check if lan-collector or router-probe ever depend on it.
package zyxeltest

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
)

// Host is one entry of the double's lanhosts table.
type Host struct {
	MAC        string // as the router writes it, e.g. "AA:BB:CC:00:00:01"
	IP         string
	DeviceName string
	CurName    string
	Icon       string
	ConnType   string // "Ethernet", "Wi-Fi 2.4GHz", "Wi-Fi 5GHz"
	Blocked    bool
	// Layer1 is the router-side interface, e.g. "Device.WiFi.SSID.1" or "Device.Ethernet.Interface.2".
	Layer1 string
}

// Config describes the device the double plays.
type Config struct {
	Model, Firmware string
	User, Password  string
	Hosts           []Host
	// NoBlockingSwitch removes Internet_Blocking_Enable from the host list (older/other firmware).
	NoBlockingSwitch bool
	// LockAfter failed logins the account is locked (0: never).
	LockAfter int
	// MAC filter (administrator rules) and parental-control profiles, read-only fixtures.
	MACFilterEnable, MACFilterDeny bool
	MACFilter                      []Host
	ParentalEnable                 bool
	ParentalProfiles               []map[string]any
	// ExpireEveryRequest makes every session expire right after login (a router that keeps dropping sessions).
	ExpireEveryRequest bool
	// Router-wide settings (docs/features/router-controls.md). Nil tables answer "unknown oid".
	LANIP, LANMask string
	Status         map[string]any   // Object[0] of oid=status
	WLAN           []map[string]any // oid=wlan objects, in order (Index = position + 1)
	StaticDHCP     []map[string]any // oid=static_dhcp objects
	NAT            []map[string]any // oid=nat objects
	// RejectPOST makes every POST to these oids fail (a router that refuses the change).
	RejectPOST map[string]bool
	// RotateSessionKey makes every change reply (DAL PUT/POST/DELETE) carry a new "sessionkey" that
	// replaces the CSRF token, as some firmware does; the router's web UI adopts it from any reply.
	RotateSessionKey bool
}

type sess struct {
	key  []byte
	csrf string
}

// Put is a decrypted change request the double received.
type Put struct {
	OID  string
	Body map[string]any
}

// Server is the running double.
type Server struct {
	*httptest.Server
	cfg  Config
	priv *rsa.PrivateKey

	mu       sync.Mutex
	sessions map[string]*sess
	failures int
	hosts    []Host

	Logins, FailedLogins, Logouts int
	Puts                          []Put
	// PlaintextPasswordSeen is set if any request carried the password unencrypted.
	PlaintextPasswordSeen bool
	// CSRFRejected counts change requests without a valid CSRFToken header.
	CSRFRejected int
	Deletes      []Put
	Reboots      int
	WlChecks     int

	wlan, staticDHCP, nat []map[string]any
	nextIndex             int
}

// Start runs the double over TLS with a self-signed certificate (like the real device).
func Start(cfg Config) *Server {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	s := &Server{cfg: cfg, priv: priv, sessions: map[string]*sess{}, hosts: append([]Host(nil), cfg.Hosts...),
		wlan: cloneAll(cfg.WLAN), staticDHCP: cloneAll(cfg.StaticDHCP), nat: cloneAll(cfg.NAT), nextIndex: 100}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(s.serve))
	return s
}

func cloneAll(in []map[string]any) []map[string]any {
	if in == nil {
		return nil
	}
	out := make([]map[string]any, 0, len(in))
	for _, m := range in {
		c := map[string]any{}
		for k, v := range m {
			c[k] = v
		}
		out = append(out, c)
	}
	return out
}

// WLAN, StaticDHCP and NAT return copies of the double's current tables.
func (s *Server) WLAN() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneAll(s.wlan)
}

func (s *Server) StaticDHCP() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneAll(s.staticDHCP)
}

func (s *Server) NAT() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneAll(s.nat)
}

// PinSHA256 is the hex SHA-256 of the double's certificate.
func (s *Server) PinSHA256() string {
	sum := sha256.Sum256(s.Certificate().Raw)
	return hex.EncodeToString(sum[:])
}

// ExpireSessions drops every session, as the router does on its idle timeout.
func (s *Server) ExpireSessions() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = map[string]*sess{}
}

// HostBlocked reports the double's current flag for mac (as configured, e.g. "AA:BB:...").
func (s *Server) HostBlocked(mac string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.hosts {
		if strings.EqualFold(h.MAC, mac) {
			return h.Blocked
		}
	}
	return false
}

// Host returns the double's current entry for mac.
func (s *Server) Host(mac string) Host {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.hosts {
		if strings.EqualFold(h.MAC, mac) {
			return h
		}
	}
	return Host{}
}

// ActiveSessions is the number of sessions not logged out.
func (s *Server) ActiveSessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func encryptFor(key []byte, v any) map[string]string {
	plain, _ := json.Marshal(v)
	iv := make([]byte, 32)
	_, _ = rand.Read(iv)
	n := aes.BlockSize - len(plain)%aes.BlockSize
	plain = append(plain, bytes.Repeat([]byte{byte(n)}, n)...)
	block, _ := aes.NewCipher(key)
	out := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, iv[:16]).CryptBlocks(out, plain)
	return map[string]string{"iv": base64.StdEncoding.EncodeToString(iv), "content": base64.StdEncoding.EncodeToString(out)}
}

func decryptWith(key []byte, content, ivB64 string) ([]byte, bool) {
	iv, err1 := base64.StdEncoding.DecodeString(ivB64)
	ct, err2 := base64.StdEncoding.DecodeString(content)
	if err1 != nil || err2 != nil || len(iv) < 16 || len(ct) == 0 || len(ct)%16 != 0 {
		return nil, false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, false
	}
	cipher.NewCBCDecrypter(block, iv[:16]).CryptBlocks(ct, ct)
	n := int(ct[len(ct)-1])
	if n == 0 || n > 16 {
		return nil, false
	}
	return ct[:len(ct)-n], true
}

func (s *Server) session(r *http.Request) (string, *sess) {
	c, err := r.Cookie("Session")
	if err != nil {
		return "", nil
	}
	return c.Value, s.sessions[c.Value]
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := readAll(r)
	if s.cfg.Password != "" && bytes.Contains(body, []byte(s.cfg.Password)) {
		s.mu.Lock()
		s.PlaintextPasswordSeen = true
		s.mu.Unlock()
	}
	switch r.URL.Path {
	case "/getBasicInformation":
		writeJSON(w, 200, map[string]any{"result": "ZCFG_SUCCESS", "ModelName": s.cfg.Model, "SoftwareVersion": s.cfg.Firmware,
			"CurrentLanguage": "en", "AvailableLanguages": "en", "RememberPassword": 0})
	case "/getRSAPublickKey":
		der, _ := x509.MarshalPKIXPublicKey(&s.priv.PublicKey)
		pemText := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
		writeJSON(w, 200, map[string]any{"result": "ZCFG_SUCCESS", "RSAPublicKey": string(pemText)})
	case "/UserLogin":
		s.login(w, r, body)
	case "/cgi-bin/UserLogout":
		s.mu.Lock()
		id, se := s.session(r)
		if se != nil && r.Header.Get("CSRFToken") != se.csrf {
			// A stale token: the session stays open (and blocks the next login on a single-session router).
			s.CSRFRejected++
			s.mu.Unlock()
			writeJSON(w, 403, map[string]any{"result": "ZCFG_FAIL"})
			return
		}
		if se != nil {
			delete(s.sessions, id)
			s.Logouts++
		}
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"result": "ZCFG_SUCCESS"})
	case "/cgi-bin/DAL":
		s.dal(w, r, body)
	case "/cgi-bin/Reboot", "/cgi-bin/Wireless":
		s.mu.Lock()
		_, se := s.session(r)
		switch {
		case se == nil:
			s.mu.Unlock()
			writeJSON(w, 401, map[string]any{"result": "ZCFG_NOT_AUTHORIZED"})
		case r.URL.Path == "/cgi-bin/Reboot" && (r.Method != http.MethodPost || r.Header.Get("CSRFToken") != se.csrf):
			s.CSRFRejected++
			s.mu.Unlock()
			writeJSON(w, 403, map[string]any{"result": "ZCFG_FAIL"})
		case r.URL.Path == "/cgi-bin/Reboot":
			s.Reboots++
			s.sessions = map[string]*sess{}
			s.mu.Unlock()
			writeJSON(w, 200, map[string]any{"result": "ZCFG_SUCCESS"})
		default:
			s.WlChecks++
			s.mu.Unlock()
			writeJSON(w, 200, map[string]any{"result": "ZCFG_SUCCESS"})
		}
	default:
		http.NotFound(w, r)
	}
}

func readAll(r *http.Request) ([]byte, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(r.Body)
	return b.Bytes(), err
}

func (s *Server) login(w http.ResponseWriter, r *http.Request, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cfg.LockAfter > 0 && s.failures >= s.cfg.LockAfter {
		writeJSON(w, 401, map[string]any{"result": "Locked User", "replyMsg": "lock time=60"})
		return
	}
	var env struct{ Content, Key, IV string }
	if json.Unmarshal(body, &env) != nil || env.Key == "" {
		writeJSON(w, 400, map[string]any{"result": "ZCFG_FAIL"})
		return
	}
	wrapped, _ := base64.StdEncoding.DecodeString(env.Key)
	keyB64, err := rsa.DecryptPKCS1v15(rand.Reader, s.priv, wrapped)
	if err != nil {
		writeJSON(w, 400, map[string]any{"result": "ZCFG_FAIL"})
		return
	}
	key, err := base64.StdEncoding.DecodeString(string(keyB64))
	if err != nil || len(key) != 32 {
		writeJSON(w, 400, map[string]any{"result": "ZCFG_FAIL"})
		return
	}
	plain, ok := decryptWith(key, env.Content, env.IV)
	if !ok {
		writeJSON(w, 400, map[string]any{"result": "ZCFG_FAIL"})
		return
	}
	var in struct {
		Input_Account string
		Input_Passwd  string
	}
	_ = json.Unmarshal(plain, &in)
	pw, _ := base64.StdEncoding.DecodeString(in.Input_Passwd)
	if in.Input_Account != s.cfg.User || string(pw) != s.cfg.Password {
		s.failures++
		s.FailedLogins++
		writeJSON(w, 401, map[string]any{"result": "Invalid Username or Password"})
		return
	}
	s.failures = 0
	s.Logins++
	idBytes := make([]byte, 6)
	_, _ = rand.Read(idBytes)
	id := strconv.FormatUint(uint64(idBytes[0])<<40|uint64(idBytes[1])<<32|uint64(idBytes[2])<<24|uint64(idBytes[3])<<16|uint64(idBytes[4])<<8|uint64(idBytes[5]), 10)
	csrfBytes := make([]byte, 16)
	_, _ = rand.Read(csrfBytes)
	se := &sess{key: key, csrf: hex.EncodeToString(csrfBytes)}
	if !s.cfg.ExpireEveryRequest {
		s.sessions[id] = se
	}
	http.SetCookie(w, &http.Cookie{Name: "Session", Value: id, Path: "/", HttpOnly: true})
	writeJSON(w, 200, encryptFor(key, map[string]any{"result": "ZCFG_SUCCESS", "sessionkey": se.csrf,
		"loginAccount": s.cfg.User, "loginLevel": "high", "ThemeColor": "yellow"}))
}

func (s *Server) hostJSON(h Host) map[string]any {
	m := map[string]any{"PhysAddress": h.MAC, "IPAddress": h.IP, "HostName": h.DeviceName, "DeviceName": h.DeviceName,
		"curHostName": h.CurName, "DeviceIcon": h.Icon, "icon": strings.ToLower(h.Icon), "X_ZYXEL_ConnectionType": h.ConnType, "Layer1Interface": h.Layer1, "Active": true}
	if !s.cfg.NoBlockingSwitch {
		m["Internet_Blocking_Enable"] = h.Blocked
	}
	return m
}

func (s *Server) table(oid string) *[]map[string]any {
	switch oid {
	case "wlan":
		return &s.wlan
	case "static_dhcp":
		return &s.staticDHCP
	case "nat":
		return &s.nat
	}
	var none []map[string]any
	return &none
}

func (s *Server) dal(w http.ResponseWriter, r *http.Request, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, se := s.session(r)
	if se == nil {
		writeJSON(w, 401, map[string]any{"result": "ZCFG_NOT_AUTHORIZED"})
		return
	}
	oid := r.URL.Query().Get("oid")
	reply := func(v map[string]any) {
		if s.cfg.RotateSessionKey && r.Method != http.MethodGet {
			b := make([]byte, 16)
			_, _ = rand.Read(b)
			se.csrf = hex.EncodeToString(b)
			v["sessionkey"] = se.csrf
		}
		writeJSON(w, 200, encryptFor(se.key, v))
	}
	switch r.Method {
	case http.MethodGet:
		switch oid {
		case "lanhosts":
			list := []map[string]any{}
			for _, h := range s.hosts {
				list = append(list, s.hostJSON(h))
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": []any{map[string]any{"lanhosts": list}}})
		case "macfilter":
			wl := []map[string]any{}
			for _, h := range s.cfg.MACFilter {
				wl = append(wl, map[string]any{"List_Enable": true, "HostName": h.DeviceName, "MACAddress": h.MAC})
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": []any{map[string]any{
				"MAC": map[string]any{"Filter_Enable": s.cfg.MACFilterEnable, "Restrict": s.cfg.MACFilterDeny}, "whitelist": wl}}})
		case "paren_ctl":
			objs := []any{map[string]any{"PrentalCtlEnable": s.cfg.ParentalEnable}}
			for _, p := range s.cfg.ParentalProfiles {
				objs = append(objs, p)
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": objs})
		case "lan":
			if s.cfg.LANIP == "" {
				reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "unknown oid"})
				return
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": []any{map[string]any{"Name": "Default", "IPAddress": s.cfg.LANIP, "SubnetMask": s.cfg.LANMask}}})
		case "status":
			if s.cfg.Status == nil {
				reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "unknown oid"})
				return
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": []any{s.cfg.Status}})
		case "wlan", "static_dhcp", "nat":
			t := s.table(oid)
			if *t == nil {
				reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "unknown oid"})
				return
			}
			objs := []any{}
			for _, o := range *t {
				objs = append(objs, o)
			}
			reply(map[string]any{"result": "ZCFG_SUCCESS", "Object": objs})
		default:
			reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "unknown oid"})
		}
	case http.MethodDelete:
		if r.Header.Get("CSRFToken") != se.csrf {
			s.CSRFRejected++
			writeJSON(w, 403, map[string]any{"result": "ZCFG_FAIL"})
			return
		}
		idx, _ := strconv.Atoi(r.URL.Query().Get("Index"))
		s.Deletes = append(s.Deletes, Put{OID: oid, Body: map[string]any{"Index": float64(idx)}})
		t := s.table(oid)
		for i, o := range *t {
			if v, _ := o["Index"].(float64); int(v) == idx {
				*t = append((*t)[:i], (*t)[i+1:]...)
				reply(map[string]any{"result": "ZCFG_SUCCESS"})
				return
			}
		}
		reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "no such entry"})
	case http.MethodPut, http.MethodPost:
		if r.Header.Get("CSRFToken") != se.csrf {
			s.CSRFRejected++
			writeJSON(w, 403, map[string]any{"result": "ZCFG_FAIL"})
			return
		}
		var env struct{ Content, IV string }
		_ = json.Unmarshal(body, &env)
		plain, ok := decryptWith(se.key, env.Content, env.IV)
		if !ok {
			writeJSON(w, 400, map[string]any{"result": "No AesKey"})
			return
		}
		var in map[string]any
		_ = json.Unmarshal(plain, &in)
		s.Puts = append(s.Puts, Put{OID: oid, Body: in})
		if r.Method == http.MethodPost && s.cfg.RejectPOST[oid] {
			reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "rejected"})
			return
		}
		switch {
		case oid == "wlan" && r.Method == http.MethodPut:
			idx, _ := in["Index"].(float64)
			en, ok := in["wlEnable"].(bool)
			if int(idx) < 1 || int(idx) > len(s.wlan) || !ok {
				reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "bad request"})
				return
			}
			s.wlan[int(idx)-1]["wlEnable"] = en
			reply(map[string]any{"result": "ZCFG_SUCCESS"})
			return
		case (oid == "static_dhcp" || oid == "nat") && r.Method == http.MethodPost:
			t := s.table(oid)
			s.nextIndex++
			in["Index"] = float64(s.nextIndex)
			*t = append(*t, in)
			reply(map[string]any{"result": "ZCFG_SUCCESS"})
			return
		}
		if oid != "lanhosts" || s.cfg.NoBlockingSwitch {
			reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "not supported"})
			return
		}
		mac, _ := in["MacAddress"].(string)
		want, _ := in["Internet_Blocking_Enable"].(bool)
		for i := range s.hosts {
			if strings.EqualFold(s.hosts[i].MAC, mac) {
				s.hosts[i].Blocked = want
				if n, _ := in["HostName"].(string); n != "" && n != s.hosts[i].DeviceName {
					s.hosts[i].CurName = n
				}
				if ic, ok := in["DeviceIcon"].(string); ok {
					s.hosts[i].Icon = ic
				}
				reply(map[string]any{"result": "ZCFG_SUCCESS"})
				return
			}
		}
		reply(map[string]any{"result": "ZCFG_FAIL", "ReplyMsg": "no such host"})
	default:
		writeJSON(w, 405, map[string]any{"result": "ZCFG_FAIL"})
	}
}
