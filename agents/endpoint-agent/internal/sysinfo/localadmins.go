package sysinfo

// Local administrators (compliance): who is a member of the computer's administrators group.
// Names only, one evidence item per member ("info": the API judges them against the group's
// allowed list when one is set). A list the agent could not read is one "unknown" item with why.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const checkLocalAdmins = "local_admins"

// maxAdminItems: members listed one per evidence item; more are summarised in one "unknown" item
// so the list can never look complete when it is not.
const maxAdminItems = 20

// The well-known SID S-1-5-32-544 works on every display language. Get-LocalGroupMember fails on
// some Azure AD joined computers (an unresolvable member SID); ADSI WinNT is the fallback.
const windowsAdminsScript = `try {
  $m = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { [string]$_.Name })
  @{ ok = $true; members = $m; source = 'Get-LocalGroupMember -SID S-1-5-32-544' } | ConvertTo-Json -Compress
} catch {
  $first = $_.Exception.Message
  try {
    $g = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
    $grp = [ADSI]"WinNT://./$g,group"
    $m = @($grp.psbase.Invoke('Members') | ForEach-Object { ($_.GetType().InvokeMember('ADsPath', 'GetProperty', $null, $_, $null) -replace '^WinNT://', '') -replace '/', '\' })
    @{ ok = $true; members = $m; source = "ADSI WinNT://./$g (Get-LocalGroupMember failed)" } | ConvertTo-Json -Compress
  } catch { @{ ok = $false; error = "$first; ADSI: $($_.Exception.Message)" } | ConvertTo-Json -Compress }
}`

type adminsReport struct {
	OK      bool     `json:"ok"`
	Members []string `json:"members"`
	Source  string   `json:"source"`
	Error   string   `json:"error"`
}

// LocalAdminEvidence turns a member list into evidence (sorted, de-duplicated).
func LocalAdminEvidence(env complianceEnv, group, source string, members []string) []Evidence {
	seen := map[string]bool{}
	var list []string
	for _, m := range members {
		m = strings.TrimSpace(m)
		if m == "" || seen[strings.ToLower(m)] {
			continue
		}
		seen[strings.ToLower(m)] = true
		list = append(list, m)
	}
	sort.Strings(list)
	if len(list) == 0 {
		e := env.ev(checkLocalAdmins, group, "info", "no members", source, "")
		e.Count = intPtr(0)
		return []Evidence{e}
	}
	var ev []Evidence
	for i, m := range list {
		if i == maxAdminItems {
			e := env.ev(checkLocalAdmins, "More members", "unknown", fmt.Sprintf("%d more member(s) not listed", len(list)-maxAdminItems), source, fmt.Sprintf("only the first %d members are reported", maxAdminItems))
			ev = append(ev, e)
			break
		}
		e := env.ev(checkLocalAdmins, m, "info", "member of "+group, source, "")
		e.Count = intPtr(len(list))
		ev = append(ev, e)
	}
	return ev
}

// ParseGetentGroups reads `getent group sudo wheel admin` lines (name:x:gid:a,b,c).
func ParseGetentGroups(out string) (groups []string, members []string) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 4 {
			continue
		}
		groups = append(groups, f[0])
		for _, m := range strings.Split(f[3], ",") {
			if m = strings.TrimSpace(m); m != "" {
				members = append(members, m)
			}
		}
	}
	return groups, members
}

// ParseDsclMembership reads `dscl . -read /Groups/admin GroupMembership`.
func ParseDsclMembership(out string) ([]string, bool) {
	for _, line := range strings.Split(out, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "GroupMembership:"); ok {
			return strings.Fields(rest), true
		}
	}
	return nil, false
}

func localAdminsChecks(ctx context.Context, env complianceEnv) []Evidence {
	switch env.goos {
	case "windows":
		out, err := env.run(ctx, 30*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", windowsAdminsScript)
		var rep adminsReport
		if jerr := json.Unmarshal([]byte(strings.TrimSpace(out)), &rep); jerr != nil || !rep.OK {
			why := rep.Error
			if why == "" {
				why = errText(out, err)
			}
			return []Evidence{env.ev(checkLocalAdmins, "Administrators", "unknown", "", "Get-LocalGroupMember / ADSI", "could not read the Administrators group: "+why)}
		}
		return LocalAdminEvidence(env, "Administrators", rep.Source, rep.Members)
	case "linux":
		if !env.has("getent") {
			return []Evidence{env.ev(checkLocalAdmins, "sudo / wheel / admin", "unknown", "", "getent group", "getent is not installed")}
		}
		out, err := env.run(ctx, 10*time.Second, "getent", "group", "sudo", "wheel", "admin")
		groups, members := ParseGetentGroups(out)
		if len(groups) == 0 {
			// getent exits 2 when none of the groups exists: then root is the only administrator.
			if err != nil && strings.TrimSpace(out) != "" {
				return []Evidence{env.ev(checkLocalAdmins, "sudo / wheel / admin", "unknown", "", "getent group sudo wheel admin", errText(out, err))}
			}
		}
		members = append([]string{"root"}, members...)
		label := "root"
		if len(groups) > 0 {
			label = "root, " + strings.Join(groups, ", ")
		}
		return LocalAdminEvidence(env, label, "getent group sudo wheel admin (+ root)", members)
	case "darwin":
		out, err := env.run(ctx, 10*time.Second, "dscl", ".", "-read", "/Groups/admin", "GroupMembership")
		members, ok := ParseDsclMembership(out)
		if !ok {
			return []Evidence{env.ev(checkLocalAdmins, "admin group", "unknown", "", "dscl . -read /Groups/admin GroupMembership", errText(out, err))}
		}
		return LocalAdminEvidence(env, "admin", "dscl . -read /Groups/admin GroupMembership", members)
	}
	return nil
}
