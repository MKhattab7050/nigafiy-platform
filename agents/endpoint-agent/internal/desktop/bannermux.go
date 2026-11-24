package desktop

import (
	"sync"

	"github.com/nigafiy/agent/internal/userui"
)

// ShellBannerID is the banner's session id while only remote shells are open.
const ShellBannerID = "nigafiy-shell"

// BannerMux shares the one session banner between the remote desktop session and the remote
// shells (Fleet Pro): every platform shows a single banner, so the mux merges what is open into
// it. The remote desktop session shows and hides its banner as before; the shells set their lines
// with SetShells. End session (or Ctrl+Alt+Shift+E) ends everything the banner names. Every other
// method goes to the wrapped Desktop.
type BannerMux struct {
	Desktop

	// rmu orders the renders (a banner replaces the previous one).
	rmu sync.Mutex
	mu  sync.Mutex
	// rd: the remote desktop session's banner (nil: none open).
	rd      *userui.BannerInfo
	rdEnd   func()
	shells  []userui.ShellLine
	shEnd   func()
	shownID string
	shown   bool
}

func NewBannerMux(d Desktop) *BannerMux { return &BannerMux{Desktop: d} }

func (m *BannerMux) ShowBanner(info userui.BannerInfo, onEnd func()) error {
	m.mu.Lock()
	cp := info
	m.rd, m.rdEnd = &cp, onEnd
	m.mu.Unlock()
	return m.render()
}

func (m *BannerMux) HideBanner(sessionID string) {
	m.mu.Lock()
	if m.rd == nil || (sessionID != "" && m.rd.SessionID != sessionID) {
		m.mu.Unlock()
		return
	}
	m.rd, m.rdEnd = nil, nil
	m.mu.Unlock()
	_ = m.render()
}

// SetShells shows the open shells on the banner (none: their lines go). onEnd runs when the
// person ends the banner.
func (m *BannerMux) SetShells(lines []userui.ShellLine, onEnd func()) error {
	m.mu.Lock()
	m.shells = append([]userui.ShellLine(nil), lines...)
	m.shEnd = onEnd
	m.mu.Unlock()
	return m.render()
}

// Current is what the banner shows now (ok false: no banner).
func (m *BannerMux) Current() (userui.BannerInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.compose()
}

func (m *BannerMux) compose() (userui.BannerInfo, bool) {
	switch {
	case m.rd != nil:
		info := *m.rd
		info.Shells = append([]userui.ShellLine(nil), m.shells...)
		info.ShellOnly = false
		return info, true
	case len(m.shells) > 0:
		return userui.BannerInfo{SessionID: ShellBannerID, Shells: append([]userui.ShellLine(nil), m.shells...), ShellOnly: true}, true
	}
	return userui.BannerInfo{}, false
}

func (m *BannerMux) render() error {
	m.rmu.Lock()
	defer m.rmu.Unlock()
	m.mu.Lock()
	info, ok := m.compose()
	rdEnd, shEnd := m.rdEnd, m.shEnd
	prevID, wasShown := m.shownID, m.shown
	m.shownID, m.shown = info.SessionID, ok
	m.mu.Unlock()
	if !ok {
		if wasShown {
			m.Desktop.HideBanner(prevID)
		}
		return nil
	}
	if wasShown && prevID != info.SessionID {
		m.Desktop.HideBanner(prevID)
	}
	return m.Desktop.ShowBanner(info, func() {
		// End on the banner ends everything it names.
		if rdEnd != nil {
			rdEnd()
		}
		if shEnd != nil && len(info.Shells) > 0 {
			shEnd()
		}
	})
}
