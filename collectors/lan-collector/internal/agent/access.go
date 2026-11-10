package agent

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lan-detective/lan-collector/internal/dnsfilter"
)

const (
	accessTick       = 5 * time.Second
	dnsStatsInterval = 5 * time.Minute
	dnsStatsTopN     = 25
)

// fallbackUpstreams are used after the router when the cloud names none.
var fallbackUpstreams = []string{"1.1.1.1", "8.8.8.8"}

// AccessStatus is reported in every heartbeat so the owner can see whether filtering is working.
type AccessStatus struct {
	Enabled   bool           `json:"enabled"`
	Listening bool           `json:"listening"`
	Listen    string         `json:"listen,omitempty"`
	Error     string         `json:"error,omitempty"`
	Upstreams []string       `json:"upstreams,omitempty"`
	Lists     map[string]int `json:"lists,omitempty"`
	ListError string         `json:"list_error,omitempty"`
}

type accessState struct {
	mu        sync.Mutex
	server    *dnsfilter.Server
	lists     *dnsfilter.Lists
	stop      context.CancelFunc
	status    AccessStatus
	lastErrAt time.Time
	macs      map[string]string
	macsAt    time.Time
	fetching  bool
}

func (a *Agent) accessStatus() *AccessStatus {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	if !a.access.status.Enabled && a.access.status.Error == "" {
		return nil
	}
	s := a.access.status
	s.Lists = a.access.lists.Counts()
	return &s
}

// macOf maps a client IP to its MAC using the host's neighbour table (refreshed at most every 30 s).
func (a *Agent) macOf(ip string) string {
	a.access.mu.Lock()
	stale := time.Since(a.access.macsAt) > 30*time.Second
	if stale {
		a.access.macsAt = time.Now()
	}
	a.access.mu.Unlock()
	if stale && a.deps.Neighbors != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n, err := a.deps.Neighbors(ctx)
		cancel()
		if err == nil {
			m := make(map[string]string, len(n))
			for ip, nb := range n {
				m[ip] = strings.ToLower(nb.MAC)
			}
			a.access.mu.Lock()
			a.access.macs = m
			a.access.mu.Unlock()
		}
	}
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	return a.access.macs[ip]
}

func localAddrs() map[string]bool {
	out := map[string]bool{}
	addrs, _ := net.InterfaceAddrs()
	for _, ad := range addrs {
		if p, err := netip.ParsePrefix(ad.String()); err == nil {
			out[p.Addr().String()] = true
		}
	}
	return out
}

// upstreams: the cloud's list, else the router then public resolvers. Never this host itself — a
// router handing out this host as DNS and this host forwarding to itself would loop.
func (a *Agent) upstreams(ctx context.Context, p dnsfilter.Policy) []string {
	list := p.Upstreams
	if len(list) == 0 {
		if gw := a.deps.Gateway(ctx); gw != "" {
			list = append(list, gw)
		}
		list = append(list, fallbackUpstreams...)
	}
	local := localAddrs()
	out := []string{}
	for _, u := range list {
		if _, err := netip.ParseAddr(u); err == nil && !local[u] {
			out = append(out, u)
		}
	}
	return out
}

func (a *Agent) accessLoop(ctx context.Context) {
	if a.deps.DNSListen == "" {
		return
	}
	a.access.server.MACOf = a.macOf
	tick := time.NewTicker(accessTick)
	defer tick.Stop()
	statsAt := time.Now()
	for {
		a.applyAccess(ctx)
		if time.Since(statsAt) >= dnsStatsInterval {
			statsAt = time.Now()
			a.flushDNSStats()
		}
		select {
		case <-ctx.Done():
			a.flushDNSStats()
			return
		case <-tick.C:
		}
	}
}

func (a *Agent) applyAccess(ctx context.Context) {
	var p dnsfilter.Policy
	if rc := a.remoteConfig(); rc != nil && len(rc.Access) > 0 {
		if err := json.Unmarshal(rc.Access, &p); err != nil {
			a.log.Warn("ignoring an unreadable access policy from the cloud")
			p = dnsfilter.Policy{}
		}
	}
	// Unknown categories are dropped rather than guessed at.
	clean := func(r *dnsfilter.Rule) {
		keep := r.Categories[:0]
		for _, c := range r.Categories {
			if dnsfilter.Known(c) {
				keep = append(keep, c)
			}
		}
		r.Categories = keep
	}
	clean(&p.Default)
	for i := range p.Clients {
		clean(&p.Clients[i].Rule)
	}
	p.Upstreams = a.upstreams(ctx, p)

	st := &a.access
	st.mu.Lock()
	st.status.Enabled = p.Enabled
	st.status.Upstreams = p.Upstreams
	running := st.stop != nil
	st.mu.Unlock()

	st.server.SetPolicy(p)
	switch {
	case p.Enabled && !running:
		lctx, cancel := context.WithCancel(ctx)
		if err := st.server.Listen(lctx, a.deps.DNSListen); err != nil {
			cancel()
			st.mu.Lock()
			st.status.Listening, st.status.Error = false, "cannot listen on the DNS port: "+err.Error()
			logIt := time.Since(st.lastErrAt) > 10*time.Minute
			if logIt {
				st.lastErrAt = time.Now()
			}
			st.mu.Unlock()
			if logIt {
				a.log.Warn("network access control is on but the DNS port is not available (another DNS server running? on Linux it needs CAP_NET_BIND_SERVICE; on Windows an inbound firewall rule for UDP/TCP 53)", "error", err.Error())
			}
			return
		}
		st.mu.Lock()
		st.stop, st.status.Listening, st.status.Error, st.status.Listen = cancel, true, "", a.deps.DNSListen
		st.mu.Unlock()
		a.log.Info("network access control is on: answering DNS for the local network", "listen", a.deps.DNSListen, "upstreams", strings.Join(p.Upstreams, ","))
	case !p.Enabled && running:
		st.mu.Lock()
		st.stop()
		st.stop, st.status.Listening = nil, false
		st.mu.Unlock()
		a.flushDNSStats()
		a.log.Info("network access control is off: stopped answering DNS")
	}
	if p.Enabled {
		a.fetchLists(ctx, p)
	}
}

// fetchLists downloads (daily) the large category lists that any rule uses, in the background.
func (a *Agent) fetchLists(ctx context.Context, p dnsfilter.Policy) {
	used := map[string]bool{}
	for _, c := range p.Default.Categories {
		used[c] = true
	}
	for _, cl := range p.Clients {
		for _, c := range cl.Rule.Categories {
			used[c] = true
		}
	}
	cats := make([]string, 0, len(used))
	for c := range used {
		cats = append(cats, c)
	}
	sort.Strings(cats)
	st := &a.access
	st.mu.Lock()
	if st.fetching || len(cats) == 0 {
		st.mu.Unlock()
		return
	}
	st.fetching = true
	st.mu.Unlock()
	go func() {
		errs := st.lists.Ensure(ctx, filepath.Join(a.cfg.StateDir, "lists"), cats, &http.Client{Timeout: 90 * time.Second})
		st.mu.Lock()
		st.fetching = false
		st.status.ListError = ""
		if len(errs) > 0 {
			st.status.ListError = errs[0].Error()
		}
		st.mu.Unlock()
	}()
}

func (a *Agent) flushDNSStats() {
	since, until, clients := a.access.server.TakeStats(dnsStatsTopN)
	if len(clients) == 0 {
		return
	}
	a.enqueue(map[string]any{"type": "dns_stats", "ts": until.UTC(), "window_start": since.UTC(), "clients": clients})
	a.wakeUploader()
}
