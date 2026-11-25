package dnsfilter

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func at(day time.Weekday, hhmm string) time.Time {
	// 2026-11-08 is a Sunday.
	base := time.Date(2026, 11, 8, 0, 0, 0, 0, time.Local).AddDate(0, 0, int(day))
	t, _ := time.ParseInLocation("15:04", hhmm, time.Local)
	return base.Add(time.Duration(t.Hour())*time.Hour + time.Duration(t.Minute())*time.Minute)
}

func TestWindowOvernight(t *testing.T) {
	w := Window{Days: []int{0, 1, 2, 3, 4}, From: "22:00", To: "07:00"} // school nights Sun–Thu
	cases := []struct {
		t    time.Time
		want bool
	}{
		{at(time.Sunday, "21:59"), false},
		{at(time.Sunday, "22:00"), true},
		{at(time.Monday, "06:59"), true}, // the Sunday night window continues into Monday
		{at(time.Monday, "07:00"), false},
		{at(time.Friday, "23:00"), false},   // Friday is not listed
		{at(time.Friday, "03:00"), true},    // Thursday night continues into Friday morning
		{at(time.Saturday, "03:00"), false}, // Friday night is not listed
	}
	for _, c := range cases {
		if got := w.Active(c.t); got != c.want {
			t.Errorf("%s: got %v want %v", c.t.Format("Mon 15:04"), got, c.want)
		}
	}
	day := Window{Days: []int{6}, From: "13:00", To: "15:00"}
	if !day.Active(at(time.Saturday, "14:00")) || day.Active(at(time.Saturday, "15:00")) || day.Active(at(time.Sunday, "14:00")) {
		t.Error("same-day window wrong")
	}
	if (Window{Days: []int{0}, From: "bad", To: "07:00"}).Active(at(time.Sunday, "01:00")) {
		t.Error("malformed window must never block")
	}
}

func TestDecide(t *testing.T) {
	lists := NewLists()
	now := at(time.Tuesday, "12:00")
	r := Rule{Categories: []string{"social"}, Blocked: []string{"example.org"}, Allowed: []string{"business.facebook.com"}}
	cases := map[string]Decision{
		"www.tiktok.com.":          {Blocked: true, Reason: "category", Category: "social"},
		"static.xx.fbcdn.net":      {Blocked: true, Reason: "category", Category: "social"},
		"business.facebook.com":    {},
		"shop.example.org":         {Blocked: true, Reason: "domain"},
		"notexample.org":           {},
		"wikipedia.org":            {},
		"use-application-dns.net.":  {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
		"dns.google":                {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
		"mozilla.cloudflare-dns.com": {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
		"doh.dns.apple.com":         {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
		"dns.controld.com":          {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
		"doh.pub":                   {Blocked: true, Reason: "encrypted_dns", Category: "encrypted_dns"},
	}
	for name, want := range cases {
		if got := Decide(r, name, now, lists); got != want {
			t.Errorf("%s: got %+v want %+v", name, got, want)
		}
	}
	until := now.Add(time.Hour)
	if d := Decide(Rule{PausedUntil: &until, Allowed: []string{"wikipedia.org"}}, "wikipedia.org", now, lists); d.Reason != "paused" {
		t.Errorf("paused device must be blocked everywhere, got %+v", d)
	}
	past := now.Add(-time.Minute)
	if d := Decide(Rule{PausedUntil: &past}, "wikipedia.org", now, lists); d.Blocked {
		t.Error("an expired pause must not block")
	}
	bed := Rule{Schedule: []Window{{Days: []int{2}, From: "11:00", To: "13:00"}}}
	if d := Decide(bed, "wikipedia.org", now, lists); d.Reason != "schedule" {
		t.Errorf("schedule should block, got %+v", d)
	}
}

func TestParseHosts(t *testing.T) {
	in := "# comment\n127.0.0.1 localhost\n0.0.0.0 0.0.0.0\n0.0.0.0 Ads.Example.com # trailing\n0.0.0.0 tracker.net\nplain-domain.org\n::1 ip6-localhost\n10.0.0.1\n" +
		// Empty labels can never match a question (found by FuzzParseHosts): dropped.
		"0.0.0.0 double-dot.example..\n0.0.0.0 .leading.example\n0.0.0.0 mid..dot.example\n"
	set := ParseHosts(strings.NewReader(in))
	for _, want := range []string{"ads.example.com", "tracker.net", "plain-domain.org"} {
		if _, ok := set[want]; !ok {
			t.Errorf("missing %s", want)
		}
	}
	if len(set) != 3 {
		t.Errorf("unexpected entries: %v", set)
	}
}

func query(t *testing.T, name string, typ dnsmessage.Type) []byte {
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: 0xbeef, RecursionDesired: true})
	_ = b.StartQuestions()
	_ = b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET})
	msg, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return msg
}

func TestHandleBlocksForwardsAndCounts(t *testing.T) {
	s := NewServer(NewLists(), nil)
	s.Now = func() time.Time { return at(time.Tuesday, "12:00") }
	var forwarded []string
	s.Forwarder = func(_ context.Context, up string, msg []byte, _ bool) ([]byte, error) {
		forwarded = append(forwarded, up)
		if up == "10.9.9.9" {
			return nil, errors.New("down")
		}
		var p dnsmessage.Parser
		h, _ := p.Start(msg)
		q, _ := p.Question()
		h.Response = true
		b := dnsmessage.NewBuilder(nil, h)
		_ = b.StartQuestions()
		_ = b.Question(q)
		_ = b.StartAnswers()
		_ = b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 30}, dnsmessage.AResource{A: [4]byte{93, 184, 216, 34}})
		return b.Finish()
	}
	s.MACOf = func(ip string) string {
		if ip == "192.168.1.50" {
			return "AA:BB:CC:00:00:01"
		}
		return ""
	}
	s.SetPolicy(Policy{
		Enabled:   true,
		Upstreams: []string{"10.9.9.9", "192.168.1.1"},
		Default:   Rule{},
		Clients:   []Client{{MAC: "aa:bb:cc:00:00:01", Rule: Rule{Categories: []string{"games"}}}, {IP: "192.168.1.60", Rule: Rule{Blocked: []string{"example.com"}}}},
	})

	answer := func(ip, name string, typ dnsmessage.Type) (dnsmessage.Header, []dnsmessage.Resource) {
		resp := s.Handle(context.Background(), ip, query(t, name, typ), false)
		var p dnsmessage.Parser
		h, err := p.Start(resp)
		if err != nil {
			t.Fatal(err)
		}
		_ = p.SkipAllQuestions()
		rs, _ := p.AllAnswers()
		return h, rs
	}

	h, rs := answer("192.168.1.50", "www.roblox.com.", dnsmessage.TypeA)
	if h.ID != 0xbeef || len(rs) != 1 || rs[0].Body.(*dnsmessage.AResource).A != [4]byte{} {
		t.Fatalf("roblox should be answered 0.0.0.0 for the gamer, got %v %v", h, rs)
	}
	if len(forwarded) != 0 {
		t.Fatal("a blocked name must not be forwarded")
	}
	h, rs = answer("192.168.1.50", "roblox.com.", dnsmessage.TypeAAAA)
	if len(rs) != 1 || rs[0].Body.(*dnsmessage.AAAAResource).AAAA != [16]byte{} {
		t.Fatalf("AAAA should be ::, got %v", rs)
	}
	h, _ = answer("192.168.1.50", "roblox.com.", dnsmessage.TypeMX)
	if h.RCode != dnsmessage.RCodeNameError {
		t.Fatalf("other types should be NXDOMAIN, got %v", h.RCode)
	}
	hCanary, rsCanary := answer("192.168.1.51", "use-application-dns.net.", dnsmessage.TypeA)
	if hCanary.RCode != dnsmessage.RCodeNameError || len(rsCanary) != 0 {
		t.Fatalf("encrypted_dns canary should return NXDOMAIN with no answers, got %v %v", hCanary.RCode, rsCanary)
	}
	_, rs = answer("192.168.1.51", "www.roblox.com.", dnsmessage.TypeA) // another device: default rule
	if len(rs) != 1 || rs[0].Body.(*dnsmessage.AResource).A != [4]byte{93, 184, 216, 34} {
		t.Fatalf("other devices should be forwarded, got %v", rs)
	}
	if strings.Join(forwarded, ",") != "10.9.9.9,192.168.1.1" {
		t.Fatalf("should fall through to the next upstream, got %v", forwarded)
	}
	_, rs = answer("192.168.1.60", "a.example.com.", dnsmessage.TypeA) // matched by IP
	if rs[0].Body.(*dnsmessage.AResource).A != [4]byte{} {
		t.Fatal("rule matched by IP should block")
	}

	_, _, st := s.TakeStats(10)
	if len(st) != 3 || st[0].IP != "192.168.1.50" || st[0].MAC != "aa:bb:cc:00:00:01" || st[0].Queries != 3 || st[0].Blocked != 3 ||
		st[0].Top[0].Domain != "roblox.com" || st[0].Top[0].Category != "games" {
		t.Fatalf("unexpected stats: %+v", st)
	}
	if _, _, again := s.TakeStats(10); len(again) != 0 {
		t.Fatal("stats should reset after TakeStats")
	}
}

func TestAllServersFailGivesServfail(t *testing.T) {
	s := NewServer(NewLists(), nil)
	s.Forwarder = func(context.Context, string, []byte, bool) ([]byte, error) { return nil, errors.New("down") }
	s.SetPolicy(Policy{Enabled: true, Upstreams: []string{"10.0.0.1"}})
	resp := s.Handle(context.Background(), "192.168.1.5", query(t, "example.com.", dnsmessage.TypeA), false)
	var p dnsmessage.Parser
	if h, _ := p.Start(resp); h.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("want SERVFAIL, got %v", h.RCode)
	}
}

func TestOnlyLocalClients(t *testing.T) {
	for ip, want := range map[string]bool{"192.168.1.5": true, "10.1.2.3": true, "127.0.0.1": true, "fe80::1": true, "8.8.8.8": false, "100.64.0.1": false} {
		if allowedClient(ip) != want {
			t.Errorf("%s: want %v", ip, want)
		}
	}
}

// End-to-end over a real UDP socket on loopback.
func TestListenUDP(t *testing.T) {
	s := NewServer(NewLists(), nil)
	s.SetPolicy(Policy{Enabled: true, Default: Rule{Blocked: []string{"blocked.test"}}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pc, _ := net.ListenPacket("udp", "127.0.0.1:0")
	addr := pc.LocalAddr().String()
	pc.Close()
	if err := s.Listen(ctx, addr); err != nil {
		t.Skip("cannot bind loopback UDP:", err)
	}
	conn, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Write(query(t, "x.blocked.test.", dnsmessage.TypeA))
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	var p dnsmessage.Parser
	h, _ := p.Start(buf[:n])
	_ = p.SkipAllQuestions()
	rs, _ := p.AllAnswers()
	if h.ID != 0xbeef || len(rs) != 1 {
		t.Fatalf("unexpected answer %v %v", h, rs)
	}
}

// Schedules are evaluated on the site's wall clock, not the collector host's.
func TestScheduleUsesSiteTimezone(t *testing.T) {
	blockedFor := func(s *Server) bool {
		resp := s.Handle(context.Background(), "192.168.1.5", query(t, "example.com.", dnsmessage.TypeA), false)
		var p dnsmessage.Parser
		_, _ = p.Start(resp)
		_ = p.SkipAllQuestions()
		rs, _ := p.AllAnswers()
		return len(rs) == 1 && rs[0].Body.(*dnsmessage.AResource).A == [4]byte{}
	}
	newServer := func(tz string, now time.Time) *Server {
		s := NewServer(NewLists(), nil)
		s.Forwarder = func(_ context.Context, _ string, msg []byte, _ bool) ([]byte, error) {
			var p dnsmessage.Parser
			h, _ := p.Start(msg)
			q, _ := p.Question()
			h.Response = true
			b := dnsmessage.NewBuilder(nil, h)
			_ = b.StartQuestions()
			_ = b.Question(q)
			_ = b.StartAnswers()
			_ = b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 30}, dnsmessage.AResource{A: [4]byte{1, 2, 3, 4}})
			return b.Finish()
		}
		s.Now = func() time.Time { return now }
		// Tuesday 22:00–23:30 bedtime.
		s.SetPolicy(Policy{Enabled: true, Upstreams: []string{"10.0.0.1"}, Timezone: tz,
			Default: Rule{Schedule: []Window{{Days: []int{2}, From: "22:00", To: "23:30"}}}})
		return s
	}
	// 2026-11-10 is a Tuesday. 14:00 UTC is 23:00 in Tokyo (UTC+9, no DST).
	utc := time.Date(2026, 11, 10, 14, 0, 0, 0, time.UTC)
	tokyo := newServer("Asia/Tokyo", utc)
	if !blockedFor(tokyo) {
		t.Fatal("23:00 Tuesday in Tokyo is inside the bedtime window")
	}
	if name, ok := tokyo.TimezoneStatus(); name != "Asia/Tokyo" || !ok {
		t.Fatalf("timezone status %q %v", name, ok)
	}
	// 14:00 UTC is 06:00 in Los Angeles (UTC-8 in November): outside the window.
	if blockedFor(newServer("America/Los_Angeles", utc)) {
		t.Fatal("06:00 Tuesday in Los Angeles is outside the window")
	}
	// Same instant, same rule, but the moment is 23:00 Tokyo; evaluated as UTC (14:00) it would not block.
	if blockedFor(newServer("UTC", utc)) {
		t.Fatal("14:00 UTC is outside the window")
	}
	// An unloadable zone falls back to host-local time and is reported, never panics.
	bad := newServer("Mars/Olympus_Mons", utc)
	if name, ok := bad.TimezoneStatus(); ok || name != time.Local.String() {
		t.Fatalf("bad zone: %q %v", name, ok)
	}
	want := (Window{Days: []int{2}, From: "22:00", To: "23:30"}).Active(utc.In(time.Local))
	if blockedFor(bad) != want {
		t.Fatal("bad zone must evaluate in host-local time")
	}
	// Absent: host-local time, as before.
	if loc, ok := (Policy{}).Location(); loc != time.Local || !ok {
		t.Fatal("empty timezone must mean host-local time")
	}
}
