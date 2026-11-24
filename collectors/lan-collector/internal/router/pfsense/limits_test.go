package pfsense

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
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// pfSchedules is a protocol test double of the pfSense REST API v2 schedules and rules (ids are list
// positions, as in the package; the time-range validation follows FirewallScheduleTimeRange.inc).
type pfSchedules struct {
	mu       sync.Mutex
	scheds   []map[string]any
	rules    []map[string]any
	applied  int
	failRule bool
	writes   int
	srv      *httptest.Server
}

var pfHour = regexp.MustCompile(`^([01]\d|2[0-3]):(00|15|30|45|59)-([01]\d|2[0-3]):(00|15|30|45|59)$`)

func newPfSchedules(t *testing.T) *pfSchedules {
	f := &pfSchedules{
		scheds: []map[string]any{{"name": "WorkHours", "descr": "admin"}},
		rules:  []map[string]any{{"type": "pass", "descr": "Default allow LAN to any rule", "interface": []any{"lan"}}},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func withIDs(rows []map[string]any) []map[string]any {
	for i, r := range rows {
		r["id"] = i
	}
	return rows
}

func (f *pfSchedules) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ok := func(data any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "code": 200, "data": data})
	}
	bad := func(msg string) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "bad request", "code": 400, "message": msg})
	}
	if r.Header.Get("X-API-Key") != pfKey {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "unauthorized", "code": 401, "message": "Authentication failed"})
		return
	}
	if r.Method != http.MethodGet {
		f.writes++
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	switch {
	case r.URL.Path == "/api/v2/system/version":
		ok(map[string]any{"version": "2.7.2-RELEASE"})
	case r.URL.Path == "/api/v2/diagnostics/arp_table":
		ok([]map[string]any{{"mac_address": "aa:bb:cc:00:00:10", "ip_address": "192.168.10.10"}})
	case r.URL.Path == "/api/v2/services/dhcp_server/leases":
		ok([]any{})
	case r.URL.Path == "/api/v2/firewall/schedules":
		ok(withIDs(f.scheds))
	case r.URL.Path == "/api/v2/firewall/rules":
		ok(withIDs(f.rules))
	case r.URL.Path == "/api/v2/firewall/apply":
		f.applied++
		ok(map[string]any{})
	case r.URL.Path == "/api/v2/firewall/schedule" && r.Method == http.MethodPost:
		trs, _ := body["timerange"].([]any)
		if len(trs) == 0 {
			bad("Field `timerange` must contain at least 1 item")
			return
		}
		for _, x := range trs {
			tr := x.(map[string]any)
			h := str(tr["hour"])
			if !pfHour.MatchString(h) || h[:5] > h[6:] {
				bad("Field `hour` must be HH:MM-HH:MM with the start before the end")
				return
			}
		}
		f.scheds = append(f.scheds, body)
		ok(body)
	case r.URL.Path == "/api/v2/firewall/schedule" && r.Method == http.MethodDelete:
		name := str(f.scheds[id]["name"])
		for _, rule := range f.rules {
			if rule["sched"] == name {
				bad("schedule is in use")
				return
			}
		}
		f.scheds = append(f.scheds[:id:id], f.scheds[id+1:]...)
		ok(map[string]any{})
	case r.URL.Path == "/api/v2/firewall/rule" && r.Method == http.MethodPost:
		if f.failRule {
			bad("Field `source` is invalid")
			return
		}
		found := false
		for _, s := range f.scheds {
			found = found || s["name"] == body["sched"]
		}
		if !found {
			bad("Field `sched` must be an existing schedule")
			return
		}
		f.rules = append(f.rules, body)
		ok(body)
	case r.URL.Path == "/api/v2/firewall/rule" && r.Method == http.MethodDelete:
		f.rules = append(f.rules[:id:id], f.rules[id+1:]...)
		ok(map[string]any{})
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "not found", "code": 404})
	}
}

func (f *pfSchedules) driver(t *testing.T, pin, key string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "pf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "api-key", []byte(key), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func (f *pfSchedules) own() (rules, scheds []map[string]any) {
	for _, r := range f.rules {
		if r["descr"] == schedDescr(pfMAC) {
			rules = append(rules, r)
		}
	}
	for _, s := range f.scheds {
		if s["descr"] == schedDescr(pfMAC) {
			scheds = append(scheds, s)
		}
	}
	return
}

const pfMAC = "aa:bb:cc:00:00:10"

func TestPfSenseSchedule(t *testing.T) {
	ctx := context.Background()
	f := newPfSchedules(t)
	d := f.driver(t, "", pfKey)
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapSchedule) || caps.Supports(router.CapRateLimit) || !strings.Contains(caps.Get(router.CapRateLimit).Note, "floating pass rule") {
		t.Fatalf("capabilities: %v", err)
	}
	ch, err := d.SetSchedule(ctx, pfMAC, []router.Window{{Days: []time.Weekday{0, 6}, Start: "21:30", End: "07:00"}})
	if err != nil || !ch.Applied {
		t.Fatalf("SetSchedule: %v", err)
	}
	noSecret(t, "SetSchedule", ch)
	rules, scheds := f.own()
	if len(rules) != 1 || len(scheds) != 1 || rules[0]["floating"] != true || rules[0]["quick"] != true || rules[0]["type"] != "block" || rules[0]["source"] != "192.168.10.10" {
		t.Fatalf("state: rules=%v scheds=%v", f.rules, f.scheds)
	}
	trs := scheds[0]["timerange"].([]any)
	if len(trs) != 2 || fmt.Sprint(trs[0].(map[string]any)["position"]) != "[7 6]" || trs[0].(map[string]any)["hour"] != "21:30-23:59" ||
		fmt.Sprint(trs[1].(map[string]any)["position"]) != "[7 1]" || trs[1].(map[string]any)["hour"] != "00:00-07:00" {
		t.Fatalf("time ranges: %v", trs)
	}
	if f.rules[0]["descr"] != "Default allow LAN to any rule" {
		t.Fatal("the administrator's rule moved")
	}
	// Replace: one rule and one schedule remain, under a new name.
	if _, err := d.SetSchedule(ctx, pfMAC, []router.Window{{Days: []time.Weekday{1}, Start: "00:00", End: "00:00"}}); err != nil {
		t.Fatal(err)
	}
	rules, scheds = f.own()
	if len(rules) != 1 || len(scheds) != 1 || scheds[0]["name"] != "LD_aabbcc000010_2" || scheds[0]["timerange"].([]any)[0].(map[string]any)["hour"] != "00:00-23:59" {
		t.Fatalf("replace: %v %v", rules, scheds)
	}
	// Empty = clear; the administrator's schedule and rule stay.
	if ch, err := d.SetSchedule(ctx, pfMAC, nil); err != nil || !ch.Applied {
		t.Fatalf("clear: %v", err)
	}
	if len(f.rules) != 1 || len(f.scheds) != 1 || f.scheds[0]["name"] != "WorkHours" {
		t.Fatalf("leftovers: %v %v", f.rules, f.scheds)
	}
	if ch, err := d.ClearSchedule(ctx, pfMAC); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestPfSenseScheduleRefusals(t *testing.T) {
	ctx := context.Background()
	win := []router.Window{{Days: []time.Weekday{3}, Start: "18:00", End: "19:00"}}
	t.Run("refused rule keeps the previous schedule", func(t *testing.T) {
		f := newPfSchedules(t)
		d := f.driver(t, "", pfKey)
		if _, err := d.SetSchedule(ctx, pfMAC, win); err != nil {
			t.Fatal(err)
		}
		f.failRule = true
		_, err := d.SetSchedule(ctx, pfMAC, []router.Window{{Days: []time.Weekday{4}, Start: "18:00", End: "19:00"}})
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "source") {
			t.Fatalf("want pfSense's reason, got %v", err)
		}
		rules, scheds := f.own()
		if len(rules) != 1 || len(scheds) != 1 || scheds[0]["name"] != "LD_aabbcc000010_1" {
			t.Fatalf("previous schedule lost: %v %v", rules, scheds)
		}
	})
	t.Run("times off the quarter hour", func(t *testing.T) {
		f := newPfSchedules(t)
		d := f.driver(t, "", pfKey)
		if _, err := d.SetSchedule(ctx, pfMAC, []router.Window{{Days: []time.Weekday{3}, Start: "18:10", End: "19:00"}}); !errors.Is(err, router.ErrInvalidArgument) || !strings.Contains(err.Error(), "quarter") {
			t.Fatal(err)
		}
		if _, err := d.SetSchedule(ctx, "01:00:5e:00:00:01", win); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if f.writes != 0 {
			t.Fatal("refused input reached pfSense")
		}
	})
	t.Run("wrong key", func(t *testing.T) {
		f := newPfSchedules(t)
		d := f.driver(t, "", "wrong")
		_, err := d.SetSchedule(ctx, pfMAC, win)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatal(err)
		}
		noSecret(t, "error", err)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		f := newPfSchedules(t)
		d := f.driver(t, strings.Repeat("34", 32), pfKey)
		if _, err := d.SetSchedule(ctx, pfMAC, win); !errors.Is(err, router.ErrCertificate) || f.writes != 0 {
			t.Fatal(err)
		}
	})
}
