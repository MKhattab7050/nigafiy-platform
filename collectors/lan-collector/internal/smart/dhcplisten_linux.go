//go:build linux

package smart

import (
	"context"
	"fmt"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// ListenDHCPClient opens UDP 68 bound to one interface (SO_BINDTODEVICE). On Linux a socket bound
// to a unicast address does not receive broadcasts, so the wildcard address is used and the
// interface binding keeps each probe's replies apart. Needs CAP_NET_BIND_SERVICE and CAP_NET_RAW.
func ListenDHCPClient(ctx context.Context, iface DHCPInterface) (PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			if serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); serr != nil {
				return
			}
			if serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_BROADCAST, 1); serr != nil {
				return
			}
			if serr = unix.BindToDevice(int(fd), iface.Name); serr != nil {
				serr = fmt.Errorf("bind to interface %s: %w (the collector needs CAP_NET_RAW)", iface.Name, serr)
			}
		})
		if err != nil {
			return err
		}
		return serr
	}}
	conn, err := lc.ListenPacket(ctx, "udp4", "0.0.0.0:68")
	if err != nil {
		return nil, fmt.Errorf("cannot listen on UDP 68 (DHCP client port) on %s: %w — give the collector CAP_NET_BIND_SERVICE and CAP_NET_RAW", iface.Name, err)
	}
	return conn, nil
}
