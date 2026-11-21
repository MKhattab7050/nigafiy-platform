//go:build windows

package smart

import (
	"context"
	"fmt"
	"net"
	"syscall"
)

// ListenDHCPClient opens UDP 68 on the interface's own address. Windows delivers broadcasts that
// arrive on an interface to a socket bound to that interface's address. SO_REUSEADDR lets the probe
// share the port with the Windows DHCP client service.
func ListenDHCPClient(ctx context.Context, iface DHCPInterface) (PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			if serr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); serr != nil {
				return
			}
			serr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
		})
		if err != nil {
			return err
		}
		return serr
	}}
	conn, err := lc.ListenPacket(ctx, "udp4", fmt.Sprintf("%s:68", iface.Address))
	if err != nil {
		return nil, fmt.Errorf("cannot listen on UDP 68 (DHCP client port) on %s: %w — allow inbound UDP 68 for the collector in Windows Defender Firewall", iface.Address, err)
	}
	return conn, nil
}
