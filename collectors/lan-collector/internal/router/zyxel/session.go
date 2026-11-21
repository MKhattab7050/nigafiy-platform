package zyxel

// The ZCFG web API, as used by the router's own web UI (static/js/app.js, function
// httpReqSendAndRecv / AesRsaEncrypt / AesDecrypt):
//
//   GET  /getBasicInformation  public  {"result":"ZCFG_SUCCESS","ModelName":..,"SoftwareVersion":..,"CurrentLanguage":..}
//   GET  /getRSAPublickKey     public  {"result":"ZCFG_SUCCESS","RSAPublicKey":"-----BEGIN PUBLIC KEY-----..."}  (RSA-2048, PKIX PEM)
//   POST /UserLogin            body {"content":C,"key":K,"iv":IV}
//        A = 32 random bytes (AES-256 key), sent as base64 text;  IV = 32 random bytes, base64 (CBC uses the first 16)
//        C = base64(AES-256-CBC-PKCS7(A, IV[:16], JSON{Input_Account, Input_Passwd: base64(password), currLang, RememberPassword, SHA512_password}))
//        K = base64(RSA-PKCS1v1.5-encrypt(pub, base64(A)))     (JSEncrypt encrypts the base64 *text* of the key)
//        200 -> {"iv":..,"content":..} encrypted with A -> {"result":"ZCFG_SUCCESS","sessionkey":..,"loginAccount":..,"loginLevel":..}
//               plus Set-Cookie (the session cookie, "Session" per third-party write-ups)
//        401 -> plain {"result":"Invalid Username or Password" | "Locked User" (replyMsg "...=<seconds>") | "Duplicated login" |
//                     "Maxium number of login account has reached" | "A user exist"}
//   GET  /cgi-bin/DAL?oid=<name>           response may be {"iv","content"} encrypted with A, else plain JSON
//   PUT/POST/DELETE /cgi-bin/...           header "CSRFToken: <sessionkey>"; PUT/POST body {"content":C,"key":"","iv":IV} with A
//   POST /cgi-bin/UserLogout               CSRFToken header, empty body
//   401/403 on /cgi-bin, or {"result":"No AesKey"} -> the session is gone.

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

// envelope is the encrypted body format in both directions.
type envelope struct {
	Content string `json:"content"`
	Key     string `json:"key,omitempty"`
	IV      string `json:"iv"`
}

// session holds everything that must be erased at logout.
type session struct {
	aesKey     []byte // 32 bytes
	csrf       []byte // sessionkey
	cookies    [][]byte
	loggedIn   bool
	loginCount int
}

func (s *session) wipe() {
	router.Zero(s.aesKey)
	router.Zero(s.csrf)
	for _, c := range s.cookies {
		router.Zero(c)
	}
	*s = session{loginCount: s.loginCount}
}

func pkcs7Pad(b []byte) []byte {
	n := aes.BlockSize - len(b)%aes.BlockSize
	out := make([]byte, len(b)+n)
	copy(out, b)
	for i := len(b); i < len(out); i++ {
		out[i] = byte(n)
	}
	return out
}

func pkcs7Unpad(b []byte) ([]byte, bool) {
	if len(b) == 0 || len(b)%aes.BlockSize != 0 {
		return nil, false
	}
	n := int(b[len(b)-1])
	if n == 0 || n > aes.BlockSize || n > len(b) {
		return nil, false
	}
	for _, c := range b[len(b)-n:] {
		if int(c) != n {
			return nil, false
		}
	}
	return b[:len(b)-n], true
}

// encrypt returns base64 content and base64 IV (32 random bytes; CBC uses the first 16, like CryptoJS).
func encrypt(key, plain []byte) (content, ivB64 string, err error) {
	iv := make([]byte, 32)
	if _, err := rand.Read(iv); err != nil {
		return "", "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	padded := pkcs7Pad(plain)
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv[:aes.BlockSize]).CryptBlocks(out, padded)
	router.Zero(padded)
	return base64.StdEncoding.EncodeToString(out), base64.StdEncoding.EncodeToString(iv), nil
}

// decrypt reverses encrypt. The caller zeroes the result when done.
func decrypt(key []byte, content, ivB64 string) ([]byte, error) {
	iv, err := base64.StdEncoding.DecodeString(ivB64)
	if err != nil || len(iv) < aes.BlockSize {
		return nil, router.Errorf(router.ErrProtocol, "decrypt", "bad IV")
	}
	ct, err := base64.StdEncoding.DecodeString(content)
	if err != nil || len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, router.Errorf(router.ErrProtocol, "decrypt", "bad ciphertext")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, router.Errorf(router.ErrProtocol, "decrypt", "bad key")
	}
	cipher.NewCBCDecrypter(block, iv[:aes.BlockSize]).CryptBlocks(ct, ct)
	plain, ok := pkcs7Unpad(ct)
	if !ok {
		router.Zero(ct)
		return nil, router.Errorf(router.ErrProtocol, "decrypt", "could not decrypt the response (wrong session key?)")
	}
	return plain, nil
}

func parsePublicKey(pemText string) (*rsa.PublicKey, error) {
	blk, _ := pem.Decode([]byte(pemText))
	if blk == nil {
		return nil, router.Errorf(router.ErrProtocol, "login", "RSA public key is not PEM")
	}
	if k, err := x509.ParsePKIXPublicKey(blk.Bytes); err == nil {
		if rk, ok := k.(*rsa.PublicKey); ok {
			return rk, nil
		}
	}
	if rk, err := x509.ParsePKCS1PublicKey(blk.Bytes); err == nil {
		return rk, nil
	}
	return nil, router.Errorf(router.ErrProtocol, "login", "unsupported RSA public key")
}

// loginBody builds the login JSON in a byte slice so the password copy can be zeroed.
func loginBody(user string, password []byte, lang string) []byte {
	pw := make([]byte, base64.StdEncoding.EncodedLen(len(password)))
	base64.StdEncoding.Encode(pw, password)
	u, _ := json.Marshal(user)
	l, _ := json.Marshal(lang)
	var b bytes.Buffer
	b.Grow(128 + len(pw))
	b.WriteString(`{"Input_Account":`)
	b.Write(u)
	b.WriteString(`,"Input_Passwd":"`)
	b.Write(pw) // base64 alphabet needs no JSON escaping
	b.WriteString(`","currLang":`)
	b.Write(l)
	b.WriteString(`,"RememberPassword":0,"SHA512_password":false}`)
	router.Zero(pw)
	out := b.Bytes()
	return out
}

// do performs one HTTP request with the session cookie (and CSRF token when csrf is set).
// It returns the status and the (possibly decrypted) body; the caller zeroes body when done.
func (d *Driver) do(ctx context.Context, op, method, path string, body []byte, csrf bool) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, router.Errorf(router.ErrInvalidArgument, op, "bad request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("If-Modified-Since", "Thu, 01 Jun 1970 00:00:00 GMT")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if len(d.sess.cookies) > 0 {
		parts := make([]string, len(d.sess.cookies))
		for i, c := range d.sess.cookies {
			parts[i] = string(c)
		}
		req.Header.Set("Cookie", strings.Join(parts, "; "))
	}
	if csrf && len(d.sess.csrf) > 0 {
		req.Header.Set("CSRFToken", string(d.sess.csrf))
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
		d.setCookie(c.Name, c.Value)
	}
	// Decrypt an encrypted envelope (UserLogin and /cgi-bin responses) with the session key.
	if len(d.sess.aesKey) == 32 && bytes.Contains(raw, []byte(`"content"`)) && bytes.Contains(raw, []byte(`"iv"`)) {
		var env envelope
		if json.Unmarshal(raw, &env) == nil && env.Content != "" && env.IV != "" {
			plain, err := decrypt(d.sess.aesKey, env.Content, env.IV)
			router.Zero(raw)
			if err != nil {
				return resp.StatusCode, nil, err
			}
			return resp.StatusCode, plain, nil
		}
	}
	return resp.StatusCode, raw, nil
}

func (d *Driver) setCookie(name, value string) {
	if name == "" {
		return
	}
	prefix := []byte(name + "=")
	for i, c := range d.sess.cookies {
		if bytes.HasPrefix(c, prefix) {
			router.Zero(c)
			d.sess.cookies[i] = append(prefix, value...)
			return
		}
	}
	d.sess.cookies = append(d.sess.cookies, append(prefix, value...))
}

type loginReply struct {
	Result     string `json:"result"`
	ReplyMsg   string `json:"replyMsg"`
	SessionKey string `json:"sessionkey"`
	Level      string `json:"loginLevel"`
}

// login performs the RSA/AES login. The password is fetched from the credential source only here
// and zeroed before this function returns.
func (d *Driver) login(ctx context.Context) error {
	if d.creds == nil {
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login"}
	}
	d.sess.wipe()
	status, raw, err := d.do(ctx, "login", http.MethodGet, "/getRSAPublickKey", nil, false)
	if err != nil {
		return err
	}
	var keyReply struct {
		Result       string `json:"result"`
		RSAPublicKey string `json:"RSAPublicKey"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &keyReply) != nil || keyReply.RSAPublicKey == "" {
		return router.Errorf(router.ErrProtocol, "login", "no RSA public key (HTTP %d)", status)
	}
	pub, err := parsePublicKey(keyReply.RSAPublicKey)
	if err != nil {
		return err
	}

	user, password, err := d.creds(ctx)
	if err != nil {
		router.Zero(password)
		return &router.Error{Kind: router.ErrCredentialSource, Op: "login"}
	}
	plain := loginBody(user, password, d.lang())
	router.Zero(password)

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		router.Zero(plain)
		return err
	}
	keyB64 := []byte(base64.StdEncoding.EncodeToString(key))
	content, iv, err := encrypt(key, plain)
	router.Zero(plain)
	if err != nil {
		router.Zero(key)
		router.Zero(keyB64)
		return err
	}
	wrapped, err := rsa.EncryptPKCS1v15(rand.Reader, pub, keyB64)
	router.Zero(keyB64)
	if err != nil {
		router.Zero(key)
		return router.Errorf(router.ErrProtocol, "login", "RSA encryption failed")
	}
	body, _ := json.Marshal(envelope{Content: content, Key: base64.StdEncoding.EncodeToString(wrapped), IV: iv})
	d.sess.aesKey = key
	d.sess.loginCount++

	status, raw, err = d.do(ctx, "login", http.MethodPost, "/UserLogin", body, false)
	router.Zero(body)
	if err != nil {
		d.sess.wipe()
		return err
	}
	var rep loginReply
	perr := json.Unmarshal(raw, &rep)
	router.Zero(raw)
	if status == http.StatusOK && perr == nil && rep.Result == "ZCFG_SUCCESS" && rep.SessionKey != "" {
		d.sess.csrf = []byte(rep.SessionKey)
		d.sess.loggedIn = true
		return nil
	}
	d.sess.wipe()
	return loginError(status, rep, perr)
}

func loginError(status int, rep loginReply, perr error) error {
	switch rep.Result {
	case "Invalid Username or Password":
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login"}
	case "Locked User":
		e := &router.Error{Kind: router.ErrLockedOut, Op: "login"}
		if i := strings.LastIndex(rep.ReplyMsg, "="); i >= 0 {
			if secs, err := strconv.Atoi(strings.TrimSpace(rep.ReplyMsg[i+1:])); err == nil && secs > 0 {
				e.RetryAfter = time.Duration(secs) * time.Second
			}
		}
		return e
	case "Duplicated login", "Maxium number of login account has reached", "A user exist":
		return &router.Error{Kind: router.ErrSessionLimit, Op: "login", Detail: rep.Result}
	}
	if status == http.StatusUnauthorized {
		return &router.Error{Kind: router.ErrBadCredentials, Op: "login", Detail: "HTTP 401"}
	}
	if perr != nil {
		return router.Errorf(router.ErrProtocol, "login", "unreadable login reply (HTTP %d)", status)
	}
	return router.Errorf(router.ErrProtocol, "login", "unexpected login reply (HTTP %d, result %q)", status, truncate(rep.Result, 60))
}

// logout ends the session on the router and wipes local material whatever the outcome.
func (d *Driver) logout(ctx context.Context) error {
	if !d.sess.loggedIn {
		d.sess.wipe()
		return nil
	}
	_, raw, err := d.do(ctx, "logout", http.MethodPost, "/cgi-bin/UserLogout", nil, true)
	router.Zero(raw)
	d.sess.wipe()
	return err
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
