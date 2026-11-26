package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePinAcceptsTheSha256PrefixInAnyCase(t *testing.T) {
	hex := strings.Repeat("ab", 32)
	colons := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	want, err := ParsePin(hex)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{"sha256:" + hex, "SHA256:" + colons, " Sha256:" + hex + " ", colons} {
		got, err := ParsePin(in)
		if err != nil {
			t.Fatalf("%q refused: %v", in, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%q parsed to %x", in, got)
		}
	}
	for _, bad := range []string{"sha256:", "sha1:" + hex, "sha256:" + hex[:62], "md5:" + hex} {
		if _, err := ParsePin(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	c := Config{ServerURL: "https://n.example", StateDir: "s", LogLevel: "info", TLSPinSHA256: "sha256:" + colons}
	if err := c.Validate(); err != nil {
		t.Fatalf("a prefixed pin must validate: %v", err)
	}
}

func TestReadTokenFileTakesTheFirstLineTrimmedAndNeverEchoesIt(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := map[string]string{
		"plain.txt": "ldea_secret_one",
		"crlf.txt":  "  ldea_secret_two \r\nsecond line ignored\r\n",
		"bom.txt":   "\xef\xbb\xbfldea_secret_three\n",
	}
	want := map[string]string{"plain.txt": "ldea_secret_one", "crlf.txt": "ldea_secret_two", "bom.txt": "ldea_secret_three"}
	for name, body := range cases {
		got, err := ReadTokenFile(write(name, body))
		if err != nil || got != want[name] {
			t.Fatalf("%s: %q, %v", name, got, err)
		}
	}
	for name, body := range map[string]string{"empty.txt": "", "blank.txt": "   \r\nldea_secret_hidden\n", "big.txt": "ldea_secret_big" + strings.Repeat("x", 5000)} {
		_, err := ReadTokenFile(write(name, body))
		if err == nil {
			t.Fatalf("%s accepted", name)
		}
		if strings.Contains(err.Error(), "ldea_secret") {
			t.Fatalf("%s: the error shows the file's content: %v", name, err)
		}
	}
	if _, err := ReadTokenFile(filepath.Join(dir, "missing.txt")); err == nil || !strings.Contains(err.Error(), "missing.txt") {
		t.Fatalf("missing file: %v", err)
	}
	if _, err := ReadTokenFile(dir); err == nil {
		t.Fatal("a folder was accepted")
	}
}

func TestParseConnectCodeReadsTheDashboardLinkAlsoInsideACommand(t *testing.T) {
	pin := strings.Repeat("ab", 32)
	code := "nigafiy://enroll?server=https%3A%2F%2F192.168.1.10%3A47143%2F&token=lde_AbC-123_xyz&pin=" + pin
	for _, in := range []string{code, "  " + code + "\r\n", `nigafiy-agent.exe install -connect "` + code + `"`} {
		c, err := ParseConnectCode(in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if c.Server != "https://192.168.1.10:47143" || c.Token != "lde_AbC-123_xyz" || c.Pin != pin {
			t.Fatalf("%q: got %+v", in, c)
		}
	}
	c, err := ParseConnectCode("nigafiy://enroll?server=https%3A%2F%2Fh&token=t")
	if err != nil || c.Pin != "" {
		t.Fatalf("no pin: %+v %v", c, err)
	}
	var cfg Config
	c.Apply(&cfg)
	if cfg.ServerURL != "https://h" || cfg.EnrollmentToken != "t" {
		t.Fatalf("apply: %+v", cfg)
	}
	for _, bad := range []string{"", "https://h", "nigafiy://enroll?token=secret", "nigafiy://enroll?server=https%3A%2F%2Fh", "nigafiy://enroll?server=https%3A%2F%2Fh&token=secret&pin=12"} {
		_, err := ParseConnectCode(bad)
		if err == nil {
			t.Fatalf("%q accepted", bad)
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatalf("error echoes the token: %v", err)
		}
	}
}
