//go:build !windows

package tray

type Icon struct{}

func Start(Options) (*Icon, error)                      { return nil, ErrUnsupported }
func (*Icon) SetInfo(nigafiyID, server string)          {}
func (*Icon) SetMenuState(recordings, sessionOpen bool) {}
func (*Icon) Notify(title, text string)                 {}
func (*Icon) Close()                                    {}
