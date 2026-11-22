package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"strings"
	"testing"
	"time"
)

type testCert struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func makeCert(t *testing.T, name string, isCA bool, parent *testCert, notAfter time.Time, eku []x509.ExtKeyUsage) *testCert {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              notAfter,
		BasicConstraintsValid: true,
		IsCA:                  isCA,
		ExtKeyUsage:           eku,
		DNSNames:              []string{"localhost"},
	}
	if isCA {
		tpl.KeyUsage = x509.KeyUsageCertSign
	} else {
		tpl.KeyUsage = x509.KeyUsageDigitalSignature
	}
	signer, signerKey := tpl, key
	if parent != nil {
		signer, signerKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCert{cert: c, key: key}
}

func pinOf(c *x509.Certificate) []byte {
	s := sha256.Sum256(c.Raw)
	return s[:]
}

// Built-in LAN TLS pins the local CA: any server certificate that CA signs is accepted, a server
// certificate from another CA is not, even when the attacker also sends the pinned CA certificate.
func TestVerifyPinnedChainAcceptsCAPin(t *testing.T) {
	year := time.Now().Add(365 * 24 * time.Hour)
	serverAuth := []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	ca := makeCert(t, "local CA", true, nil, year, nil)
	leaf := makeCert(t, "server", false, ca, year, serverAuth)
	renewed := makeCert(t, "server", false, ca, year, serverAuth)
	other := makeCert(t, "other CA", true, nil, year, nil)
	forged := makeCert(t, "server", false, other, year, serverAuth)
	clientOnly := makeCert(t, "server", false, ca, year, []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth})
	expired := makeCert(t, "server", false, ca, time.Now().Add(-time.Minute), serverAuth)
	now := time.Now()

	if err := VerifyPinnedChain([]*x509.Certificate{leaf.cert, ca.cert}, pinOf(ca.cert), now); err != nil {
		t.Fatalf("CA pin should accept its server certificate: %v", err)
	}
	if err := VerifyPinnedChain([]*x509.Certificate{renewed.cert, ca.cert}, pinOf(ca.cert), now); err != nil {
		t.Fatalf("CA pin should accept a re-issued server certificate: %v", err)
	}
	if err := VerifyPinnedChain([]*x509.Certificate{leaf.cert}, pinOf(leaf.cert), now); err != nil {
		t.Fatalf("leaf pin should still work: %v", err)
	}
	if err := VerifyPinnedChain([]*x509.Certificate{renewed.cert, ca.cert}, pinOf(leaf.cert), now); err == nil || !strings.Contains(err.Error(), "pin mismatch") {
		t.Fatalf("a leaf pin must not accept another leaf, got %v", err)
	}
	if err := VerifyPinnedChain([]*x509.Certificate{forged.cert, ca.cert}, pinOf(ca.cert), now); err == nil {
		t.Fatal("a server certificate from another CA must be refused even when the pinned CA is in the chain")
	}
	if err := VerifyPinnedChain([]*x509.Certificate{forged.cert, other.cert}, pinOf(ca.cert), now); err == nil {
		t.Fatal("another CA must not match the pin")
	}
	if err := VerifyPinnedChain([]*x509.Certificate{clientOnly.cert, ca.cert}, pinOf(ca.cert), now); err == nil {
		t.Fatal("a certificate without serverAuth must be refused under a CA pin")
	}
	if err := VerifyPinnedChain([]*x509.Certificate{expired.cert, ca.cert}, pinOf(ca.cert), now); err == nil {
		t.Fatal("an expired server certificate must be refused under a CA pin")
	}
	if err := VerifyPinnedChain([]*x509.Certificate{leaf.cert, leaf.cert}, pinOf(leaf.cert), now); err != nil {
		t.Fatalf("leaf pin: %v", err)
	}
	if err := VerifyPinnedChain(nil, pinOf(ca.cert), now); err == nil {
		t.Fatal("no certificate must be refused")
	}
}
