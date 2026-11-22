package dnsfilter

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeAnswer builds an A answer for the question in msg (a protocol test double of an upstream).
func fakeAnswer(msg []byte, a [4]byte) ([]byte, error) {
	var p dnsmessage.Parser
	h, err := p.Start(msg)
	if err != nil {
		return nil, err
	}
	q, err := p.Question()
	if err != nil {
		return nil, err
	}
	h.Response = true
	b := dnsmessage.NewBuilder(nil, h)
	_ = b.StartQuestions()
	_ = b.Question(q)
	_ = b.StartAnswers()
	_ = b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 30}, dnsmessage.AResource{A: a})
	return b.Finish()
}

func firstA(t *testing.T, resp []byte) (dnsmessage.Header, [4]byte) {
	t.Helper()
	var p dnsmessage.Parser
	h, err := p.Start(resp)
	if err != nil {
		t.Fatal(err)
	}
	_ = p.SkipAllQuestions()
	rs, _ := p.AllAnswers()
	if len(rs) != 1 {
		t.Fatalf("want one answer, got %v (rcode %v)", rs, h.RCode)
	}
	return h, rs[0].Body.(*dnsmessage.AResource).A
}

// End-to-end over a real TCP socket on loopback: length-prefixed framing, several queries on one
// connection, a blocked name answered locally, and forwarding that keeps the TCP transport.
func TestListenTCP(t *testing.T) {
	s := NewServer(NewLists(), nil)
	var tcpForwards, udpForwards atomic.Int32
	s.Forwarder = func(_ context.Context, up string, msg []byte, tcp bool) ([]byte, error) {
		if tcp {
			tcpForwards.Add(1)
		} else {
			udpForwards.Add(1)
		}
		return fakeAnswer(msg, [4]byte{192, 0, 2, 44})
	}
	s.SetPolicy(Policy{Enabled: true, Upstreams: []string{"192.0.2.53"}, Default: Rule{Blocked: []string{"blocked.test"}}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind loopback TCP:", err)
	}
	addr := ln.Addr().String()
	ln.Close()
	if err := s.Listen(ctx, addr); err != nil {
		t.Skip("cannot bind loopback UDP+TCP:", err)
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	ask := func(name string) []byte {
		if err := writeTCP(conn, query(t, name, dnsmessage.TypeA)); err != nil {
			t.Fatal(err)
		}
		resp, err := readTCP(conn)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	h, a := firstA(t, ask("www.blocked.test."))
	if h.ID != 0xbeef || a != [4]byte{} {
		t.Fatalf("blocked name over TCP: want 0.0.0.0 with the query ID, got %v %v", h, a)
	}
	// Second and third query on the same connection.
	for i := 0; i < 2; i++ {
		h, a = firstA(t, ask("example.org."))
		if h.ID != 0xbeef || a != [4]byte{192, 0, 2, 44} {
			t.Fatalf("forwarded answer over TCP: got %v %v", h, a)
		}
	}
	if tcpForwards.Load() != 2 || udpForwards.Load() != 0 {
		t.Fatalf("a TCP query must be forwarded over TCP: tcp=%d udp=%d", tcpForwards.Load(), udpForwards.Load())
	}

	// A malformed frame (length says 300, the connection ends after 3 bytes) closes the connection
	// without an answer and without hurting the server.
	bad, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = bad.Write([]byte{0x01, 0x2c, 0x00, 0x01, 0x02})
	_ = bad.(*net.TCPConn).CloseWrite()
	_ = bad.SetDeadline(time.Now().Add(3 * time.Second))
	if n, _ := bad.Read(make([]byte, 16)); n != 0 {
		t.Fatalf("a truncated frame must not be answered, got %d bytes", n)
	}
	bad.Close()
	if _, a = firstA(t, ask("example.org.")); a != [4]byte{192, 0, 2, 44} {
		t.Fatal("the server must keep answering after a bad client")
	}
}

func TestTCPFramingAndAnswerCheck(t *testing.T) {
	var buf bytes.Buffer
	msg := query(t, "example.org.", dnsmessage.TypeA)
	if err := writeTCP(&buf, msg); err != nil {
		t.Fatal(err)
	}
	if got := buf.Bytes(); int(got[0])<<8|int(got[1]) != len(msg) {
		t.Fatalf("length prefix %v does not match %d", got[:2], len(msg))
	}
	back, err := readTCP(&buf)
	if err != nil || !bytes.Equal(back, msg) {
		t.Fatalf("round trip failed: %v", err)
	}
	if _, err := readTCP(bytes.NewReader([]byte{0x00})); err == nil {
		t.Fatal("a one-byte frame must fail")
	}
	// The forwarder accepts only a response carrying the query's ID.
	resp, _ := fakeAnswer(msg, [4]byte{1, 2, 3, 4})
	if _, err := checkID(msg, resp); err != nil {
		t.Fatalf("matching answer refused: %v", err)
	}
	other := append([]byte(nil), resp...)
	other[1] ^= 0xff
	if _, err := checkID(msg, other); err == nil {
		t.Fatal("an answer with another ID must be refused (spoofing / stale answers)")
	}
	if _, err := checkID(msg, msg); err == nil {
		t.Fatal("a query echoed back is not an answer")
	}
}

// Lists.Ensure: the on-disk cache is used first, the internet only once a day, and a failed refresh
// keeps the previous list. The download source is a loopback HTTP test double.
func TestListsEnsureCache(t *testing.T) {
	var hits atomic.Int32
	body := "0.0.0.0 ads.example.net\n0.0.0.0 tracker.example.org\n"
	fail := atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	saved := downloaded["ads_malware"]
	downloaded["ads_malware"] = srv.URL + "/hosts"
	defer func() { downloaded["ads_malware"] = saved }()

	dir := t.TempDir()
	path := filepath.Join(dir, "ads_malware.hosts")
	ctx := context.Background()

	t.Run("fresh cache file: loaded from disk, no download", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("0.0.0.0 cached.example.com\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		l := NewLists()
		if errs := l.Ensure(ctx, dir, []string{"ads_malware", "social", "no_such_category"}, srv.Client()); len(errs) != 0 {
			t.Fatal(errs)
		}
		if hits.Load() != 0 {
			t.Fatal("a cache file younger than a day must not be downloaded again")
		}
		if !l.Has("ads_malware", "www.cached.example.com") || l.Counts()["ads_malware"] != 1 {
			t.Fatalf("cached list not loaded: %v", l.Counts())
		}
	})

	t.Run("stale cache file: refreshed from the source", func(t *testing.T) {
		old := time.Now().Add(-48 * time.Hour)
		_ = os.Chtimes(path, old, old)
		l := NewLists()
		if errs := l.Ensure(ctx, dir, []string{"ads_malware"}, srv.Client()); len(errs) != 0 {
			t.Fatal(errs)
		}
		if hits.Load() != 1 {
			t.Fatalf("want one download, got %d", hits.Load())
		}
		if l.Has("ads_malware", "cached.example.com") || !l.Has("ads_malware", "ads.example.net") {
			t.Fatal("the refreshed list must replace the stale one")
		}
		disk, _ := os.ReadFile(path)
		if !strings.Contains(string(disk), "tracker.example.org") {
			t.Fatal("the download must be written to the cache file")
		}
		if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
			t.Fatal("no temporary file may remain")
		}
		// Loaded in memory less than a day ago: a second call does not download.
		if errs := l.Ensure(ctx, dir, []string{"ads_malware"}, srv.Client()); len(errs) != 0 || hits.Load() != 1 {
			t.Fatalf("second Ensure must use the loaded list: errs=%v hits=%d", errs, hits.Load())
		}
	})

	t.Run("failed refresh: error reported, previous list kept", func(t *testing.T) {
		old := time.Now().Add(-48 * time.Hour)
		_ = os.Chtimes(path, old, old)
		fail.Store(true)
		before := hits.Load()
		l := NewLists()
		errs := l.Ensure(ctx, dir, []string{"ads_malware"}, srv.Client())
		if len(errs) != 1 || !strings.Contains(errs[0].Error(), "HTTP 503") {
			t.Fatalf("want one HTTP 503 error, got %v", errs)
		}
		if hits.Load() != before+1 {
			t.Fatal("the refresh must have been attempted")
		}
		if !l.Has("ads_malware", "ads.example.net") {
			t.Fatal("the stale cached list must stay in use when the refresh fails")
		}
		disk, _ := os.ReadFile(path)
		if !strings.Contains(string(disk), "ads.example.net") {
			t.Fatal("a failed download must not overwrite the cache file")
		}
	})

	t.Run("no cache and no source: nothing loaded, error reported", func(t *testing.T) {
		fail.Store(true)
		l := NewLists()
		errs := l.Ensure(ctx, t.TempDir(), []string{"ads_malware"}, srv.Client())
		if len(errs) != 1 {
			t.Fatalf("want one error, got %v", errs)
		}
		if _, ok := l.Counts()["ads_malware"]; ok {
			t.Fatal("no list may be invented")
		}
	})
}
