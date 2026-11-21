//go:build !windows && !linux

package smart

import (
	"context"
	"fmt"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// ListenDHCPClient opens UDP 68 on the wildcard address (macOS/BSD deliver broadcasts there);
// replies are told apart by their transaction id. Needs root to bind a port below 1024.
func ListenDHCPClient(ctx context.Context, iface DHCPInterface) (PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			if serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); serr != nil {
				return
			}
			if serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); serr != nil {
				return
			}
			serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_BROADCAST, 1)
		})
		if err != nil {
			return err
		}
		return serr
	}}
	conn, err := lc.ListenPacket(ctx, "udp4", "0.0.0.0:68")
	if err != nil {
		return nil, fmt.Errorf("cannot listen on UDP 68 (DHCP client port) for %s: %w — run the collector with permission to bind ports below 1024", iface.Name, err)
	}
	return conn, nil
}
