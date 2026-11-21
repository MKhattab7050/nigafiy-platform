package control

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// NewToken returns 32 random bytes, hex encoded.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// WriteToken writes token to path so that only the owner can read it: on Windows an explicit,
// non-inherited ACL granting SYSTEM, Administrators, the current user and (if given) ownerSID;
// elsewhere mode 0600. The file is written to a temporary name, locked down, then renamed over
// path, so it is never readable with looser permissions.
func WriteToken(path, token, ownerSID string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	f.Close()
	if err := restrictFile(tmp, ownerSID); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("could not restrict %s: %w", tmp, err)
	}
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ReadToken reads a token written by WriteToken.
func ReadToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
