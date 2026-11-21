//go:build windows

package control

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// restrictFile replaces the file's DACL with a protected (non-inherited) one that grants full
// access to LocalSystem, the Administrators group, the user running the engine and, when given,
// ownerSID (the user who installed the service). Uses the Win32 security API from
// golang.org/x/sys/windows (SetNamedSecurityInfo), not icacls.
func restrictFile(path, ownerSID string) error {
	sids, err := tokenReaders(ownerSID)
	if err != nil {
		return err
	}
	entries := make([]windows.EXPLICIT_ACCESS, 0, len(sids))
	for _, sid := range sids {
		entries = append(entries, windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.GENERIC_ALL,
			AccessMode:        windows.GRANT_ACCESS,
			Inheritance:       windows.NO_INHERITANCE,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		})
	}
	acl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return fmt.Errorf("building ACL: %w", err)
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// tokenReaders is SYSTEM, Administrators, the current user and ownerSID, without duplicates.
func tokenReaders(ownerSID string) ([]*windows.SID, error) {
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return nil, err
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return nil, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("current user: %w", err)
	}
	sids := []*windows.SID{system, admins}
	add := func(s *windows.SID) {
		for _, have := range sids {
			if have.Equals(s) {
				return
			}
		}
		sids = append(sids, s)
	}
	add(user.User.Sid)
	if ownerSID != "" {
		owner, err := windows.StringToSid(ownerSID)
		if err != nil {
			return nil, fmt.Errorf("owner SID %q: %w", ownerSID, err)
		}
		add(owner)
	}
	return sids, nil
}

// CurrentUserSID is the SID of the user running this process (used by install to record who may
// read the control token of the service).
func CurrentUserSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}
