// Package wsclient is a small RFC 6455 WebSocket client (standard library only): the opening
// handshake with Sec-WebSocket-Accept verification, masked client frames, text and binary
// messages, fragmentation, ping/pong and the close handshake. It carries the endpoint agent's
// live remote-desktop channel to the API (frames up, input and control down).
package wsclient

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 -- RFC 6455 §4.2.2 mandates SHA-1 for Sec-WebSocket-Accept; not used for security
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Opcodes (RFC 6455 §5.2).
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// Close codes used by the agent (RFC 6455 §7.4.1).
const (
	CloseNormal          = 1000
	CloseGoingAway       = 1001
	CloseProtocolError   = 1002
	CloseMessageTooBig   = 1009
	CloseNoStatus        = 1005
	CloseAbnormal        = 1006
	maxControlPayload    = 125
	defaultMaxMessage    = 16 << 20
	websocketGUID        = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	defaultHandshakeTime = 15 * time.Second
)

// CloseError is returned by Read once the peer closed the connection.
type CloseError struct {
	Code   int
	Reason string
}

func (e *CloseError) Error() string {
	return fmt.Sprintf("websocket closed: %d %s", e.Code, e.Reason)
}

// ErrProtocol: the server broke RFC 6455 (the connection is then closed with 1002).
var ErrProtocol = errors.New("websocket protocol error")

// HandshakeError: the server did not accept the upgrade (status and a short body excerpt).
type HandshakeError struct {
	Status int
	Body   string
}

func (e *HandshakeError) Error() string {
	return fmt.Sprintf("websocket upgrade refused: HTTP %d %s", e.Status, e.Body)
}

// Options for Dial.
type Options struct {
	Header http.Header
	TLS    *tls.Config
	// MaxMessage limits one received message (default 16 MiB).
	MaxMessage int
	// HandshakeTimeout bounds connect + TLS + upgrade (default 15 s).
	HandshakeTimeout time.Duration
	// Dialer is used for the TCP connection (tests); nil uses net.Dialer.
	Dialer func(ctx context.Context, network, addr string) (net.Conn, error)
}

// Conn is one client WebSocket connection. Writes may come from several goroutines; Read must be
// called from one goroutine.
type Conn struct {
	nc         net.Conn
	br         *bufio.Reader
	wmu        sync.Mutex
	maxMessage int
	closeOnce  sync.Once
	closeSent  bool
	onPong     func([]byte)
	pmu        sync.Mutex
}

// AcceptKey is the Sec-WebSocket-Accept value for a key (RFC 6455 §4.2.2).
func AcceptKey(key string) string {
	h := sha1.New() // #nosec G401 -- mandated by RFC 6455
	h.Write([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// Dial opens a WebSocket. rawURL may use ws://, wss://, http:// or https://.
func Dial(ctx context.Context, rawURL string, opts Options) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	secure := false
	switch u.Scheme {
	case "ws", "http":
	case "wss", "https":
		secure = true
	default:
		return nil, fmt.Errorf("unsupported websocket scheme %q", u.Scheme)
	}
	host := u.Host
	if u.Port() == "" {
		if secure {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}
	timeout := opts.HandshakeTimeout
	if timeout <= 0 {
		timeout = defaultHandshakeTime
	}
	hctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dial := opts.Dialer
	if dial == nil {
		d := &net.Dialer{KeepAlive: 30 * time.Second}
		dial = d.DialContext
	}
	nc, err := dial(hctx, "tcp", host)
	if err != nil {
		return nil, err
	}
	if dl, ok := hctx.Deadline(); ok {
		_ = nc.SetDeadline(dl)
	}
	if secure {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12}
		if opts.TLS != nil {
			cfg = opts.TLS.Clone()
		}
		if cfg.ServerName == "" {
			cfg.ServerName = u.Hostname()
		}
		cfg.NextProtos = []string{"http/1.1"} // the upgrade is an HTTP/1.1 mechanism
		tc := tls.Client(nc, cfg)
		if err := tc.HandshakeContext(hctx); err != nil {
			_ = nc.Close()
			return nil, err
		}
		nc = tc
	}

	keyRaw := make([]byte, 16)
	if _, err := rand.Read(keyRaw); err != nil {
		_ = nc.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyRaw)
	path := u.RequestURI()
	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", path, u.Host, key)
	for k, vs := range opts.Header {
		for _, v := range vs {
			if strings.ContainsAny(k+v, "\r\n") {
				_ = nc.Close()
				return nil, errors.New("header contains a line break")
			}
			fmt.Fprintf(&b, "%s: %s\r\n", k, v)
		}
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(nc, b.String()); err != nil {
		_ = nc.Close()
		return nil, err
	}
	br := bufio.NewReaderSize(nc, 64<<10)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = nc.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		_ = nc.Close()
		return nil, &HandshakeError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") || !headerHasToken(resp.Header, "Connection", "upgrade") {
		_ = nc.Close()
		return nil, fmt.Errorf("%w: missing Upgrade/Connection headers in the 101 response", ErrProtocol)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != AcceptKey(key) {
		_ = nc.Close()
		return nil, fmt.Errorf("%w: Sec-WebSocket-Accept does not match", ErrProtocol)
	}
	_ = nc.SetDeadline(time.Time{})
	maxMsg := opts.MaxMessage
	if maxMsg <= 0 {
		maxMsg = defaultMaxMessage
	}
	return &Conn{nc: nc, br: br, maxMessage: maxMsg}, nil
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// SetPongHandler is called with each pong's payload (used to measure round trips).
func (c *Conn) SetPongHandler(fn func([]byte)) {
	c.pmu.Lock()
	c.onPong = fn
	c.pmu.Unlock()
}

// SetWriteDeadline bounds the next writes (a stalled network must not block the sender forever).
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.nc.SetWriteDeadline(t) }

// SetReadDeadline bounds Read.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.nc.SetReadDeadline(t) }

// WriteText sends one text message (must be valid UTF-8; the agent only sends JSON).
func (c *Conn) WriteText(p []byte) error { return c.writeFrame(OpText, p) }

// WriteBinary sends one binary message.
func (c *Conn) WriteBinary(p []byte) error { return c.writeFrame(OpBinary, p) }

// Ping sends a ping; the server's pong reaches the pong handler.
func (c *Conn) Ping(p []byte) error {
	if len(p) > maxControlPayload {
		return errors.New("ping payload too long")
	}
	return c.writeFrame(OpPing, p)
}

// EncodeFrame builds one masked client frame (exported for tests and the fuzz check).
func EncodeFrame(op int, payload []byte, mask [4]byte) []byte {
	n := len(payload)
	hdr := make([]byte, 0, 14)
	hdr = append(hdr, 0x80|byte(op&0x0f))
	switch {
	case n <= 125:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 0xffff:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	hdr = append(hdr, mask[:]...)
	out := make([]byte, len(hdr)+n)
	copy(out, hdr)
	body := out[len(hdr):]
	for i := 0; i < n; i++ {
		body[i] = payload[i] ^ mask[i&3]
	}
	return out
}

func (c *Conn) writeFrame(op int, p []byte) error {
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	frame := EncodeFrame(op, p, mask)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closeSent {
		return net.ErrClosed
	}
	if op == OpClose {
		c.closeSent = true
	}
	_, err := c.nc.Write(frame)
	return err
}

// Read returns the next text or binary message. Pings are answered, pongs go to the pong handler,
// and a close frame is answered and returned as *CloseError.
func (c *Conn) Read() (int, []byte, error) {
	var msgOp int
	var msg []byte
	for {
		fin, op, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			if err := c.writeFrame(OpPong, payload); err != nil && !errors.Is(err, net.ErrClosed) {
				return 0, nil, err
			}
			continue
		case OpPong:
			c.pmu.Lock()
			fn := c.onPong
			c.pmu.Unlock()
			if fn != nil {
				fn(payload)
			}
			continue
		case OpClose:
			ce := &CloseError{Code: CloseNoStatus}
			if len(payload) >= 2 {
				ce.Code = int(binary.BigEndian.Uint16(payload))
				ce.Reason = string(payload[2:])
			}
			_ = c.writeClose(ce.Code, "")
			_ = c.nc.Close()
			return 0, nil, ce
		case OpText, OpBinary:
			if msgOp != 0 {
				return 0, nil, c.fail("new message inside a fragmented one")
			}
			msgOp = op
			msg = append(msg[:0], payload...)
		case OpContinuation:
			if msgOp == 0 {
				return 0, nil, c.fail("continuation without a message")
			}
			if len(msg)+len(payload) > c.maxMessage {
				_ = c.Close(CloseMessageTooBig, "message too big")
				return 0, nil, errors.New("websocket message too big")
			}
			msg = append(msg, payload...)
		default:
			return 0, nil, c.fail(fmt.Sprintf("unknown opcode %d", op))
		}
		if fin {
			return msgOp, msg, nil
		}
	}
}

func (c *Conn) fail(why string) error {
	_ = c.Close(CloseProtocolError, why)
	return fmt.Errorf("%w: %s", ErrProtocol, why)
}

func (c *Conn) readFrame() (bool, int, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(c.br, h[:]); err != nil {
		return false, 0, nil, err
	}
	fin := h[0]&0x80 != 0
	if h[0]&0x70 != 0 {
		return false, 0, nil, c.fail("reserved bits set (no extension was negotiated)")
	}
	op := int(h[0] & 0x0f)
	if h[1]&0x80 != 0 {
		return false, 0, nil, c.fail("server frames must not be masked")
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	if op >= OpClose {
		if !fin || n > maxControlPayload {
			return false, 0, nil, c.fail("invalid control frame")
		}
	}
	if n > uint64(c.maxMessage) {
		_ = c.Close(CloseMessageTooBig, "message too big")
		return false, 0, nil, errors.New("websocket message too big")
	}
	payload := make([]byte, int(n))
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	return fin, op, payload, nil
}

func (c *Conn) writeClose(code int, reason string) error {
	if code == CloseNoStatus || code == CloseAbnormal {
		code = CloseNormal
	}
	if len(reason) > maxControlPayload-2 {
		reason = reason[:maxControlPayload-2]
	}
	p := binary.BigEndian.AppendUint16(nil, uint16(code))
	p = append(p, reason...)
	return c.writeFrame(OpClose, p)
}

// Close starts the close handshake (best effort) and closes the connection.
func (c *Conn) Close(code int, reason string) error {
	var err error
	c.closeOnce.Do(func() {
		_ = c.nc.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = c.writeClose(code, reason)
		err = c.nc.Close()
	})
	return err
}
