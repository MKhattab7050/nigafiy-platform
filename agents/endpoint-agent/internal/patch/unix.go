package patch

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Runner runs a command and returns its combined output and exit code (-1: it could not start).
type Runner func(ctx context.Context, env []string, name string, args ...string) (out string, code int, err error)

// ExecRunner runs the real command.
func ExecRunner(ctx context.Context, env []string, name string, args ...string) (string, int, error) {
	c := exec.CommandContext(ctx, name, args...) // #nosec G204 -- fixed updater binaries, arguments from the parsers
	c.Env = append(os.Environ(), env...)
	out, err := c.CombinedOutput()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return string(out), ee.ExitCode(), nil
		}
		return string(out), -1, err
	}
	return string(out), 0, nil
}

// PackageScanner drives apt, dnf or softwareupdate.
type PackageScanner struct {
	Source  string // apt | dnf | softwareupdate
	Root    bool   // the agent runs as root (installs possible)
	Run     Runner
	FileHas func(path string) bool
}

const scanTimeout = 10 * time.Minute

func (p *PackageScanner) Scan(ctx context.Context) Status {
	ctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()
	st := Status{Source: p.Source, InstallSupported: p.Root, ScannedAt: time.Now().UTC(), Updates: []Update{}}
	var err error
	switch p.Source {
	case "apt":
		var out string
		var code int
		out, code, err = p.Run(ctx, []string{"LANG=C", "LC_ALL=C"}, "apt", "list", "--upgradable")
		if err == nil && code != 0 {
			err = fmt.Errorf("apt list exited with %d: %s", code, tail(out, 300))
		}
		if err == nil {
			st.Updates = ParseAptUpgradable(out)
		}
		if p.FileHas != nil {
			st.RebootPending = boolPtr(p.FileHas("/var/run/reboot-required"))
		}
	case "dnf":
		var out string
		var code int
		out, code, err = p.Run(ctx, []string{"LANG=C", "LC_ALL=C"}, "dnf", "-q", "check-update")
		// check-update exits 100 when updates are available, 0 when none.
		if err == nil && code != 0 && code != 100 {
			err = fmt.Errorf("dnf check-update exited with %d: %s", code, tail(out, 300))
		}
		if err == nil {
			info, _, _ := p.Run(ctx, []string{"LANG=C", "LC_ALL=C"}, "dnf", "-q", "updateinfo", "list", "--updates")
			st.Updates = ParseDnfCheckUpdate(out, ParseDnfUpdateinfo(info))
		}
		if _, code, rerr := p.Run(ctx, nil, "needs-restarting", "-r"); rerr == nil && (code == 0 || code == 1) {
			st.RebootPending = boolPtr(code == 1)
		}
	case "softwareupdate":
		var out string
		var code int
		out, code, err = p.Run(ctx, nil, "softwareupdate", "-l")
		if err == nil && code != 0 {
			err = fmt.Errorf("softwareupdate -l exited with %d: %s", code, tail(out, 300))
		}
		if err == nil {
			st.Updates = ParseSoftwareUpdateList(out)
		}
	default:
		err = ErrNotSupported
	}
	if err != nil {
		st.Error = clip(err.Error(), 500)
	}
	return st
}

func (p *PackageScanner) Install(ctx context.Context, items []Item) (InstallResult, error) {
	if !p.Root {
		return InstallResult{}, errors.New("installing updates needs the agent to run as root")
	}
	if len(items) == 0 {
		return InstallResult{Results: []ItemResult{}}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	var name string
	var args []string
	env := []string{"LANG=C", "LC_ALL=C"}
	prefix := p.Source + ":"
	targets := make([]string, 0, len(items))
	for _, it := range items {
		t := strings.TrimPrefix(it.ID, prefix)
		if t == it.ID || t == "" || strings.HasPrefix(t, "-") || strings.ContainsAny(t, " \t\r\n;|&$`") {
			return InstallResult{}, fmt.Errorf("update %q is not a %s package", it.ID, p.Source)
		}
		targets = append(targets, t)
	}
	switch p.Source {
	case "apt":
		name, args = "apt-get", append([]string{"install", "-y", "--only-upgrade", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "--"}, targets...)
		env = append(env, "DEBIAN_FRONTEND=noninteractive")
	case "dnf":
		name, args = "dnf", append([]string{"-y", "upgrade", "--"}, targets...)
	case "softwareupdate":
		name, args = "softwareupdate", append([]string{"-i"}, targets...)
	default:
		return InstallResult{}, ErrNotSupported
	}
	out, code, err := p.Run(ctx, env, name, args...)
	if err != nil {
		return InstallResult{}, err
	}
	res := InstallResult{Output: tail(out, 4096), Results: make([]ItemResult, 0, len(items))}
	// What is still missing afterwards failed; the rest succeeded.
	after := p.Scan(ctx)
	still := map[string]bool{}
	for _, u := range after.Updates {
		still[u.ID] = true
	}
	for _, it := range items {
		r := "succeeded"
		if still[it.ID] || (code != 0 && after.Error != "") {
			r = "failed"
		}
		res.Results = append(res.Results, ItemResult{ID: it.ID, Result: r})
	}
	switch p.Source {
	case "apt":
		res.RebootRequired = p.FileHas != nil && p.FileHas("/var/run/reboot-required")
	case "dnf":
		res.RebootRequired = after.RebootPending != nil && *after.RebootPending
	case "softwareupdate":
		res.RebootRequired = strings.Contains(strings.ToLower(out), "restart")
	}
	if code != 0 {
		return res, fmt.Errorf("%s exited with %d: %s", name, code, tail(out, 300))
	}
	return res, nil
}

// aptLine: "openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]"
var aptLine = regexp.MustCompile(`^([A-Za-z0-9.+\-]+)/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]`)

// ParseAptUpgradable reads `apt list --upgradable`. Updates from a -security suite are "security".
func ParseAptUpgradable(out string) []Update {
	ups := []Update{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		m := aptLine.FindStringSubmatch(strings.TrimSpace(sc.Text()))
		if m == nil {
			continue
		}
		class := "update"
		for _, suite := range strings.Split(m[2], ",") {
			if strings.HasSuffix(suite, "-security") {
				class = "security"
			}
		}
		ups = append(ups, Update{ID: "apt:" + m[1] + "=" + m[3], Title: fmt.Sprintf("%s %s (from %s, %s)", m[1], m[3], strings.TrimSpace(m[5]), m[2]), Classification: class})
	}
	return ups
}

type dnfInfo struct{ class, severity string }

// ParseDnfUpdateinfo reads `dnf -q updateinfo list --updates`: advisory, type, package NEVRA.
func ParseDnfUpdateinfo(out string) map[string]dnfInfo {
	m := map[string]dnfInfo{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		typ, nevra := f[1], f[len(f)-1]
		info := dnfInfo{class: "update"}
		low := strings.ToLower(typ)
		switch {
		case strings.Contains(low, "sec"):
			info.class = "security"
			if i := strings.Index(typ, "/"); i > 0 {
				info.severity = typ[:i]
			}
		case low == "enhancement" || low == "newpackage":
			info.class = "feature_pack"
		}
		key := dnfKey(nevra)
		if prev, ok := m[key]; ok && prev.class == "security" {
			continue
		}
		m[key] = info
	}
	return m
}

// dnfKey: "name.arch" of "name-[epoch:]version-release.arch".
func dnfKey(nevra string) string {
	dot := strings.LastIndex(nevra, ".")
	if dot < 0 {
		return nevra
	}
	arch, nvr := nevra[dot+1:], nevra[:dot]
	for i := 0; i < 2; i++ {
		if d := strings.LastIndex(nvr, "-"); d > 0 {
			nvr = nvr[:d]
		}
	}
	return nvr + "." + arch
}

// ParseDnfCheckUpdate reads `dnf -q check-update`: "name.arch  [epoch:]version-release  repo".
func ParseDnfCheckUpdate(out string, info map[string]dnfInfo) []Update {
	ups := []Update{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "Obsoleting") {
			break
		}
		f := strings.Fields(line)
		if len(f) != 3 || !strings.Contains(f[0], ".") || !strings.Contains(f[1], "-") {
			continue
		}
		dot := strings.LastIndex(f[0], ".")
		name, arch := f[0][:dot], f[0][dot+1:]
		u := Update{ID: "dnf:" + name + "-" + f[1] + "." + arch, Title: fmt.Sprintf("%s %s (%s)", f[0], f[1], f[2]), Classification: "update"}
		if i, ok := info[f[0]]; ok {
			u.Classification, u.Severity = i.class, i.severity
		}
		ups = append(ups, u)
	}
	return ups
}

var suSize = regexp.MustCompile(`^(\d+)\s*(KiB|K|MiB|M)?$`)

// ParseSoftwareUpdateList reads `softwareupdate -l` (macOS 10.15 and later format).
func ParseSoftwareUpdateList(out string) []Update {
	ups := []Update{}
	var cur *Update
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "* Label:") {
			label := strings.TrimSpace(strings.TrimPrefix(line, "* Label:"))
			ups = append(ups, Update{ID: "softwareupdate:" + label, Title: label, Classification: "update"})
			cur = &ups[len(ups)-1]
			continue
		}
		if cur == nil || !strings.HasPrefix(line, "Title:") {
			continue
		}
		title, version := "", ""
		for _, part := range strings.Split(line, ",") {
			k, v, ok := strings.Cut(strings.TrimSpace(part), ":")
			if !ok {
				continue
			}
			v = strings.TrimSpace(v)
			switch strings.TrimSpace(k) {
			case "Title":
				title = v
			case "Version":
				version = v
			case "Size":
				if m := suSize.FindStringSubmatch(v); m != nil {
					n, _ := strconv.ParseInt(m[1], 10, 64)
					if m[2] == "MiB" || m[2] == "M" {
						n *= 1024
					}
					cur.SizeBytes = n * 1024
				}
			case "Action":
				cur.RebootRequired = boolPtr(strings.EqualFold(v, "restart"))
			}
		}
		if title != "" {
			cur.Title = strings.TrimSpace(title + " " + version)
		}
		if strings.Contains(strings.ToLower(title), "security") {
			cur.Classification = "security"
		}
		cur = nil
	}
	return ups
}
