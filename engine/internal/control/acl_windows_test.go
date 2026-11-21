package control

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// checkTokenACL reads the file's DACL back: protected (nothing inherited from the folder) and
// exactly SYSTEM, Administrators and the current user.
func checkTokenACL(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("DACL is not protected from inheritance")
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	want, err := tokenReaders("")
	if err != nil {
		t.Fatal(err)
	}
	if int(dacl.AceCount) != len(want) {
		t.Fatalf("DACL has %d entries, want %d", dacl.AceCount, len(want))
	}
	for i := 0; i < int(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(i), &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("entry %d is type %d, want allow", i, ace.Header.AceType)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		found := false
		for _, w := range want {
			if w.Equals(sid) {
				found = true
			}
		}
		if !found {
			t.Fatalf("unexpected entry for %s", sid)
		}
	}
}

func TestTokenReadersIncludesOwner(t *testing.T) {
	sids, err := tokenReaders("S-1-5-21-1-2-3-1001")
	if err != nil {
		t.Fatal(err)
	}
	if got := sids[len(sids)-1].String(); got != "S-1-5-21-1-2-3-1001" {
		t.Fatalf("last reader %s", got)
	}
	if _, err := tokenReaders("not-a-sid"); err == nil {
		t.Fatal("a malformed owner SID was accepted")
	}
}
