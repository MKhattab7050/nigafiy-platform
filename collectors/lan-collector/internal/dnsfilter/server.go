package dnsfilter

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const (
	upstreamTimeout = 3 * time.Second
	maxStatClients  = 512
	maxStatDomains  = 400 // per client per window; protects memory against random-subdomain floods
	blockedTTL      = 60
)

type domStat struct {
	count    int
	blocked  int
	reason   string
	category string
}

type clientStat struct {
	mac     string
	queries int
	blocked int
	domains map[string]*domStat
}

// Server is the filtering DNS resolver.
type Server struct {
	Lists     *Lists
	MACOf     func(ip string) string // neighbour-table lookup; may be nil
	Log       *slog.Logger
	Now       func() time.Time
	Forwarder func(ctx context.Context, upstream string, msg []byte, tcp bool) ([]byte, error)

	mu     sync.RWMutex
	policy Policy
	loc    *time.Location
	tzOK   bool
	byMAC  map[string]Rule
	byIP   map[string]Rule

	smu   sync.Mutex
	stats map[string]*clientStat
	since time.Time
}

func NewServer(lists *Lists, log *slog.Logger) *Server {
	return &Server{Lists: lists, Log: log, Now: time.Now, Forwarder: forward, stats: map[string]*clientStat{}, since: time.Now()}
}

func (s *Server) SetPolicy(p Policy) {
	byMAC, byIP := map[string]Rule{}, map[string]Rule{}
	for _, c := range p.Clients {
		if c.MAC != "" {
			byMAC[strings.ToLower(c.MAC)] = c.Rule
		}
		if c.IP != "" {
			byIP[c.IP] = c.Rule
		}
	}
	loc, ok := p.Location()
	s.mu.Lock()
	s.policy, s.byMAC, s.byIP, s.loc, s.tzOK = p, byMAC, byIP, loc, ok
	s.mu.Unlock()
}

// TimezoneStatus reports the zone schedules are evaluated in and whether the configured zone
// could be loaded (false: it fell back to host-local time).
func (s *Server) TimezoneStatus() (name string, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.loc == nil {
		return time.Local.String(), true
	}
	return s.loc.String(), s.tzOK
}

// now is the current time in the site's zone, so schedule windows ("22:00–07:00") mean the
// site's wall clock even when the collector host runs in another zone (or UTC).
func (s *Server) now() time.Time {
	s.mu.RLock()
	loc := s.loc
	s.mu.RUnlock()
	t := s.Now()
	if loc != nil {
		t = t.In(loc)
	}
	return t
}

func (s *Server) ruleFor(ip string) (Rule, string, []string) {
	mac := ""
	if s.MACOf != nil {
		mac = strings.ToLower(s.MACOf(ip))
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	ups := s.policy.Upstreams
	if r, ok := s.byMAC[mac]; ok && mac != "" {
		return r, mac, ups
	}
	if r, ok := s.byIP[ip]; ok {
		return r, mac, ups
	}
	return s.policy.Default, mac, ups
}

// Handle answers one DNS message from client ip. It never returns nil for a parsable question.
func (s *Server) Handle(ctx context.Context, ip string, msg []byte, tcp bool) []byte {
	var p dnsmessage.Parser
	hdr, err := p.Start(msg)
	if err != nil || hdr.Response {
		return nil
	}
	q, err := p.Question()
	if err != nil {
		return nil
	}
	name := Normalize(q.Name.String())
	rule, mac, ups := s.ruleFor(ip)
	d := Decide(rule, name, s.now(), s.Lists)
	s.record(ip, mac, name, d)
	if d.Blocked {
		if d.Reason == alwaysCategory {
			return errorAnswer(hdr, q, dnsmessage.RCodeNameError)
		}
		return blockedAnswer(hdr, q)
	}
	for _, up := range ups {
		resp, err := s.Forwarder(ctx, up, msg, tcp)
		if err == nil {
			return resp
		}
	}
	return errorAnswer(hdr, q, dnsmessage.RCodeServerFailure)
}

func blockedAnswer(hdr dnsmessage.Header, q dnsmessage.Question) []byte {
	h := dnsmessage.Header{ID: hdr.ID, Response: true, RecursionDesired: hdr.RecursionDesired, RecursionAvailable: true}
	if q.Type != dnsmessage.TypeA && q.Type != dnsmessage.TypeAAAA {
		h.RCode = dnsmessage.RCodeNameError
	}
	b := dnsmessage.NewBuilder(nil, h)
	b.EnableCompression()
	_ = b.StartQuestions()
	_ = b.Question(q)
	_ = b.StartAnswers()
	rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: blockedTTL}
	switch q.Type {
	case dnsmessage.TypeA:
		_ = b.AResource(rh, dnsmessage.AResource{})
	case dnsmessage.TypeAAAA:
		_ = b.AAAAResource(rh, dnsmessage.AAAAResource{})
	}
	out, _ := b.Finish()
	return out
}

func errorAnswer(hdr dnsmessage.Header, q dnsmessage.Question, code dnsmessage.RCode) []byte {
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: hdr.ID, Response: true, RecursionDesired: hdr.RecursionDesired, RecursionAvailable: true, RCode: code})
	_ = b.StartQuestions()
	_ = b.Question(q)
	out, _ := b.Finish()
	return out
}

func (s *Server) record(ip, mac, name string, d Decision) {
	s.smu.Lock()
	defer s.smu.Unlock()
	c := s.stats[ip]
	if c == nil {
		if len(s.stats) >= maxStatClients {
			return
		}
		c = &clientStat{domains: map[string]*domStat{}}
		s.stats[ip] = c
	}
	if mac != "" {
		c.mac = mac
	}
	c.queries++
	if d.Blocked {
		c.blocked++
	}
	key := strings.TrimPrefix(name, "www.")
	ds := c.domains[key]
	if ds == nil {
		if len(c.domains) >= maxStatDomains {
			return
		}
		ds = &domStat{}
		c.domains[key] = ds
	}
	ds.count++
	if d.Blocked {
		ds.blocked++
		ds.reason, ds.category = d.Reason, d.Category
	}
}

// DomainStat and ClientStats are the per-window summary sent to the cloud.
type DomainStat struct {
	Domain   string `json:"domain"`
	Count    int    `json:"count"`
	Blocked  int    `json:"blocked"`
	Reason   string `json:"reason,omitempty"`
	Category string `json:"category,omitempty"`
}

type ClientStats struct {
	IP      string       `json:"ip"`
	MAC     string       `json:"mac,omitempty"`
	Queries int          `json:"queries"`
	Blocked int          `json:"blocked"`
	Top     []DomainStat `json:"top_domains"`
}

// TakeStats returns the counters gathered since the last call (top N domains per client, blocked
// ones first) and starts a new window.
func (s *Server) TakeStats(topN int) (time.Time, time.Time, []ClientStats) {
	s.smu.Lock()
	stats, since := s.stats, s.since
	s.stats, s.since = map[string]*clientStat{}, s.Now()
	s.smu.Unlock()
	out := make([]ClientStats, 0, len(stats))
	for ip, c := range stats {
		list := make([]DomainStat, 0, len(c.domains))
		for d, st := range c.domains {
			list = append(list, DomainStat{Domain: d, Count: st.count, Blocked: st.blocked, Reason: st.reason, Category: st.category})
		}
		sort.Slice(list, func(i, j int) bool {
			if (list[i].Blocked > 0) != (list[j].Blocked > 0) {
				return list[i].Blocked > 0
			}
			if list[i].Count != list[j].Count {
				return list[i].Count > list[j].Count
			}
			return list[i].Domain < list[j].Domain
		})
		if len(list) > topN {
			list = list[:topN]
		}
		out = append(out, ClientStats{IP: ip, MAC: c.mac, Queries: c.queries, Blocked: c.blocked, Top: list})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	return since, s.Now(), out
}

// ── transport ───────────────────────────────────────────────────────────────

func forward(ctx context.Context, upstream string, msg []byte, tcp bool) ([]byte, error) {
	network := "udp"
	if tcp {
		network = "tcp"
	}
	d := net.Dialer{Timeout: upstreamTimeout}
	conn, err := d.DialContext(ctx, network, net.JoinHostPort(upstream, "53"))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(upstreamTimeout))
	if tcp {
		if err := writeTCP(conn, msg); err != nil {
			return nil, err
		}
		resp, err := readTCP(conn)
		if err != nil {
			return nil, err
		}
		return checkID(msg, resp)
	}
	if _, err := conn.Write(msg); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return nil, err
		}
		if resp, err := checkID(msg, buf[:n]); err == nil {
			return append([]byte(nil), resp...), nil
		}
	}
}

func checkID(q, resp []byte) ([]byte, error) {
	if len(resp) < 12 || len(q) < 2 || resp[0] != q[0] || resp[1] != q[1] || resp[2]&0x80 == 0 {
		return nil, errors.New("mismatched answer")
	}
	return resp, nil
}

func writeTCP(w io.Writer, msg []byte) error {
	buf := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(buf, uint16(len(msg)))
	copy(buf[2:], msg)
	_, err := w.Write(buf)
	return err
}

func readTCP(r io.Reader) ([]byte, error) {
	var l [2]byte
	if _, err := io.ReadFull(r, l[:]); err != nil {
		return nil, err
	}
	msg := make([]byte, binary.BigEndian.Uint16(l[:]))
	_, err := io.ReadFull(r, msg)
	return msg, err
}

// allowedClient keeps the resolver from becoming an open resolver: only private, link-local and
// loopback addresses (the local network) are answered.
func allowedClient(ip string) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast()
}

// Listen serves DNS on addr (UDP and TCP) until ctx ends. It returns once both sockets are bound,
// or with the bind error.
func (s *Server) Listen(ctx context.Context, addr string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		_ = pc.Close()
		return err
	}
	context.AfterFunc(ctx, func() {
		_ = pc.Close()
		_ = ln.Close()
	})
	go s.serveUDP(ctx, pc)
	go s.serveTCP(ctx, ln)
	return nil
}

func (s *Server) serveUDP(ctx context.Context, pc net.PacketConn) {
	defer pc.Close()
	sem := make(chan struct{}, 128)
	for {
		buf := make([]byte, 4096)
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			continue
		}
		host, _, _ := net.SplitHostPort(from.String())
		if !allowedClient(host) {
			continue
		}
		select {
		case sem <- struct{}{}:
		default:
			continue // overloaded: drop, the client retries
		}
		go func(msg []byte) {
			defer func() { <-sem }()
			if resp := s.Handle(ctx, host, msg, false); resp != nil {
				_, _ = pc.WriteTo(resp, from)
			}
		}(buf[:n])
	}
}

func (s *Server) serveTCP(ctx context.Context, ln net.Listener) {
	defer ln.Close()
	sem := make(chan struct{}, 64)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			continue
		}
		select {
		case sem <- struct{}{}:
		default:
			_ = conn.Close()
			continue
		}
		go func() {
			defer func() {
				<-sem
				_ = conn.Close()
			}()
			host, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
			if !allowedClient(host) {
				return
			}
			for i := 0; i < 16; i++ {
				_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
				msg, err := readTCP(conn)
				if err != nil {
					return
				}
				resp := s.Handle(ctx, host, msg, true)
				if resp == nil || writeTCP(conn, resp) != nil {
					return
				}
			}
		}()
	}
}
