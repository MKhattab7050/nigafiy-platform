//go:build !windows

package inputblock

func start(func()) (Blocker, error) { return nil, ErrUnsupported }
