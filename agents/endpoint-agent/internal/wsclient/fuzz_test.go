package wsclient

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"regexp"
	"testing"
	"time"
)

// fuzzConn is an in-memory net.Conn: it serves `in` to Read and discards what is written. It never
// touches the network. When `in` contains the placeholder {ACCEPT}, the placeholder is replaced by
// the correct Sec-WebSocket-Accept for the key the client wrote, so the fuzzer can get past the
// handshake and reach the frame reader.
type fuzzConn struct {
	in     []byte
	r      io.Reader
	wrote  bytes.Buffer
	closed bool
}

var keyRe = regexp.MustCompile(`Sec-WebSocket-Key: ([A-Za-z0-9+/=]+)\r\n`)

func (c *fuzzConn) Read(p []byte) (int, error) {
	if c.closed {
		return 0, net.ErrClosed
	}
	if c.r == nil {
		in := c.in
		if m := keyRe.FindSubmatch(c.wrote.Bytes()); m != nil {
			in = bytes.ReplaceAll(in, []byte("{ACCEPT}"), []byte(AcceptKey(string(m[1]))))
		}
		c.r = bytes.NewReader(in)
	}
	return c.r.Read(p)
}

func (c *fuzzConn) Write(p []byte) (int, error) {
	if c.closed {
		return 0, net.ErrClosed
	}
	if c.wrote.Len() < 1<<16 {
		c.wrote.Write(p)
	}
	return len(p), nil
}

func (c *fuzzConn) Close() error                     { c.closed = true; return nil }
func (c *fuzzConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *fuzzConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *fuzzConn) SetDeadline(time.Time) error      { return nil }
func (c *fuzzConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fuzzConn) SetWriteDeadline(time.Time) error { return nil }

const fuzzMax = 4096

// drain reads messages until an error and checks what Read hands to the agent.
func drain(t *testing.T, c *Conn) {
	for i := 0; ; i++ {
		op, msg, err := c.Read()
		if err != nil {
			return
		}
		if op != OpText && op != OpBinary {
			t.Fatalf("Read returned opcode %d", op)
		}
		if len(msg) > c.maxMessage {
			t.Fatalf("Read returned %d bytes, limit %d", len(msg), c.maxMessage)
		}
		if i > 1<<16 {
			t.Fatal("Read never ends")
		}
	}
}

func serverFrame(fin bool, op int, p []byte) []byte {
	f := EncodeFrame(op, p, [4]byte{})
	f[1] &^= 0x80 // server frames are not masked; a zero mask leaves the payload as is
	if !fin {
		f[0] &^= 0x80
	}
	hdr := len(f) - len(p) - 4
	return append(f[:hdr:hdr], f[hdr+4:]...)
}

func frameSeeds() [][]byte {
	cat := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	return [][]byte{
		serverFrame(true, OpText, []byte(`{"type":"hello"}`)),
		cat(serverFrame(false, OpText, []byte("frag-")), serverFrame(true, OpPing, []byte("p")), serverFrame(true, OpContinuation, []byte("ment"))),
		cat(serverFrame(true, OpPong, []byte("rtt")), serverFrame(true, OpBinary, make([]byte, 300))),
		serverFrame(true, OpClose, []byte{0x03, 0xe8, 'b', 'y', 'e'}),
		serverFrame(true, OpBinary, make([]byte, 70000)), // 64-bit length, over the limit
		{0x81, 0x81, 1, 2, 3, 4, 'x'},                    // masked server frame
		{0xc1, 0x00},                                     // reserved bit
		{0x82, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
	}
}

// The harness itself must reach the frame reader, or the fuzzers would only test the handshake.
func TestFuzzHarnessReachesFrames(t *testing.T) {
	in := append([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\n\r\n"), frameSeeds()[1]...)
	nc := &fuzzConn{in: in}
	c, err := Dial(context.Background(), "ws://agent.test/ws", Options{Dialer: func(context.Context, string, string) (net.Conn, error) { return nc, nil }})
	if err != nil {
		t.Fatal(err)
	}
	op, msg, err := c.Read()
	if err != nil || op != OpText || string(msg) != "frag-ment" {
		t.Fatalf("Read = %d %q %v", op, msg, err)
	}
	if !bytes.Contains(nc.wrote.Bytes(), []byte{0x8a, 0x81}) { // masked pong answering the ping
		t.Fatal("ping was not answered")
	}
}

// FuzzRead: frames from the server (an untrusted peer for the agent). Invariants: no panic, no
// unbounded allocation (MaxMessage holds), and only text/binary messages reach the caller.
func FuzzRead(f *testing.F) {
	for _, s := range frameSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in []byte) {
		nc := &fuzzConn{in: in}
		c := &Conn{nc: nc, br: bufio.NewReader(nc), maxMessage: fuzzMax}
		c.SetPongHandler(func([]byte) {})
		drain(t, c)
	})
}

// FuzzDial: the server's HTTP upgrade response followed by frames.
func FuzzDial(f *testing.F) {
	ok := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\n\r\n"
	for _, s := range frameSeeds()[:3] {
		f.Add(append([]byte(ok), s...))
	}
	f.Add([]byte("HTTP/1.1 403 Forbidden\r\nContent-Length: 5\r\n\r\nnope!"))
	f.Add([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n"))
	f.Add([]byte("HTTP/1.1 101 Switching Protocols\r\nTransfer-Encoding: chunked\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\n\r\n0\r\n\r\n"))
	f.Fuzz(func(t *testing.T, in []byte) {
		nc := &fuzzConn{in: in}
		c, err := Dial(context.Background(), "ws://agent.test/ws", Options{
			MaxMessage: fuzzMax,
			Dialer:     func(context.Context, string, string) (net.Conn, error) { return nc, nil },
		})
		if err != nil {
			if c != nil {
				t.Fatal("Dial returned a connection with an error")
			}
			return
		}
		drain(t, c)
	})
}
