package discovery

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/netinfo"
)

// fakeProber simulates a network: only addresses in `alive` answer.
type fakeProber struct {
	alive    map[string]bool
	delay    time.Duration
	mu       sync.Mutex
	probed   []string
	inFlight int32
	maxSeen  int32
}

func (f *fakeProber) Ping(_ context.Context, ip string, _ time.Duration) (time.Duration, bool) {
	n := atomic.AddInt32(&f.inFlight, 1)
	for {
		m := atomic.LoadInt32(&f.maxSeen)
		if n <= m || atomic.CompareAndSwapInt32(&f.maxSeen, m, n) {
			break
		}
	}
	time.Sleep(f.delay)
	atomic.AddInt32(&f.inFlight, -1)
	f.mu.Lock()
	f.probed = append(f.probed, ip)
	f.mu.Unlock()
	return 2 * time.Millisecond, f.alive[ip]
}

func TestSweepFindsHostsAndMergesNeighbourTable(t *testing.T) {
	// .9 answers ping only because it is an address on our own disconnected adapter.
	prober := &fakeProber{alive: map[string]bool{"192.168.1.1": true, "192.168.1.9": true, "192.168.1.10": true}}
	prefix := netip.MustParsePrefix("192.168.1.0/28")
	res := Sweep(context.Background(), prefix, prober, Options{
		Concurrency: 8, PPS: 500, Timeout: time.Second,
		Neighbors: func(context.Context) (map[string]netinfo.Neighbor, error) {
			return map[string]netinfo.Neighbor{
				"192.168.1.1":  {MAC: "00:11:22:33:44:55", Reachable: true},
				"192.168.1.5":  {MAC: "aa:bb:cc:00:00:05", Reachable: true},  // drops ICMP, answers ARP
				"192.168.1.6":  {MAC: "aa:bb:cc:00:00:06", Reachable: false}, // stale entry: gone
				"192.168.9.9":  {MAC: "aa:bb:cc:00:00:99", Reachable: true},  // other subnet
				"192.168.1.10": {MAC: "aa:bb:cc:00:00:10", Reachable: false}, // answered ICMP; stale MAC still usable
			}, nil
		},
		LocalDown: func() []string { return []string{"192.168.1.9"} },
		DHCPName: func(mac string) (string, string, bool) {
			if mac == "aa:bb:cc:00:00:05" {
				return "Galaxy-A52", "android-dhcp-14", true
			}
			return "", "", false
		},
		LocalMACs: func() map[string]string {
			return map[string]string{"192.168.1.10": "aa:bb:cc:00:00:10", "192.168.1.12": "aa:bb:cc:00:00:12", "10.0.0.1": "aa:bb:cc:00:00:99"}
		},
		ReverseName: func(_ context.Context, ip string) string {
			if ip == "192.168.1.1" {
				return "gw.lan"
			}
			return ""
		},
	})
	if !res.Complete || res.HostsProbed != 14 {
		t.Fatalf("complete=%v probed=%d, want true/14", res.Complete, res.HostsProbed)
	}
	if len(res.Hosts) != 4 {
		t.Fatalf("expected 4 hosts, got %+v", res.Hosts)
	}
	// The collector host's own second address did not answer ICMP in this fake network, but it is
	// present by definition and carries the MAC of its own interface.
	if own := res.Hosts[3]; own.IP != "192.168.1.12" || own.MAC != "aa:bb:cc:00:00:12" || own.Sources[0] != "local_interface" {
		t.Errorf("own interface wrong: %+v", own)
	}
	gw, silent, pc := res.Hosts[0], res.Hosts[1], res.Hosts[2]
	if gw.IP != "192.168.1.1" || gw.MAC != "00:11:22:33:44:55" || gw.Hostname != "gw.lan" || len(gw.Sources) != 3 {
		t.Errorf("gateway wrong: %+v", gw)
	}
	if len(silent.Names) != 1 || silent.Names[0].Source != "dhcp" || silent.Names[0].Name != "Galaxy-A52" || silent.Hints["dhcp_vendor_class"] != "android-dhcp-14" {
		t.Errorf("DHCP name not attached: %+v", silent)
	}
	if silent.IP != "192.168.1.5" || len(silent.Sources) != 2 || silent.Sources[0] != "arp_cache" || silent.RTTMs != nil {
		t.Errorf("ARP-only host wrong: %+v", silent)
	}
	if pc.IP != "192.168.1.10" || pc.MAC != "aa:bb:cc:00:00:10" {
		t.Errorf("host wrong: %+v", pc)
	}
}

func TestSweepNeverProbesOutsideThePrefix(t *testing.T) {
	prober := &fakeProber{alive: map[string]bool{}}
	prefix := netip.MustParsePrefix("10.1.2.0/26")
	Sweep(context.Background(), prefix, prober, Options{Concurrency: 16, PPS: 500, Timeout: time.Second})
	if len(prober.probed) != 62 {
		t.Fatalf("expected 62 probes, got %d", len(prober.probed))
	}
	for _, ip := range prober.probed {
		if !prefix.Contains(netip.MustParseAddr(ip)) {
			t.Fatalf("probed %s which is outside %s", ip, prefix)
		}
		if ip == "10.1.2.0" || ip == "10.1.2.63" {
			t.Fatalf("probed network/broadcast address %s", ip)
		}
	}
}

func TestSweepRespectsConcurrencyAndRateLimits(t *testing.T) {
	prober := &fakeProber{alive: map[string]bool{}, delay: 30 * time.Millisecond}
	start := time.Now()
	res := Sweep(context.Background(), netip.MustParsePrefix("10.0.0.0/27"), prober, Options{Concurrency: 3, PPS: 100, Timeout: time.Second})
	elapsed := time.Since(start)
	if got := atomic.LoadInt32(&prober.maxSeen); got > 3 {
		t.Errorf("concurrency limit 3 exceeded: %d probes in flight", got)
	}
	// 30 probes at <=100/s cannot finish faster than ~0.29s.
	if elapsed < 280*time.Millisecond {
		t.Errorf("rate limit not respected: %d probes in %v", res.HostsProbed, elapsed)
	}
}

func TestInterruptedSweepIsMarkedIncomplete(t *testing.T) {
	prober := &fakeProber{alive: map[string]bool{"10.0.0.1": true}}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	res := Sweep(ctx, netip.MustParsePrefix("10.0.0.0/24"), prober, Options{Concurrency: 4, PPS: 20, Timeout: time.Second})
	if res.Complete {
		t.Fatal("a cancelled sweep must not be reported as complete")
	}
	if res.HostsProbed >= 254 {
		t.Fatalf("sweep did not stop on cancellation (probed %d)", res.HostsProbed)
	}
}
