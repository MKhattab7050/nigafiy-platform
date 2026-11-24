//go:build windows

package sysinfo

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	wtsapi32                        = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW = wtsapi32.NewProc("WTSQuerySessionInformationW")
)

const (
	wtsUserName   = 5
	wtsDomainName = 7
)

// UserSessions lists the computer's Windows sessions with their user (WTSEnumerateSessions on the
// local server). Any account can enumerate; the agent service sees every session.
func UserSessions() []UserSession {
	var info *windows.WTS_SESSION_INFO
	var n uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &info, &n); err != nil || n == 0 {
		return nil
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(info)))
	console := windows.WTSGetActiveConsoleSessionId()
	list := unsafe.Slice(info, n)
	out := make([]UserSession, 0, n)
	for _, s := range list {
		state := sessionState(s.State)
		if !keepSession(s.SessionID, state) {
			continue
		}
		out = append(out, UserSession{
			ID:      s.SessionID,
			User:    optional(querySessionString(s.SessionID, wtsUserName)),
			Domain:  optional(querySessionString(s.SessionID, wtsDomainName)),
			State:   state,
			Station: optional(windows.UTF16PtrToString(s.WindowStationName)),
			Console: s.SessionID == console,
		})
		if len(out) == 64 {
			break
		}
	}
	return out
}

func querySessionString(id uint32, class uintptr) string {
	var buf *uint16
	var size uint32
	r, _, _ := procWTSQuerySessionInformationW.Call(0, uintptr(id), class, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&size)))
	if r == 0 || buf == nil {
		return ""
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	return windows.UTF16PtrToString(buf)
}
