package patch

import (
	"context"
	"strings"
	"testing"
)

func TestWUAClass(t *testing.T) {
	if got := WUAClass("0FA1201D-4330-4FA8-8AE9-B877473B6441", "Sicherheitsupdates"); got != "security" {
		t.Fatalf("category id first (translated name): %s", got)
	}
	if got := WUAClass("", "Definition Updates"); got != "definition" {
		t.Fatalf("name fallback: %s", got)
	}
	if got := WUAClass("x", "Something"); got != "other" {
		t.Fatalf("unknown: %s", got)
	}
	if WUAResult(2) != "succeeded" || WUAResult(3) != "succeeded" || WUAResult(4) != "failed" || WUAResult(5) != "aborted" || WUAResult(0) != "not_started" {
		t.Fatal("result codes")
	}
}

func TestParseApt(t *testing.T) {
	out := `Listing... Done
openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
vim-common/jammy-updates 2:8.2.3995-1ubuntu2.16 all [upgradable from: 2:8.2.3995-1ubuntu2.15]
WARNING: apt does not have a stable CLI interface.`
	ups := ParseAptUpgradable(out)
	if len(ups) != 2 {
		t.Fatalf("got %d", len(ups))
	}
	if ups[0].ID != "apt:openssl=3.0.2-0ubuntu1.15" || ups[0].Classification != "security" {
		t.Fatalf("first: %+v", ups[0])
	}
	if ups[1].ID != "apt:vim-common=2:8.2.3995-1ubuntu2.16" || ups[1].Classification != "update" {
		t.Fatalf("second: %+v", ups[1])
	}
}

func TestParseDnf(t *testing.T) {
	info := ParseDnfUpdateinfo(`RHSA-2024:1234 Important/Sec. openssl-1:3.0.7-27.el9.x86_64
RHBA-2024:2000 bugfix      tzdata-2024a-1.el9.noarch
RHEA-2024:3000 enhancement htop-3.3.0-1.el9.x86_64`)
	out := `
openssl.x86_64            1:3.0.7-27.el9         baseos
tzdata.noarch             2024a-1.el9            baseos
htop.x86_64               3.3.0-1.el9            epel
Obsoleting Packages
grub2-tools.x86_64        1:2.06-80.el9          baseos
`
	ups := ParseDnfCheckUpdate(out, info)
	if len(ups) != 3 {
		t.Fatalf("got %d: %+v", len(ups), ups)
	}
	if ups[0].ID != "dnf:openssl-1:3.0.7-27.el9.x86_64" || ups[0].Classification != "security" || ups[0].Severity != "Important" {
		t.Fatalf("openssl: %+v", ups[0])
	}
	if ups[1].Classification != "update" || ups[2].Classification != "feature_pack" {
		t.Fatalf("classes: %+v", ups)
	}
}

func TestParseSoftwareUpdate(t *testing.T) {
	out := `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Sonoma 14.5-23F79
	Title: macOS Sonoma 14.5, Version: 14.5, Size: 6830080KiB, Recommended: YES, Action: restart,
* Label: Safari17.5MontereyAuto-17.5
	Title: Safari, Version: 17.5, Size: 154525K, Recommended: YES,
* Label: Background Security Improvement-1
	Title: Background Security Improvement, Version: 1, Size: 2M, Recommended: YES, Action: restart,
`
	ups := ParseSoftwareUpdateList(out)
	if len(ups) != 3 {
		t.Fatalf("got %d", len(ups))
	}
	if ups[0].ID != "softwareupdate:macOS Sonoma 14.5-23F79" || ups[0].Title != "macOS Sonoma 14.5 14.5" || ups[0].SizeBytes != 6830080*1024 || !*ups[0].RebootRequired {
		t.Fatalf("macOS: %+v", ups[0])
	}
	if ups[1].RebootRequired != nil || ups[1].SizeBytes != 154525*1024 {
		t.Fatalf("Safari: %+v", ups[1])
	}
	if ups[2].Classification != "security" || ups[2].SizeBytes != 2*1024*1024 {
		t.Fatalf("security: %+v", ups[2])
	}
}

// A fake updater: records what would run; nothing runs on this computer.
type fakeRun struct {
	calls   [][]string
	answers map[string]struct {
		out  string
		code int
	}
}

func (f *fakeRun) run(_ context.Context, _ []string, name string, args ...string) (string, int, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	a := f.answers[name+" "+strings.Join(args, " ")]
	return a.out, a.code, nil
}

func TestPackageScannerInstall(t *testing.T) {
	f := &fakeRun{answers: map[string]struct {
		out  string
		code int
	}{
		"apt list --upgradable": {out: "vim-common/jammy-updates 2:8.2.3995-1ubuntu2.16 all [upgradable from: 2:8.2.3995-1ubuntu2.15]\n"},
	}}
	p := &PackageScanner{Source: "apt", Root: true, Run: f.run, FileHas: func(string) bool { return true }}
	res, err := p.Install(context.Background(), []Item{{ID: "apt:openssl=3.0.2-0ubuntu1.15"}, {ID: "apt:vim-common=2:8.2.3995-1ubuntu2.16"}})
	if err != nil {
		t.Fatal(err)
	}
	first := strings.Join(f.calls[0], " ")
	if !strings.HasPrefix(first, "apt-get install -y --only-upgrade") || !strings.HasSuffix(first, "-- openssl=3.0.2-0ubuntu1.15 vim-common=2:8.2.3995-1ubuntu2.16") {
		t.Fatalf("command: %s", first)
	}
	if res.Results[0].Result != "succeeded" || res.Results[1].Result != "failed" || !res.RebootRequired {
		t.Fatalf("results: %+v", res)
	}
	// Refused: another source's id, an option, shell characters, and not root.
	for _, bad := range []string{"dnf:x-1-1.x86_64", "apt:-oAPT::x=1", "apt:a;b", "apt:"} {
		if _, err := p.Install(context.Background(), []Item{{ID: bad}}); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	p.Root = false
	if _, err := p.Install(context.Background(), []Item{{ID: "apt:x=1"}}); err == nil {
		t.Fatal("installed without root")
	}
}

func TestPackageScannerScanErrors(t *testing.T) {
	f := &fakeRun{answers: map[string]struct {
		out  string
		code int
	}{
		"dnf -q check-update": {out: "Error: Failed to download metadata", code: 1},
	}}
	st := (&PackageScanner{Source: "dnf", Run: f.run}).Scan(context.Background())
	if st.Error == "" || st.Source != "dnf" || st.InstallSupported {
		t.Fatalf("status: %+v", st)
	}
	none := (&PackageScanner{Source: "none", Run: f.run}).Scan(context.Background())
	if none.Error == "" || none.Source != "none" {
		t.Fatalf("none: %+v", none)
	}
}
