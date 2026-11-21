package smart

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	_, p, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(p)
	return n
}

func TestBannerProbeOnlyInsideAllowedScopes(t *testing.T) {
	var hits atomic.Int32
	var paths, methods []string
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		paths, methods = append(paths, r.URL.Path), append(methods, r.Method)
		w.Header().Set("Server", "lighttpd/1.4.59")
		// A long, multi-line title with an entity and a control character.
		_, _ = w.Write([]byte("<html><head><TITLE lang=en>\n  Router &amp; Gateway\x07 " + strings.Repeat("x", 300) + "</title></head></html>"))
	}))
	defer plain.Close()
	var tlsHits atomic.Int32
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tlsHits.Add(1)
		// A redirect is reported as it is, never followed.
		http.Redirect(w, r, "/login.html", http.StatusFound)
	}))
	defer secure.Close()

	loop := netip.MustParseAddr("127.0.0.1")
	outside := netip.MustParseAddr("127.0.0.2") // listening addresses on 127.0.0.0/8, but not authorized
	allowed := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	pPlain, pTLS := portOf(t, plain), portOf(t, secure)

	start := time.Now()
	rep := ProbeBannersWith(context.Background(), []netip.Addr{outside, loop, loop, netip.MustParseAddr("::1")},
		[]int{pPlain, pTLS, 0, 70000}, allowed, BannerOptions{HTTPSPorts: []int{pTLS}, Timeout: 3 * time.Second})
	if time.Since(start) > 10*time.Second {
		t.Fatal("the probe did not respect its timeout")
	}

	if len(rep.Probed) != 1 || rep.Probed[0] != "127.0.0.1" {
		t.Fatalf("probed %v: only the authorized IPv4 target, once", rep.Probed)
	}
	if hits.Load() != 1 || tlsHits.Load() != 1 {
		t.Fatalf("one GET per port: plain %d, tls %d", hits.Load(), tlsHits.Load())
	}
	if paths[0] != "/" || methods[0] != http.MethodGet {
		t.Fatalf("request %s %s", methods[0], paths[0])
	}
	if len(rep.Results) != 2 {
		t.Fatalf("results %+v", rep.Results)
	}
	byPort := map[int]Banner{}
	for _, b := range rep.Results {
		if b.IP != "127.0.0.1" {
			t.Errorf("result for %s", b.IP)
		}
		byPort[b.Port] = b
	}
	h := byPort[pPlain]
	if h.Scheme != "http" || h.Status != 200 || h.Server != "lighttpd/1.4.59" || !strings.HasPrefix(h.Title, "Router & Gateway xxx") ||
		len(h.Title) > 120 || strings.ContainsRune(h.Title, 7) || h.TLSSelfSigned != nil {
		t.Errorf("plain banner %+v (title %d bytes)", h, len(h.Title))
	}
	s := byPort[pTLS]
	if s.Scheme != "https" || s.Status != http.StatusFound || s.TLSSubject == "" || s.TLSIssuer == "" || s.TLSSelfSigned == nil || !*s.TLSSelfSigned {
		t.Errorf("tls banner %+v", s)
	}
	if strings.Contains(s.TLSSubject, "\n") {
		t.Errorf("control characters in subject %q", s.TLSSubject)
	}
}

func TestBannerProbeNothingAnswering(t *testing.T) {
	// A port nobody listens on: the address is recorded as probed, with no result.
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	rep := ProbeBannersWith(context.Background(), []netip.Addr{netip.MustParseAddr("127.0.0.1")}, []int{port},
		[]netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, BannerOptions{Timeout: time.Second})
	if len(rep.Probed) != 1 || len(rep.Results) != 0 || rep.Results == nil {
		t.Fatalf("got %+v", rep)
	}
	// No target in scope: nothing probed, empty lists (not null).
	rep = ProbeBanners(context.Background(), []netip.Addr{netip.MustParseAddr("192.0.2.1")}, []int{80}, nil)
	if rep.Probed == nil || len(rep.Probed) != 0 || rep.Results == nil {
		t.Fatalf("got %+v", rep)
	}
}

func TestPageTitle(t *testing.T) {
	for in, want := range map[string]string{
		"<title>Login</title>":                          "Login",
		"<head><title></title></head>":                  "",
		"no title here":                                 "",
		"<TITLE>  Zyxel\r\n\tVMG &#8211; Home </TITLE>": "Zyxel VMG – Home",
	} {
		if got := PageTitle([]byte(in)); got != want {
			t.Errorf("PageTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
