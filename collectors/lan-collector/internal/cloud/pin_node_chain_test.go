package cloud

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"os"
	"testing"
	"time"
)

// testdata/lan-tls-chain.pem is a server certificate + local CA exactly as the API's built-in LAN
// TLS (apps/api/src/infrastructure/lan-tls.ts, node-forge, RSA 2048) writes server.pem. It holds
// no private key. Pinning its CA must work in this client, and a different pin must not.
func TestVerifyPinnedChainAcceptsNodeGeneratedLanTLS(t *testing.T) {
	raw, err := os.ReadFile("testdata/lan-tls-chain.pem")
	if err != nil {
		t.Fatal(err)
	}
	var chain []*x509.Certificate
	for block, rest := pem.Decode(raw); block != nil; block, rest = pem.Decode(rest) {
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		chain = append(chain, c)
	}
	if len(chain) != 2 || !chain[1].IsCA || chain[0].IsCA {
		t.Fatalf("want server certificate then CA, got %d certificates", len(chain))
	}
	at := chain[0].NotBefore.Add(24 * time.Hour)
	caPin := sha256.Sum256(chain[1].Raw)
	if err := VerifyPinnedChain(chain, caPin[:], at); err != nil {
		t.Fatalf("CA pin rejected: %v", err)
	}
	leafPin := sha256.Sum256(chain[0].Raw)
	if err := VerifyPinnedChain(chain, leafPin[:], at); err != nil {
		t.Fatalf("leaf pin rejected: %v", err)
	}
	other := sha256.Sum256([]byte("another server"))
	if err := VerifyPinnedChain(chain, other[:], at); err == nil {
		t.Fatal("a wrong pin was accepted")
	}
	if err := VerifyPinnedChain(chain, caPin[:], chain[0].NotAfter.Add(time.Hour)); err == nil {
		t.Fatal("an expired server certificate was accepted under the CA pin")
	}
}
