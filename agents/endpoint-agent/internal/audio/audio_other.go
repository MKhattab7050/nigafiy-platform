//go:build !windows || !(amd64 || arm64)

package audio

func start(Options, func(Header, []byte)) (Capture, error) { return nil, ErrUnsupported }
