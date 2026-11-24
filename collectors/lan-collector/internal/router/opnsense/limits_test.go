package opnsense

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/nigafiy/sensor/internal/router"
)

// opnShaper is a protocol test double of the OPNsense traffic shaper API (pipes, rules, reconfigure).
type opnShaper struct {
	mu           sync.Mutex
	pipes, rules []map[string]any
	reconfigures int
	refuse       bool // add/set answer {"result":"failed","validations":...}
	writes       int
	next         int
	srv          *httptest.Server
}

func newOpnShaper(t *testing.T) *opnShaper {
	f := &opnShaper{
		pipes: []map[string]any{{"uuid": "p-admin", "description": "Guest WAN 20M", "bandwidth": "20", "bandwidthMetric": "Mbit"}},
		rules: []map[string]any{{"uuid": "r-admin", "description": "Guest", "target": "p-admin", "source": "192.168.20.0/24", "destination": "any"}},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *opnShaper) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if k, s, ok := r.BasicAuth(); !ok || k != opnCtlKey || s != opnCtlSecret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	p := r.URL.Path
	switch {
	case p == "/api/core/firmware/info":
		reply(map[string]any{"product_version": "25.7.2"})
		return
	case p == "/api/diagnostics/interface/getArp":
		reply([]map[string]any{{"mac": "aa:bb:cc:00:00:10", "ip": "192.168.20.10"}})
		return
	case p == "/api/dhcpv4/leases/searchLease":
		reply(map[string]any{"rows": []any{}})
		return
	case p == "/api/trafficshaper/service/reconfigure":
		f.reconfigures++
		reply(map[string]any{"status": "ok"})
		return
	case !strings.HasPrefix(p, "/api/trafficshaper/settings/"):
		w.WriteHeader(http.StatusNotFound)
		return
	}
	action := strings.TrimPrefix(p, "/api/trafficshaper/settings/")
	var body map[string]map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !strings.HasPrefix(action, "search") {
		f.writes++
	}
	table := &f.pipes
	if strings.Contains(action, "Rule") {
		table = &f.rules
	}
	id := ""
	if i := strings.Index(action, "/"); i >= 0 {
		action, id = action[:i], action[i+1:]
	}
	switch action {
	case "searchPipes", "searchRules":
		reply(map[string]any{"rows": *table})
	case "addPipe", "addRule", "setPipe", "setRule":
		item := body["pipe"]
		if item == nil {
			item = body["rule"]
		}
		if f.refuse || item == nil {
			reply(map[string]any{"result": "failed", "validations": map[string]string{"pipe.bandwidth": "invalid"}})
			return
		}
		if action == "addRule" || action == "setRule" {
			found := false
			for _, pp := range f.pipes {
				found = found || pp["uuid"] == item["target"]
			}
			if !found {
				reply(map[string]any{"result": "failed", "validations": map[string]string{"rule.target": "unknown pipe"}})
				return
			}
		}
		if strings.HasPrefix(action, "add") {
			f.next++
			item["uuid"] = fmt.Sprintf("u%d", f.next)
			*table = append(*table, item)
			reply(map[string]any{"result": "saved", "uuid": item["uuid"]})
			return
		}
		for _, row := range *table {
			if row["uuid"] == id {
				for k, v := range item {
					row[k] = v
				}
			}
		}
		reply(map[string]any{"result": "saved"})
	case "delPipe", "delRule":
		for i, row := range *table {
			if row["uuid"] == id {
				*table = append((*table)[:i:i], (*table)[i+1:]...)
				break
			}
		}
		reply(map[string]any{"result": "deleted"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *opnShaper) driver(t *testing.T, pin, secret string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "opn", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return opnCtlKey, []byte(secret), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func find(rows []map[string]any, desc string) map[string]any {
	for _, r := range rows {
		if r["description"] == desc {
			return r
		}
	}
	return nil
}

func TestOPNsenseRateLimit(t *testing.T) {
	ctx := context.Background()
	f := newOpnShaper(t)
	d := f.driver(t, "", opnCtlSecret)
	mac := "aa:bb:cc:00:00:10"
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapRateLimit) || caps.Supports(router.CapSchedule) || !strings.Contains(caps.Get(router.CapSchedule).Note, "no API") {
		t.Fatalf("capabilities: %v %+v", err, caps)
	}
	ch, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 8000, UpKbps: 2000})
	if err != nil || !ch.Applied {
		t.Fatalf("SetRateLimit: %v", err)
	}
	noSecret(t, "SetRateLimit", ch)
	down, up := find(f.pipes, limitDesc(mac, "down")), find(f.pipes, limitDesc(mac, "up"))
	rd, ru := find(f.rules, limitDesc(mac, "down")), find(f.rules, limitDesc(mac, "up"))
	if down["bandwidth"] != "8000" || down["bandwidthMetric"] != "Kbit" || up["bandwidth"] != "2000" ||
		rd["destination"] != "192.168.20.10" || rd["target"] != down["uuid"] || ru["source"] != "192.168.20.10" || rd["interface"] != "lan" || f.reconfigures != 1 {
		t.Fatalf("shaper state: pipes=%v rules=%v", f.pipes, f.rules)
	}
	// Upload only now: the download pipe and rule go.
	if _, err := d.SetRateLimit(ctx, mac, router.RateLimit{UpKbps: 500}); err != nil {
		t.Fatal(err)
	}
	if find(f.pipes, limitDesc(mac, "down")) != nil || find(f.rules, limitDesc(mac, "down")) != nil || find(f.pipes, limitDesc(mac, "up"))["bandwidth"] != "500" {
		t.Fatalf("after change: %v %v", f.pipes, f.rules)
	}
	if ch, err := d.ClearRateLimit(ctx, mac); err != nil || !ch.Applied {
		t.Fatalf("ClearRateLimit: %v", err)
	}
	if len(f.pipes) != 1 || len(f.rules) != 1 || f.pipes[0]["uuid"] != "p-admin" {
		t.Fatalf("the administrator's shaper entries must stay alone: %v %v", f.pipes, f.rules)
	}
	if ch, err := d.ClearRateLimit(ctx, mac); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestOPNsenseRateLimitRefusals(t *testing.T) {
	ctx := context.Background()
	mac := "aa:bb:cc:00:00:10"
	t.Run("validation refused", func(t *testing.T) {
		f := newOpnShaper(t)
		d := f.driver(t, "", opnCtlSecret)
		f.refuse = true
		_, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 1})
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "pipe.bandwidth") {
			t.Fatalf("want ErrRejected naming the field, got %v", err)
		}
		if len(f.pipes) != 1 || f.reconfigures != 0 {
			t.Fatal("a refused change was applied")
		}
	})
	t.Run("bad input", func(t *testing.T) {
		f := newOpnShaper(t)
		d := f.driver(t, "", opnCtlSecret)
		if _, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: router.MaxRateKbps + 1}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetRateLimit(ctx, "ff:ff:ff:ff:ff:ff", router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:99", router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrNotFound) {
			t.Fatal(err)
		}
		if f.writes != 0 {
			t.Fatal("bad input reached OPNsense")
		}
	})
	t.Run("wrong secret", func(t *testing.T) {
		f := newOpnShaper(t)
		d := f.driver(t, "", "wrong")
		_, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 1})
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatal(err)
		}
		noSecret(t, "error", err)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		f := newOpnShaper(t)
		d := f.driver(t, strings.Repeat("12", 32), opnCtlSecret)
		if _, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrCertificate) || f.writes != 0 {
			t.Fatal(err)
		}
	})
}
