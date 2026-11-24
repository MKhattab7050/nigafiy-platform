package sysinfo

// UserSession is one Windows session (WTSEnumerateSessions), reported with the heartbeat so the
// operator can pick which one a remote support session attaches to.
type UserSession struct {
	ID      uint32  `json:"id"`
	User    *string `json:"user"`
	Domain  *string `json:"domain"`
	State   string  `json:"state"` // active | connected | disconnected | idle | listen | other
	Station *string `json:"station"`
	Console bool    `json:"console"`
}

// sessionState maps WTS_CONNECTSTATE_CLASS to the names the API accepts.
func sessionState(s uint32) string {
	switch s {
	case 0:
		return "active"
	case 1:
		return "connected"
	case 4:
		return "disconnected"
	case 5:
		return "idle"
	case 6:
		return "listen"
	default:
		return "other"
	}
}

// keepSession: the services session (0) and listeners without a user are not something to connect to.
func keepSession(id uint32, state string) bool {
	return id != 0 && state != "listen"
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
