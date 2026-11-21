package configbackup

import (
	"bufio"
	"context"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// ProbeResult says whether a device answers SSH, and with which identification line
// ("SSH-2.0-ROSSSH" names MikroTik, "SSH-2.0-Cisco-1.25" a Cisco CLI…). No login is attempted: the
// probe connects, reads the server's identification line and closes the connection.
type ProbeResult struct {
	Address       string `json:"address"`
	Port          int    `json:"port"`
	Open          bool   `json:"open"`
	ServerVersion string `json:"server_version,omitempty"`
	Error         string `json:"error,omitempty"`
}

const (
	probeTimeout   = 5 * time.Second
	maxProbeLines  = 10 // RFC 4253 §4.2: a server may send other lines before its identification
	maxProbeLength = 255
)

// Probe checks one address. The address must pass the same scope authorization as a backup.
func Probe(ctx context.Context, address string, port int, opts Options) ProbeResult {
	res := ProbeResult{Address: address, Port: port}
	addr, err := netip.ParseAddr(strings.TrimSpace(address))
	if err != nil || !addr.Is4() {
		res.Error = "not an IPv4 address"
		return res
	}
	if err := authorize(addr, opts.Authorized, opts.AllowLoopback); err != nil {
		res.Error = err.Error()
		return res
	}
	if port <= 0 || port > 65535 {
		port = defaultPort
		res.Port = port
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	dial := opts.Dial
	if dial == nil {
		d := &net.Dialer{}
		dial = d.DialContext
	}
	conn, err := dial(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		res.Error = shortNetErr(err)
		return res
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	r := bufio.NewReaderSize(conn, 512)
	for i := 0; i < maxProbeLines; i++ {
		line, err := r.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "SSH-") {
			res.Open = true
			res.ServerVersion = clip(sanitize(line), maxProbeLength)
			return res
		}
		if err != nil || len(line) > maxProbeLength {
			break
		}
	}
	// Something listens, but it is not an SSH server (or it said nothing in time).
	res.Error = "the port is open but did not answer with an SSH identification"
	return res
}

// sanitize keeps printable ASCII: the line is device-supplied text.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return b.String()
}
