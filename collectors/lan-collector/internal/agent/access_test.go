package agent

import (
	"context"
	"reflect"
	"testing"

	"github.com/nigafiy/sensor/internal/dnsfilter"
)

// A local address of this host (the loopback address is always one of them).
func someLocalAddr(t *testing.T) string {
	t.Helper()
	local := localAddrs()
	if local["127.0.0.1"] {
		return "127.0.0.1"
	}
	for a := range local {
		return a
	}
	t.Skip("this host reports no interface addresses")
	return ""
}

// The resolver must never forward to itself: a router that hands out this host as the network's DNS
// server (or a cloud policy naming it) would otherwise make every query loop until it times out.
func TestUpstreamsNeverThisHost(t *testing.T) {
	self := someLocalAddr(t)

	t.Run("router is this host: skipped, public fallbacks kept", func(t *testing.T) {
		a := &Agent{deps: Deps{Gateway: func(context.Context) string { return self }}}
		got := a.upstreams(context.Background(), dnsfilter.Policy{})
		if !reflect.DeepEqual(got, fallbackUpstreams) {
			t.Fatalf("want only the fallbacks %v, got %v", fallbackUpstreams, got)
		}
	})

	t.Run("router first, then the fallbacks", func(t *testing.T) {
		a := &Agent{deps: Deps{Gateway: func(context.Context) string { return "192.0.2.1" }}}
		got := a.upstreams(context.Background(), dnsfilter.Policy{})
		want := append([]string{"192.0.2.1"}, fallbackUpstreams...)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("want %v, got %v", want, got)
		}
	})

	t.Run("no router known", func(t *testing.T) {
		a := &Agent{deps: Deps{Gateway: func(context.Context) string { return "" }}}
		if got := a.upstreams(context.Background(), dnsfilter.Policy{}); !reflect.DeepEqual(got, fallbackUpstreams) {
			t.Fatalf("want %v, got %v", fallbackUpstreams, got)
		}
	})

	t.Run("cloud list: own addresses and non-addresses dropped, order kept, no fallbacks added", func(t *testing.T) {
		gatewayAsked := false
		a := &Agent{deps: Deps{Gateway: func(context.Context) string { gatewayAsked = true; return "192.0.2.1" }}}
		p := dnsfilter.Policy{Upstreams: []string{"198.51.100.7", self, "dns.example", "", "203.0.113.9:53", "203.0.113.9"}}
		got := a.upstreams(context.Background(), p)
		want := []string{"198.51.100.7", "203.0.113.9"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("want %v, got %v", want, got)
		}
		if gatewayAsked {
			t.Fatal("the router must not be consulted when the cloud names the upstreams")
		}
	})

	t.Run("cloud names only this host: nothing to forward to", func(t *testing.T) {
		a := &Agent{deps: Deps{Gateway: func(context.Context) string { return "192.0.2.1" }}}
		got := a.upstreams(context.Background(), dnsfilter.Policy{Upstreams: []string{self}})
		if len(got) != 0 {
			t.Fatalf("want no upstream (queries fail with SERVFAIL instead of looping), got %v", got)
		}
	})
}
