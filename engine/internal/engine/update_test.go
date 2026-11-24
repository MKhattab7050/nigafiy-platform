package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/engine/internal/control"
	"github.com/nigafiy/engine/internal/update"
)

type detachedCall struct {
	exe  string
	args []string
}

func fakeDetached(t *testing.T) *[]detachedCall {
	t.Helper()
	var mu sync.Mutex
	calls := &[]detachedCall{}
	old := startDetached
	startDetached = func(exe string, args, _ []string) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		*calls = append(*calls, detachedCall{exe, args})
		return 4242, nil
	}
	t.Cleanup(func() { startDetached = old })
	return calls
}

func stage(t *testing.T, dataDir, name string, content []byte) (string, string) {
	t.Helper()
	dir := update.StagingDir(dataDir)
	os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, content, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	return p, hex.EncodeToString(sum[:])
}

func (r *running) apply(t *testing.T, req update.Request) (int, string) {
	t.Helper()
	b, _ := json.Marshal(req)
	hreq, _ := http.NewRequest("POST", "http://"+r.addr+"/v1/update/apply", strings.NewReader(string(b)))
	hreq.Header.Set("Authorization", "Bearer "+r.token)
	res, err := http.DefaultClient.Do(hreq)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

func TestUpdateApplyIsRefusedInASourceCheckout(t *testing.T) {
	calls := fakeDetached(t)
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true })
	p, sum := stage(t, r.cfg.DataDir, "Nigafiy-Setup-1.2.4.exe", []byte("installer"))
	code, body := r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusConflict || !strings.Contains(body, "source checkout") {
		t.Fatalf("apply without a bundle: %d %s", code, body)
	}
	if len(*calls) != 0 {
		t.Fatal("helper started")
	}
}

func TestUpdateApplyVerifiesAndHandsOver(t *testing.T) {
	calls := fakeDetached(t)
	install := filepath.Join(t.TempDir(), "Nigafiy")
	bundle := filepath.Join(install, "resources", "backend")
	os.MkdirAll(bundle, 0o700)
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true; c.BundleDir = bundle })
	r.waitStatus(t, "stack ready", func(d control.StatusDoc) bool { return d.Stack != nil })
	p, sum := stage(t, r.cfg.DataDir, "Nigafiy-Setup-1.2.4.exe", []byte("installer bytes"))

	// Wrong hash, wrong folder, not an .exe: rejected, nothing started, engine keeps running.
	bad := strings.Repeat("0", 64)
	if code, body := r.apply(t, update.Request{Installer: p, SHA256: bad, Version: "1.2.4"}); code != http.StatusUnprocessableEntity || !strings.Contains(body, "does not match the signed manifest") {
		t.Fatalf("wrong hash: %d %s", code, body)
	}
	outside := filepath.Join(r.cfg.DataDir, "evil.exe")
	os.WriteFile(outside, []byte("installer bytes"), 0o600)
	if code, body := r.apply(t, update.Request{Installer: outside, SHA256: sum, Version: "1.2.4"}); code != http.StatusUnprocessableEntity || !strings.Contains(body, "must be in") {
		t.Fatalf("outside staging: %d %s", code, body)
	}
	if len(*calls) != 0 {
		t.Fatal("helper started for a rejected update")
	}

	code, body := r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusAccepted || !strings.Contains(body, `"state":"applying"`) {
		t.Fatalf("apply: %d %s", code, body)
	}
	if len(*calls) != 1 {
		t.Fatalf("helper calls %d", len(*calls))
	}
	c := (*calls)[0]
	if c.exe != filepath.Join(update.HelperDir(r.cfg.DataDir), helperExeName) {
		t.Fatalf("helper exe %s", c.exe)
	}
	if _, err := os.Stat(c.exe); err != nil {
		t.Fatalf("helper copy missing: %v", err)
	}
	args := strings.Join(c.args, " ")
	for _, want := range []string{"update-apply", "--installer=" + p, "--sha256=" + sum, "--version=1.2.4", "--install-dir=" + install, "--wait-pid="} {
		if !strings.Contains(args, want) {
			t.Fatalf("helper args %q lack %q", args, want)
		}
	}
	// A second apply while one is in progress is refused.
	if code, _ := r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"}); code != http.StatusConflict {
		t.Fatalf("second apply: %d", code)
	}
	// The engine stops by itself so the installer can replace its files.
	select {
	case <-r.done:
	case <-time.After(60 * time.Second):
		t.Fatal("engine did not stop for the installation")
	}
	el, _ := os.ReadFile(logPath(r.cfg.DataDir, "engine"))
	if !strings.Contains(string(el), "update 1.2.4: engine stopped; the update helper installs it now") {
		t.Fatalf("engine log %q", el)
	}
}

func TestUpdateApplyChecksThePublisher(t *testing.T) {
	calls := fakeDetached(t)
	old := checkSig
	sig := update.Signature{Status: "Valid", Thumbprint: strings.Repeat("B", 40)}
	checkSig = func(string) (update.Signature, error) { return sig, nil }
	t.Cleanup(func() { checkSig = old })
	install := filepath.Join(t.TempDir(), "Nigafiy")
	bundle := filepath.Join(install, "resources", "backend")
	os.MkdirAll(bundle, 0o700)
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true; c.BundleDir = bundle; c.UpdatePublisher = strings.Repeat("a", 40) })
	p, sum := stage(t, r.cfg.DataDir, "Nigafiy-Setup-1.2.4.exe", []byte("x"))
	code, body := r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusUnprocessableEntity || !strings.Contains(body, "not by the configured publisher") {
		t.Fatalf("other signer: %d %s", code, body)
	}
	sig = update.Signature{Status: "UnknownError", Thumbprint: strings.Repeat("A", 40)}
	code, body = r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusUnprocessableEntity || !strings.Contains(body, "not Valid") {
		t.Fatalf("untrusted signature: %d %s", code, body)
	}
	if len(*calls) != 0 {
		t.Fatal("helper started")
	}
	sig = update.Signature{Status: "Valid", Thumbprint: strings.Repeat("A", 40)}
	code, body = r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusAccepted {
		t.Fatalf("right signer: %d %s", code, body)
	}
	if !strings.Contains(strings.Join((*calls)[0].args, " "), "--publisher="+strings.Repeat("A", 40)) {
		t.Fatalf("publisher not passed on: %v", (*calls)[0].args)
	}
	<-r.done
}

func TestUpdateApplyIsRefusedOnAnMSIManagedInstall(t *testing.T) {
	calls := fakeDetached(t)
	install := filepath.Join(t.TempDir(), "Nigafiy")
	bundle := filepath.Join(install, "resources", "backend")
	os.MkdirAll(bundle, 0o700)
	product := "{11111111-2222-3333-4444-555555555555}"
	old := installRegistry
	installRegistry = func() update.Registry {
		return update.MapRegistry{
			`HKLM\SOFTWARE\Classes\Installer\UpgradeCodes\` + update.PackGUID(update.MSIUpgradeCode): {update.PackGUID(product): ""},
			`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + product:                    {"WindowsInstaller": uint64(1), "InstallLocation": install},
		}
	}
	t.Cleanup(func() { installRegistry = old })
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true; c.BundleDir = bundle })
	doc := r.waitStatus(t, "install kind", func(d control.StatusDoc) bool { return d.Update != nil && d.Update.Install != nil })
	if doc.Update.Install.Kind != update.KindMSI || doc.Update.Install.ProductCode != product {
		t.Fatalf("status install %+v", doc.Update.Install)
	}
	p, sum := stage(t, r.cfg.DataDir, "Nigafiy-Setup-1.2.4.exe", []byte("installer"))
	code, body := r.apply(t, update.Request{Installer: p, SHA256: sum, Version: "1.2.4"})
	if code != http.StatusConflict || !strings.Contains(body, "Group Policy or Intune") {
		t.Fatalf("apply on an MSI install: %d %s", code, body)
	}
	if len(*calls) != 0 {
		t.Fatal("helper started on an MSI install")
	}
}

func TestStatusSaysNSISForAnNSISInstall(t *testing.T) {
	install := filepath.Join(t.TempDir(), "Nigafiy")
	bundle := filepath.Join(install, "resources", "backend")
	os.MkdirAll(bundle, 0o700)
	old := installRegistry
	installRegistry = func() update.Registry {
		return update.MapRegistry{`HKCU\SOFTWARE\` + update.NSISGUID: {"InstallLocation": install}}
	}
	t.Cleanup(func() { installRegistry = old })
	r := startEngine(t, "stack", func(c *Config) { c.NoSensor = true; c.BundleDir = bundle })
	doc := r.waitStatus(t, "install kind", func(d control.StatusDoc) bool { return d.Update != nil && d.Update.Install != nil })
	if doc.Update.Install.Kind != update.KindNSIS || doc.Update.Install.Scope != "user" {
		t.Fatalf("status install %+v", doc.Update.Install)
	}
}
