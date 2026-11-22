package wsclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A minimal RFC 6455 server for the tests: it checks the client's handshake and frames
// (client frames MUST be masked) and writes unmasked server frames.
type testServer struct {
	nc net.Conn
	br *bufio.Reader
}

func (s *testServer) writeFrame(fin bool, op int, p []byte) {
	b0 := byte(op)
	if fin {
		b0 |= 0x80
	}
	hdr := []byte{b0}
	switch n := len(p); {
	case n <= 125:
		hdr = append(hdr, byte(n))
	case n <= 0xffff:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	_, _ = s.nc.Write(append(hdr, p...))
}

func (s *testServer) readFrame(t *testing.T) (int, []byte) {
	t.Helper()
	var h [2]byte
	if _, err := io.ReadFull(s.br, h[:]); err != nil {
		t.Fatalf("server read: %v", err)
	}
	if h[1]&0x80 == 0 {
		t.Fatal("client frame is not masked")
	}
	n := uint64(h[1] & 0x7f)
	if n == 126 {
		var e [2]byte
		_, _ = io.ReadFull(s.br, e[:])
		n = uint64(binary.BigEndian.Uint16(e[:]))
	} else if n == 127 {
		var e [8]byte
		_, _ = io.ReadFull(s.br, e[:])
		n = binary.BigEndian.Uint64(e[:])
	}
	var mask [4]byte
	_, _ = io.ReadFull(s.br, mask[:])
	p := make([]byte, n)
	_, _ = io.ReadFull(s.br, p)
	for i := range p {
		p[i] ^= mask[i&3]
	}
	return int(h[0] & 0x0f), p
}

func newServer(t *testing.T, check func(r *http.Request), handle func(s *testServer)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if check != nil {
			check(r)
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		if r.Header.Get("Sec-WebSocket-Version") != "13" || key == "" || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "bad upgrade", http.StatusBadRequest)
			return
		}
		nc, brw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + AcceptKey(key) + "\r\n\r\n")
		_ = brw.Flush()
		handle(&testServer{nc: nc, br: brw.Reader})
	}))
}

func TestAcceptKeyMatchesRFCExample(t *testing.T) {
	// RFC 6455 §1.3 example.
	if got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("AcceptKey = %s", got)
	}
}

func TestEncodeFrameLengthsAndMasking(t *testing.T) {
	mask := [4]byte{1, 2, 3, 4}
	for _, n := range []int{0, 1, 125, 126, 65535, 65536, 200000} {
		p := bytes.Repeat([]byte{0xAB}, n)
		f := EncodeFrame(OpBinary, p, mask)
		if f[0] != 0x82 || f[1]&0x80 == 0 {
			t.Fatalf("n=%d: header %x", n, f[:2])
		}
		off := 2
		switch {
		case n <= 125:
			if int(f[1]&0x7f) != n {
				t.Fatalf("n=%d: 7-bit length %d", n, f[1]&0x7f)
			}
		case n <= 0xffff:
			if f[1]&0x7f != 126 || int(binary.BigEndian.Uint16(f[2:])) != n {
				t.Fatalf("n=%d: 16-bit length wrong", n)
			}
			off = 4
		default:
			if f[1]&0x7f != 127 || int(binary.BigEndian.Uint64(f[2:])) != n {
				t.Fatalf("n=%d: 64-bit length wrong", n)
			}
			off = 10
		}
		if !bytes.Equal(f[off:off+4], mask[:]) || len(f) != off+4+n {
			t.Fatalf("n=%d: mask/size wrong", n)
		}
		for i := 0; i < n; i++ {
			if f[off+4+i]^mask[i&3] != 0xAB {
				t.Fatalf("n=%d: byte %d not masked correctly", n, i)
			}
		}
	}
}

func TestDialExchangeFragmentsPingPongAndClose(t *testing.T) {
	done := make(chan struct{})
	srv := newServer(t, func(r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer lda_x.y" {
			t.Errorf("auth header not sent: %q", r.Header.Get("Authorization"))
		}
	}, func(s *testServer) {
		defer close(done)
		// Echo the client's text and a big binary message back.
		op, p := s.readFrame(t)
		if op != OpText || string(p) != `{"t":"hello"}` {
			t.Errorf("server got %d %q", op, p)
		}
		op, p = s.readFrame(t)
		if op != OpBinary || len(p) != 70000 {
			t.Errorf("server got binary %d len %d", op, len(p))
		}
		// A fragmented text message with a ping in the middle (allowed by §5.4).
		s.writeFrame(false, OpText, []byte("frag-"))
		s.writeFrame(true, OpPing, []byte("p1"))
		s.writeFrame(true, OpContinuation, []byte("ment"))
		// The client answers the ping with a pong carrying the same payload.
		if op, p := s.readFrame(t); op != OpPong || string(p) != "p1" {
			t.Errorf("expected pong p1, got %d %q", op, p)
		}
		s.writeFrame(true, OpBinary, p)
		// The client's ping is answered by us.
		if op, p := s.readFrame(t); op != OpPing || string(p) != "rtt" {
			t.Errorf("expected client ping, got %d %q", op, p)
		}
		s.writeFrame(true, OpPong, []byte("rtt"))
		// Close from the server: the client echoes it.
		s.writeFrame(true, OpClose, append(binary.BigEndian.AppendUint16(nil, 4000), "session_ended"...))
		if op, p := s.readFrame(t); op != OpClose || binary.BigEndian.Uint16(p) != 4000 {
			t.Errorf("expected close echo 4000, got %d %v", op, p)
		}
	})
	defer srv.Close()

	c, err := Dial(context.Background(), srv.URL+"/api/v1/agent/stream?session=abc", Options{Header: http.Header{"Authorization": {"Bearer lda_x.y"}}})
	if err != nil {
		t.Fatal(err)
	}
	pong := make(chan string, 1)
	c.SetPongHandler(func(p []byte) { pong <- string(p) })
	if err := c.WriteText([]byte(`{"t":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteBinary(bytes.Repeat([]byte{7}, 70000)); err != nil {
		t.Fatal(err)
	}
	op, p, err := c.Read()
	if err != nil || op != OpText || string(p) != "frag-ment" {
		t.Fatalf("Read = %d %q %v", op, p, err)
	}
	op, p, err = c.Read()
	if err != nil || op != OpBinary || len(p) != 70000 {
		t.Fatalf("binary echo = %d len %d %v", op, len(p), err)
	}
	if err := c.Ping([]byte("rtt")); err != nil {
		t.Fatal(err)
	}
	_, _, err = c.Read()
	var ce *CloseError
	if !errors.As(err, &ce) || ce.Code != 4000 || ce.Reason != "session_ended" {
		t.Fatalf("expected CloseError 4000, got %v", err)
	}
	select {
	case v := <-pong:
		if v != "rtt" {
			t.Fatalf("pong payload %q", v)
		}
	case <-time.After(time.Second):
		t.Fatal("pong handler not called")
	}
	<-done
}

func TestDialRejectsRefusalAndBadAccept(t *testing.T) {
	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"no_remote_session"}`, http.StatusConflict)
	}))
	defer refuse.Close()
	_, err := Dial(context.Background(), refuse.URL, Options{})
	var he *HandshakeError
	if !errors.As(err, &he) || he.Status != http.StatusConflict || !strings.Contains(he.Body, "no_remote_session") {
		t.Fatalf("expected HandshakeError 409, got %v", err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nc, brw, _ := w.(http.Hijacker).Hijack()
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAA\r\n\r\n")
		_ = brw.Flush()
	}))
	defer bad.Close()
	if _, err := Dial(context.Background(), bad.URL, Options{}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("a wrong Sec-WebSocket-Accept must be refused, got %v", err)
	}
	if _, err := Dial(context.Background(), "ftp://x", Options{}); err == nil {
		t.Fatal("ftp scheme accepted")
	}
}

func TestReadRejectsMaskedServerFramesAndOversizedMessages(t *testing.T) {
	srv := newServer(t, nil, func(s *testServer) {
		// Masked frame from the server: a protocol error.
		_, _ = s.nc.Write([]byte{0x81, 0x81, 1, 2, 3, 4, 'x' ^ 1})
		time.Sleep(100 * time.Millisecond)
	})
	defer srv.Close()
	c, err := Dial(context.Background(), srv.URL, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Read(); !errors.Is(err, ErrProtocol) {
		t.Fatalf("masked server frame accepted: %v", err)
	}

	big := newServer(t, nil, func(s *testServer) {
		s.writeFrame(true, OpBinary, make([]byte, 2048))
		time.Sleep(100 * time.Millisecond)
	})
	defer big.Close()
	c2, err := Dial(context.Background(), big.URL, Options{MaxMessage: 1024})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c2.Read(); err == nil || !strings.Contains(err.Error(), "too big") {
		t.Fatalf("oversized message accepted: %v", err)
	}
}
