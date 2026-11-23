package router

import (
	"errors"
	"go/parser"
	"go/token"
	"io/fs"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestAuthorize(t *testing.T) {
	scope := []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")}
	ok := []string{"192.168.1.2", "192.168.1.254"}
	bad := []string{"192.168.2.1", "8.8.8.8", "127.0.0.1", "100.64.0.1", "169.254.1.1"}
	for _, a := range ok {
		if err := Authorize(netip.MustParseAddr(a), scope, false); err != nil {
			t.Errorf("%s refused: %v", a, err)
		}
	}
	for _, a := range bad {
		if err := Authorize(netip.MustParseAddr(a), scope, false); !errors.Is(err, ErrNotAuthorized) {
			t.Errorf("%s accepted", a)
		}
	}
	public := []netip.Prefix{netip.MustParsePrefix("8.8.8.0/24")}
	if err := Authorize(netip.MustParseAddr("8.8.8.8"), public, false); !errors.Is(err, ErrNotAuthorized) {
		t.Error("a public router was authorized because the scope said so")
	}
	if err := Authorize(netip.MustParseAddr("127.0.0.1"), []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, true); err != nil {
		t.Errorf("loopback in tests: %v", err)
	}
	if err := Authorize(netip.MustParseAddr("::ffff:192.168.1.2"), scope, false); err != nil {
		t.Errorf("v4-mapped: %v", err)
	}
}

func TestTargetValidate(t *testing.T) {
	a := netip.MustParseAddr("192.168.1.2")
	if err := (Target{Address: a, Transport: TransportHTTPSPinned}).Validate(); err == nil {
		t.Error("pinned transport without a pin accepted")
	}
	pin := "B6:F9:AB:5E:DF:D6:B4:A4:0D:C0:79:2B:B7:4E:3F:3B:19:A2:AA:AC:43:6B:AE:B3:63:EE:16:3C:BC:23:76:D1"
	if err := (Target{Address: a, Transport: TransportHTTPSPinned, PinSHA256: pin}).Validate(); err != nil {
		t.Error(err)
	}
	if err := (Target{Address: a, Transport: "insecure"}).Validate(); err == nil {
		t.Error("unknown transport accepted")
	}
	if got := (Target{Address: a, Transport: TransportHTTP}).BaseURL(); got != "http://192.168.1.2:80" {
		t.Error(got)
	}
}

func TestNormalizeMAC(t *testing.T) {
	if m, err := NormalizeMAC("AA-BB-CC-00-00-01"); err != nil || m != "aa:bb:cc:00:00:01" {
		t.Error(m, err)
	}
	for _, s := range []string{"ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "00:00:00:00:00:00", "nope"} {
		if _, err := NormalizeMAC(s); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s accepted", s)
		}
	}
}

func TestErrorsCarryNoSecrets(t *testing.T) {
	err := TransportError("login", errors.New(`Post "https://192.168.1.2/UserLogin?token=abc": dial tcp: connection refused`))
	if strings.Contains(err.Error(), "token=abc") || !errors.Is(err, ErrUnreachable) {
		t.Errorf("%v", err)
	}
}

// moduleRoot is collectors/lan-collector.
func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

// TestProductBinariesExcludeTestDouble proves the protocol test double is never compiled into a
// product binary: no non-test file in the module imports it, and the dependency graphs of
// lan-collector and router-probe do not contain it.
func TestProductBinariesExcludeTestDouble(t *testing.T) {
	const double = "github.com/nigafiy/sensor/internal/router/zyxel/zyxeltest"
	root := moduleRoot(t)
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "bin" || strings.HasPrefix(d.Name(), ".")) {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if strings.Contains(filepath.ToSlash(path), "/internal/router/zyxel/zyxeltest/") {
			return nil
		}
		f, perr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if perr != nil {
			return perr
		}
		for _, imp := range f.Imports {
			if p, _ := strconv.Unquote(imp.Path.Value); p == double {
				t.Errorf("%s imports the test double", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goBin += ".exe"
	}
	if _, err := os.Stat(goBin); err != nil {
		if goBin, err = exec.LookPath("go"); err != nil {
			t.Skip("go tool not found; the import scan above still ran")
		}
	}
	for _, cmd := range []string{"./cmd/nigafiy-sensor", "./cmd/router-probe"} {
		c := exec.Command(goBin, "list", "-deps", cmd)
		c.Dir = root
		out, err := c.Output()
		if err != nil {
			t.Fatalf("go list %s: %v", cmd, err)
		}
		deps := string(out)
		if strings.Contains(deps, double) {
			t.Errorf("%s depends on the test double", cmd)
		}
		if cmd == "./cmd/router-probe" && !strings.Contains(deps, "internal/router/zyxel\n") && !strings.Contains(deps, "internal/router/zyxel\r\n") {
			t.Errorf("sanity: router-probe should include the real zyxel driver")
		}
	}
}
