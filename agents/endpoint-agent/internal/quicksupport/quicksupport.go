// Package quicksupport is the program side of Nigafiy Quick Support (nigafiy-support.exe): the
// server binding Fleet appends to the program when an operator downloads it, its signature check,
// and the registration that gives the person a 9-digit code and a one-time PIN.
//
// The binding is "\n" + JSON + u32le(len(JSON)) + "NIGAFIYQS1" at the end of the file. The JSON
// holds the payload (server URL, TLS pin, the signed organization link, the server's Ed25519 key)
// and an Ed25519 signature over "nigafiy-qs1\n" + payload. A changed server URL breaks the
// signature, so a download cannot be redirected to another server. At registration the program
// sends a random nonce and the server signs nonce + code with the same key, which only the server
// that made the download holds. (Replacing the whole program, key included, is not something a
// program can detect about itself; the key fingerprint is shown on screen and in Fleet so both
// sides can compare it.)
package quicksupport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var magic = []byte("NIGAFIYQS1")

var ErrNoBinding = errors.New("this copy of Nigafiy Quick Support has no server binding: download it again from Nigafiy Fleet")

type Binding struct {
	V        int    `json:"v"`
	Server   string `json:"server"`
	TLSPin   string `json:"tls_pin"`
	Link     string `json:"link"`
	IssuedBy string `json:"issued_by"`
	Key      string `json:"key"`
	key      ed25519.PublicKey
}

type trailer struct {
	Payload string `json:"payload"`
	Sig     string `json:"sig"`
}

// ReadBinding reads and verifies the binding at the end of the program file.
func ReadBinding(path string) (Binding, error) {
	f, err := os.Open(path)
	if err != nil {
		return Binding{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Binding{}, err
	}
	tail := int64(4 + len(magic))
	if st.Size() < tail {
		return Binding{}, ErrNoBinding
	}
	end := make([]byte, tail)
	if _, err := f.ReadAt(end, st.Size()-tail); err != nil {
		return Binding{}, err
	}
	if !bytes.Equal(end[4:], magic) {
		return Binding{}, ErrNoBinding
	}
	n := int64(binary.LittleEndian.Uint32(end[:4]))
	if n <= 0 || n > 64<<10 || n > st.Size()-tail {
		return Binding{}, errors.New("the server binding of this program is damaged: download it again from Nigafiy Fleet")
	}
	raw := make([]byte, n)
	if _, err := f.ReadAt(raw, st.Size()-tail-n); err != nil {
		return Binding{}, err
	}
	return ParseBinding(raw)
}

// ParseBinding checks the signature with the key inside the payload.
func ParseBinding(raw []byte) (Binding, error) {
	bad := errors.New("the server binding of this program is not signed correctly: download it again from Nigafiy Fleet")
	var t trailer
	if err := json.Unmarshal(raw, &t); err != nil {
		return Binding{}, bad
	}
	payload, err1 := base64.StdEncoding.DecodeString(t.Payload)
	sig, err2 := base64.StdEncoding.DecodeString(t.Sig)
	if err1 != nil || err2 != nil {
		return Binding{}, bad
	}
	var b Binding
	if err := json.Unmarshal(payload, &b); err != nil || b.V != 1 {
		return Binding{}, bad
	}
	key, err := base64.StdEncoding.DecodeString(b.Key)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return Binding{}, bad
	}
	if !ed25519.Verify(key, append([]byte("nigafiy-qs1\n"), payload...), sig) {
		return Binding{}, bad
	}
	if !strings.HasPrefix(b.Server, "https://") && !strings.HasPrefix(b.Server, "http://") {
		return Binding{}, bad
	}
	b.key = key
	return b, nil
}

// Fingerprint: the first 8 bytes of SHA-256 of the key, as Fleet shows it (XXXX-XXXX-XXXX-XXXX).
func (b Binding) Fingerprint() string {
	sum := sha256.Sum256(b.key)
	h := strings.ToUpper(hex.EncodeToString(sum[:8]))
	return h[0:4] + "-" + h[4:8] + "-" + h[8:12] + "-" + h[12:16]
}

type Host struct {
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	OSVersion    string `json:"os_version,omitempty"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agent_version,omitempty"`
}

type Registration struct {
	EndpointID string    `json:"endpoint_id"`
	Credential string    `json:"credential"`
	Code       string    `json:"code"`
	PIN        string    `json:"pin"`
	ExpiresAt  time.Time `json:"expires_at"`
	Proof      string    `json:"proof"`
}

// Register asks the bound server for a code and PIN and checks the server's proof.
func Register(ctx context.Context, client *http.Client, b Binding, host Host) (Registration, error) {
	nb := make([]byte, 24)
	if _, err := rand.Read(nb); err != nil {
		return Registration{}, err
	}
	nonce := base64.RawURLEncoding.EncodeToString(nb)
	body, _ := json.Marshal(map[string]any{"link": b.Link, "nonce": nonce, "hostname": host.Hostname, "os": host.OS, "os_version": host.OSVersion, "arch": host.Arch, "agent_version": host.AgentVersion})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(b.Server, "/")+"/api/v1/agent/quick-support/register", bytes.NewReader(body))
	if err != nil {
		return Registration{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return Registration{}, fmt.Errorf("cannot reach %s: %w", b.Server, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusCreated {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error.Message == "" {
			e.Error.Message = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return Registration{}, fmt.Errorf("the server refused Quick Support: %s", e.Error.Message)
	}
	var r Registration
	if err := json.Unmarshal(data, &r); err != nil {
		return Registration{}, err
	}
	if err := b.VerifyProof(nonce, r.Code, r.Proof); err != nil {
		return Registration{}, err
	}
	if len(r.Code) != 9 || len(r.PIN) != 6 || !strings.HasPrefix(r.Credential, "lda_") {
		return Registration{}, errors.New("the server sent an invalid code")
	}
	return r, nil
}

// VerifyProof: the server signed this nonce and code with the key of the binding.
func (b Binding) VerifyProof(nonce, code, proof string) error {
	sig, err := base64.StdEncoding.DecodeString(proof)
	if err != nil || !ed25519.Verify(b.key, []byte("nigafiy-qs-proof\n"+nonce+"\n"+code), sig) {
		return errors.New("the server could not prove it is the one this program was downloaded from: Quick Support stopped")
	}
	return nil
}

// FormatCode shows the code in groups of three ("123 456 789").
func FormatCode(code string) string {
	if len(code) != 9 {
		return code
	}
	return code[:3] + " " + code[3:6] + " " + code[6:]
}

// Status is the code's state on the server.
type Status struct {
	State    string `json:"state"`
	Operator string `json:"operator"`
}

// Finished: the program closes (session over, code expired or locked, credential revoked).
func (s Status) Finished() bool {
	return s.State == "ended" || s.State == "expired" || s.State == "locked"
}

// ScreenText is the window the person reads the code and PIN from.
func ScreenText(b Binding, r Registration) string { return ScreenTextFor(b, r, false) }

// ScreenTextFor is ScreenText for the downloaded program (packaged = false: it removes itself) or the
// Microsoft Store version (packaged = true: it stays installed until the person removes it).
func ScreenTextFor(b Binding, r Registration, packaged bool) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Your Quick Support ID:   %s\nOne-time PIN:   %s\n\n", FormatCode(r.Code), r.PIN)
	fmt.Fprintf(&sb, "Read both to your IT contact. They connect from Nigafiy at %s.\n", b.Server)
	sb.WriteString("You will be asked to Accept before they can see your screen; a bar shows who is connected, and End session stops it at once.\n")
	if packaged {
		fmt.Fprintf(&sb, "The ID expires at %s if nobody connects. Nothing keeps running after the session; remove Nigafiy Quick Support in Settings > Apps when you no longer need it.\n", r.ExpiresAt.Local().Format("15:04"))
	} else {
		fmt.Fprintf(&sb, "The ID expires at %s if nobody connects. Nothing is installed: when the session ends this program removes itself.\n", r.ExpiresAt.Local().Format("15:04"))
	}
	fmt.Fprintf(&sb, "Server key: %s\n\nClosing this window ends Quick Support.\n\n", b.Fingerprint())
	fmt.Fprintf(&sb, "معرّف الدعم السريع: %s\nرمز PIN لمرة واحدة: %s\n", FormatCode(r.Code), r.PIN)
	sb.WriteString("أعطِ الرقمين لفريق تقنية المعلومات. سيُطلب منك القبول قبل أن يروا شاشتك، ويظهر شريط يبيّن من المتصل مع زر إنهاء الجلسة. إغلاق هذه النافذة ينهي الدعم السريع.")
	return sb.String()
}

// ErrRevoked: the server no longer accepts this program's credential (the session ended).
var ErrRevoked = errors.New("the Quick Support credential was revoked")

// CheckServer allows https, and plain http only on this computer (local development).
func (b Binding) CheckServer() error {
	u, err := url.Parse(b.Server)
	if err != nil || u.Host == "" || u.User != nil {
		return errors.New("the server address in this program is not valid")
	}
	if u.Scheme == "http" {
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			return nil
		}
		return errors.New("this program was bound to an http:// server; Quick Support needs https outside this computer")
	}
	if u.Scheme != "https" {
		return errors.New("the server address in this program is not valid")
	}
	return nil
}

// AllowsHTTP: the bound server is a local http:// development server (CheckServer passed).
func (b Binding) AllowsHTTP() bool { return strings.HasPrefix(b.Server, "http://") }

// TLSConfig honours the binding's TLS pin (the leaf or the local CA, as the agent does).
func (b Binding) TLSConfig(verifyPinned func([]*x509.Certificate, []byte, time.Time) error) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if strings.TrimSpace(b.TLSPin) == "" {
		return cfg, nil
	}
	clean := strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimSpace(b.TLSPin)))
	pin, err := hex.DecodeString(clean)
	if err != nil || len(pin) != 32 {
		return nil, errors.New("the TLS pin in this program is not valid")
	}
	cfg.InsecureSkipVerify = true // replaced by the pin check below
	cfg.VerifyConnection = func(cs tls.ConnectionState) error { return verifyPinned(cs.PeerCertificates, pin, time.Now()) }
	return cfg, nil
}

// GetStatus reads the code's state with the program's credential.
func GetStatus(ctx context.Context, client *http.Client, b Binding, credential string) (Status, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(b.Server, "/")+"/api/v1/agent/quick-support/status", nil)
	if err != nil {
		return Status{}, err
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	resp, err := client.Do(req)
	if err != nil {
		return Status{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return Status{}, ErrRevoked
	case resp.StatusCode != http.StatusOK:
		return Status{}, fmt.Errorf("status: HTTP %d", resp.StatusCode)
	}
	var s Status
	if err := json.Unmarshal(data, &s); err != nil {
		return Status{}, err
	}
	return s, nil
}

// Close tells the server the person closed Quick Support (best effort).
func Close(ctx context.Context, client *http.Client, b Binding, credential string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(b.Server, "/")+"/api/v1/agent/quick-support/close", strings.NewReader("{}"))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+credential)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("close: HTTP %d", resp.StatusCode)
	}
	return nil
}

// AllowedCommand: everything Quick Support runs. The server already refuses everything else for a
// Quick Support computer (commands/service.ts); this is the program's own copy of that list, so a
// server it was wrongly pointed at cannot run scripts, a shell, patches or restarts either.
// rd_session_* are the server-issued session commands; rd_capture/rd_input the HTTP fallback.
func AllowedCommand(kind string) bool {
	switch kind {
	case "rd_session_open", "rd_session_close", "rd_session_update", "rd_capture", "rd_input", "fs_op", "notify_user":
		return true
	}
	return false
}
