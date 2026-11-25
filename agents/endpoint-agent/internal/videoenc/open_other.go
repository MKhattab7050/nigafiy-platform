//go:build !windows

package videoenc

import "fmt"

// Open: no H.264 encoder outside Windows in this pure-Go build (see the package comment).
func Open(Config) (Encoder, error) {
	return nil, fmt.Errorf("%w: H.264 encoding on this platform needs VA-API or VideoToolbox, which need cgo", ErrUnavailable)
}
