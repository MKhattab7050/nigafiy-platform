//go:build !windows

package remotedesktop

import "image"

// drawCursor: the screenshot tools used on Linux and macOS draw no pointer and there is no pure-Go
// way to read its shape, so the option is reported as unsupported there.
func drawCursor(*image.RGBA, DisplayInfo) bool { return false }

// CursorSupported: the remote cursor can be drawn into the picture here.
const CursorSupported = false
