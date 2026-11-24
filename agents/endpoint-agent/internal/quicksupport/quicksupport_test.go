package quicksupport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// signed builds a trailer exactly as the API's buildTrailer does.
func signed(t *testing.T, priv ed25519.PrivateKey, server string) []byte {
	t.Helper()
	pub := priv.Public().(ed25519.PublicKey)
	payload, _ := json.Marshal(map[string]any{"v": 1, "server": server, "tls_pin": "", "link": "qsl1.org.site.1.mac", "issued_by": "it@corp.test", "key": base64.StdEncoding.EncodeToString(pub)})
	sig := ed25519.Sign(priv, append([]byte("nigafiy-qs1\n"), payload...))
	js, _ := json.Marshal(map[string]string{"payload": base64.StdEncoding.EncodeToString(payload), "sig": base64.StdEncoding.EncodeToString(sig)})
	out := append([]byte("\n"), js...)
	n := make([]byte, 4)
	binary.LittleEndian.PutUint32(n, uint32(len(js)))
	return append(append(out, n...), magic...)
}

func newKey(t *testing.T) ed25519.PrivateKey {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func writeExe(t *testing.T, tail []byte) string {
	p := filepath.Join(t.TempDir(), "nigafiy-support.exe")
	if err := os.WriteFile(p, append([]byte("MZ fake program bytes"), tail...), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadBindingVerifiesTheSignature(t *testing.T) {
	priv := newKey(t)
	b, err := ReadBinding(writeExe(t, signed(t, priv, "https://nigafiy.corp.test")))
	if err != nil {
		t.Fatal(err)
	}
	if b.Server != "https://nigafiy.corp.test" || b.IssuedBy != "it@corp.test" || len(b.Fingerprint()) != 19 {
		t.Fatalf("binding %+v fp %q", b, b.Fingerprint())
	}
	if err := b.CheckServer(); err != nil {
		t.Fatal(err)
	}

	// The server URL changed after signing: refused.
	tail := signed(t, priv, "https://nigafiy.corp.test")
	var tr trailer
	n := binary.LittleEndian.Uint32(tail[len(tail)-len(magic)-4:])
	_ = json.Unmarshal(tail[1:1+n], &tr)
	payload, _ := base64.StdEncoding.DecodeString(tr.Payload)
	tr.Payload = base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(payload), "nigafiy.corp.test", "evil.example.test", 1)))
	raw, _ := json.Marshal(tr)
	if _, err := ParseBinding(raw); err == nil {
		t.Fatal("redirected binding accepted")
	}

	// No binding at all (the plain build output).
	if _, err := ReadBinding(writeExe(t, nil)); !errors.Is(err, ErrNoBinding) {
		t.Fatalf("err=%v", err)
	}
	// A damaged length.
	bad := signed(t, priv, "https://nigafiy.corp.test")
	binary.LittleEndian.PutUint32(bad[len(bad)-len(magic)-4:], 1<<30)
	if _, err := ReadBinding(writeExe(t, bad)); err == nil {
		t.Fatal("damaged binding accepted")
	}
}

func TestCheckServerAllowsHTTPOnlyOnThisComputer(t *testing.T) {
	for server, ok := range map[string]bool{"https://x.test": true, "http://localhost:4100": true, "http://127.0.0.1:4100": true, "http://nigafiy.corp.test": false, "ftp://x.test": false} {
		if err := (Binding{Server: server}).CheckServer(); (err == nil) != ok {
			t.Errorf("%s: err=%v", server, err)
		}
	}
}

func TestRegisterChecksTheServerProof(t *testing.T) {
	priv := newKey(t)
	other := newKey(t)
	signer := priv
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agent/quick-support/register":
			var body struct{ Nonce, Link, Hostname string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Link == "" || body.Hostname != "pc-1" || len(body.Nonce) < 20 {
				w.WriteHeader(400)
				return
			}
			proof := ed25519.Sign(signer, []byte("nigafiy-qs-proof\n"+body.Nonce+"\n123456789"))
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]any{"endpoint_id": "e1", "credential": "lda_e1.secret", "code": "123456789", "pin": "042137", "expires_at": time.Now().Add(10 * time.Minute), "proof": base64.StdEncoding.EncodeToString(proof)})
		case "/api/v1/agent/quick-support/status":
			if r.Header.Get("Authorization") != "Bearer lda_e1.secret" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"state": "ended", "operator": "it@corp.test"})
		case "/api/v1/agent/quick-support/close":
			w.WriteHeader(200)
		}
	}))
	defer srv.Close()
	b, err := ReadBinding(writeExe(t, signed(t, priv, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	host := Host{Hostname: "pc-1", OS: "windows", Arch: "amd64"}
	r, err := Register(context.Background(), srv.Client(), b, host)
	if err != nil || r.Code != "123456789" || r.PIN != "042137" {
		t.Fatalf("r=%+v err=%v", r, err)
	}
	text := ScreenText(b, r)
	if !strings.Contains(text, "123 456 789") || !strings.Contains(text, "042137") || !strings.Contains(text, b.Fingerprint()) || !strings.Contains(text, "Accept") {
		t.Fatalf("screen text: %s", text)
	}
	s, err := GetStatus(context.Background(), srv.Client(), b, r.Credential)
	if err != nil || !s.Finished() {
		t.Fatalf("status %+v err=%v", s, err)
	}
	if _, err := GetStatus(context.Background(), srv.Client(), b, "lda_other"); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked: %v", err)
	}
	if err := Close(context.Background(), srv.Client(), b, r.Credential); err != nil {
		t.Fatal(err)
	}

	// A server without the binding's key cannot prove itself.
	signer = other
	if _, err := Register(context.Background(), srv.Client(), b, host); err == nil || !strings.Contains(err.Error(), "could not prove") {
		t.Fatalf("err=%v", err)
	}
}

func TestOnlyTheServersShortListRuns(t *testing.T) {
	for kind, ok := range map[string]bool{"fs_op": true, "notify_user": true, "run_script": false, "power_action": false, "fleet_restart": false, "service_control": false} {
		if AllowedCommand(kind) != ok {
			t.Errorf("%s", kind)
		}
	}
	if FormatCode("123456789") != "123 456 789" {
		t.Fatal(FormatCode("123456789"))
	}
}
