package dnsfilter

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// fuzzQuery builds a seed question without a *testing.T (seeds are added before the fuzz loop).
func fuzzQuery(name string, typ dnsmessage.Type, id uint16) []byte {
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, RecursionDesired: true})
	_ = b.StartQuestions()
	_ = b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET})
	msg, _ := b.Finish()
	return msg
}

// FuzzHandle feeds arbitrary bytes, as a LAN client would, to the filtering resolver. The
// forwarder is a test double that never touches the network: it either fails (SERVFAIL path) or
// echoes the query as an answer. Invariants: no panic, and any answer is a parsable DNS response
// with the query's ID that echoes the question.
func FuzzHandle(f *testing.F) {
	for i, q := range [][]byte{
		fuzzQuery("example.com.", dnsmessage.TypeA, 0xbeef),
		fuzzQuery("www.roblox.com.", dnsmessage.TypeAAAA, 1),
		fuzzQuery("dns.google.", dnsmessage.TypeHTTPS, 2),
		fuzzQuery("blocked.example.", dnsmessage.TypeMX, 3),
		fuzzQuery("tiktok.com.", dnsmessage.TypeTXT, 4),
	} {
		f.Add(q, i%2 == 0)
	}
	f.Add([]byte{}, false)
	f.Add(make([]byte, 12), true)
	f.Fuzz(func(t *testing.T, msg []byte, fail bool) {
		s := NewServer(NewLists(), nil)
		s.Now = func() time.Time { return time.Date(2026, 11, 24, 23, 0, 0, 0, time.UTC) }
		s.Forwarder = func(_ context.Context, _ string, m []byte, _ bool) ([]byte, error) {
			if fail {
				return nil, errors.New("upstream down")
			}
			return m, nil
		}
		s.SetPolicy(Policy{
			Enabled:   true,
			Upstreams: []string{"192.0.2.1"},
			Default:   Rule{Categories: []string{"games", "social"}, Blocked: []string{"blocked.example"}},
			Clients:   []Client{{IP: "192.168.1.9", Rule: Rule{Schedule: []Window{{Days: []int{0, 1, 2, 3, 4, 5, 6}, From: "22:00", To: "07:00"}}}}},
		})
		for _, ip := range []string{"192.168.1.5", "192.168.1.9"} {
			resp := s.Handle(context.Background(), ip, msg, false)
			if resp == nil {
				continue
			}
			var qp dnsmessage.Parser
			qh, err := qp.Start(msg)
			if err != nil {
				t.Fatalf("answered an unparsable message")
			}
			q, err := qp.Question()
			if err != nil {
				t.Fatalf("answered a message without a question")
			}
			if !fail && bytes.Equal(resp, msg) {
				continue // forwarded unchanged (the double echoes the query)
			}
			var rp dnsmessage.Parser
			rh, err := rp.Start(resp)
			if err != nil {
				t.Fatalf("own answer does not parse: %v (% x)", err, resp)
			}
			if !rh.Response || rh.ID != qh.ID {
				t.Fatalf("answer header wrong: %+v for query %+v", rh, qh)
			}
			rq, err := rp.Question()
			if err != nil || rq.Name.String() != q.Name.String() || rq.Type != q.Type {
				t.Fatalf("answer does not echo the question: %v %v vs %v", err, rq, q)
			}
		}
		_, _, _ = s.TakeStats(10)
	})
}

// FuzzParseHosts: downloaded block lists are untrusted text. Every kept entry must be a
// normalized, non-empty domain with a dot, no whitespace and no empty label.
func FuzzParseHosts(f *testing.F) {
	f.Add("# comment\n0.0.0.0 ads.example.com\n127.0.0.1 localhost\nplain.example.org\n0.0.0.0 0.0.0.0\n")
	f.Add("0.0.0.0 tracker.example # trailing\n\n\t\n::1 ip6-localhost\nfoo.local\nUPPER.Example.COM.\n")
	f.Add(strings.Repeat("a", 70000) + ".com\nok.example\n")
	f.Fuzz(func(t *testing.T, list string) {
		for d := range ParseHosts(strings.NewReader(list)) {
			if d == "" || d != Normalize(d) || !strings.Contains(d, ".") || strings.ContainsAny(d, " \t\r\n#") ||
				strings.HasPrefix(d, ".") || strings.HasSuffix(d, ".") || strings.Contains(d, "..") {
				t.Fatalf("bad entry %q", d)
			}
		}
	})
}

// FuzzReadTCP: the TCP framing (2-byte length prefix) read from a LAN client.
func FuzzReadTCP(f *testing.F) {
	q := fuzzQuery("example.com.", dnsmessage.TypeA, 7)
	framed := binary.BigEndian.AppendUint16(nil, uint16(len(q)))
	f.Add(append(framed, q...))
	f.Add([]byte{0xff, 0xff, 1, 2})
	f.Add([]byte{0})
	f.Fuzz(func(t *testing.T, in []byte) {
		msg, err := readTCP(bytes.NewReader(in))
		if err != nil {
			return
		}
		if len(in) < 2 || len(msg) != int(binary.BigEndian.Uint16(in)) || !bytes.Equal(msg, in[2:2+len(msg)]) {
			t.Fatalf("readTCP returned %d bytes for % x", len(msg), in)
		}
		var buf bytes.Buffer
		if err := writeTCP(&buf, msg); err != nil || !bytes.Equal(buf.Bytes(), in[:2+len(msg)]) {
			t.Fatalf("writeTCP does not round-trip")
		}
	})
}
