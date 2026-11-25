package logs

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRedactMatchesDesktopPrefixes(t *testing.T) {
	cases := map[string]string{
		"credential ldc_0123abcd-ef.secretSECRET1": "credential [redacted]",
		"token=lde_AAAAAAAAAAAAAAAAAAAA end":       "token=[redacted] end",
		"agent ldea_abcdefghijklmnop":              "agent [redacted]",
		"agent cred lda_abcdefgh.ijk":              "agent cred [redacted]",
		"short lde_abc stays":                      "short lde_abc stays",
		"nothing secret here":                      "nothing secret here",
		// EXT-9: secret-named fields, JSON and key=value, whatever the value looks like.
		`{"msg":"snmp","community":"public","host":"10.0.0.1"}`:   `{"msg":"snmp","community":"[redacted]","host":"10.0.0.1"}`,
		`{"Password": "hunter2 \"x\"", "user":"admin"}`:           `{"Password": "[redacted]", "user":"admin"}`,
		`level=INFO msg=login router_password=x password=hunter2`: `level=INFO msg=login router_password=[redacted] password=[redacted]`,
		`auth_key="a b" priv_key=zzz host=r1`:                     `auth_key=[redacted] priv_key=[redacted] host=r1`,
		`tokens=3 user=bob`:                                       `tokens=3 user=bob`,
		`{"client_secret":"s3cr3t"}`:                              `{"client_secret":"[redacted]"}`,
	}
	for in, want := range cases {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLineWriterRedactsTokenSplitAcrossWrites(t *testing.T) {
	var out bytes.Buffer
	fixed := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	w := NewLineWriter(&out, func() time.Time { return fixed })
	w.Write([]byte("enrolling with lde_ABCDEFGH"))
	w.Write([]byte("IJKLMNOPQRST now\r\n\x1b[32mok\x1b[0m\npartial"))
	w.Flush()
	got := out.String()
	if strings.Contains(got, "ABCDEFGH") {
		t.Fatalf("token leaked: %q", got)
	}
	want := "2026-11-21T10:00:00.000Z enrolling with [redacted] now\n2026-11-21T10:00:00.000Z ok\n2026-11-21T10:00:00.000Z partial\n"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestRotatingFileKeepsThree(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.log")
	r, err := OpenRotating(path, 100, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	line := []byte(strings.Repeat("a", 59) + "\n") // 60 bytes: one per file
	for i := 0; i < 6; i++ {
		if _, err := r.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"x.log", "x.log.1", "x.log.2", "x.log.3"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if info.Size() != 60 {
			t.Fatalf("%s size %d, want 60", name, info.Size())
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "x.log.4")); !os.IsNotExist(err) {
		t.Fatalf("x.log.4 should not exist (err %v)", err)
	}
}
