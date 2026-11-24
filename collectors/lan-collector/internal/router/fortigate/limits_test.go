package fortigate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// fgCMDB is a FortiOS CMDB test double for address, shaper, shaping-policy, recurring schedule and
// policy tables (ordered, with mkeys, move and reference checks). Protocol double only.
type fgCMDB struct {
	mu       sync.Mutex
	tables   map[string][]map[string]any
	nextID   int
	failPath string // a POST to this table is refused
	writes   int
	srv      *httptest.Server
}

var fgKeys = map[string]string{
	"firewall/address": "name", "firewall.shaper/traffic-shaper": "name", "firewall.schedule/recurring": "name",
	"firewall/shaping-policy": "id", "firewall/policy": "policyid",
}

func newFgCMDB(t *testing.T) *fgCMDB {
	f := &fgCMDB{nextID: 100, tables: map[string][]map[string]any{
		// The administrator's own policy: must stay, and stays below ours.
		"firewall/policy":         {{"policyid": float64(1), "name": "LAN to WAN", "action": "accept", "schedule": "always"}},
		"firewall/shaping-policy": {{"id": float64(1), "name": "Admin VoIP", "traffic-shaper": "high-priority"}},
	}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fgCMDB) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+fgToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	fail := func(code int) {
		w.WriteHeader(http.StatusInternalServerError)
		reply(map[string]any{"status": "error", "http_status": 500, "error": code})
	}
	switch r.URL.Path {
	case "/api/v2/monitor/system/status":
		reply(map[string]any{"version": "v7.2.8"})
		return
	case "/api/v2/monitor/user/device/query":
		reply(map[string]any{"results": []map[string]any{{"mac": "aa:bb:cc:00:00:10", "ipv4_address": "192.168.30.10"}}})
		return
	case "/api/v2/monitor/system/dhcp", "/api/v2/monitor/user/banned/select":
		reply(map[string]any{"results": []any{}})
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v2/cmdb/")
	var table, key string
	for t := range fgKeys {
		if rest == t || strings.HasPrefix(rest, t+"/") {
			table, key = t, strings.TrimPrefix(strings.TrimPrefix(rest, t), "/")
		}
	}
	if table == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	kf := fgKeys[table]
	rows := f.tables[table]
	idx := -1
	for i, row := range rows {
		if key != "" && str(row[kf]) == key {
			idx = i
		}
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if r.Method != http.MethodGet {
		f.writes++
	}
	switch r.Method {
	case http.MethodGet:
		reply(map[string]any{"results": rows})
	case http.MethodPost:
		if table == f.failPath {
			fail(-5)
			return
		}
		if kf == "name" {
			if named(rows, "name", str(body["name"])) != nil {
				fail(-5)
				return
			}
		} else {
			f.nextID++
			body[kf] = float64(f.nextID)
		}
		// References must exist (FortiOS refuses unknown names).
		if s := str(body["schedule"]); s != "" && named(f.tables["firewall.schedule/recurring"], "name", s) == nil {
			fail(-3)
			return
		}
		f.tables[table] = append(rows, body)
		reply(map[string]any{"status": "success", "mkey": body[kf]})
	case http.MethodPut:
		if idx < 0 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Query().Get("action") == "move" {
			before := r.URL.Query().Get("before")
			row := rows[idx]
			rows = append(rows[:idx:idx], rows[idx+1:]...)
			for i, x := range rows {
				if str(x[kf]) == before {
					rows = append(rows[:i], append([]map[string]any{row}, rows[i:]...)...)
					break
				}
			}
			f.tables[table] = rows
			reply(map[string]any{"status": "success"})
			return
		}
		for k, v := range body {
			rows[idx][k] = v
		}
		reply(map[string]any{"status": "success"})
	case http.MethodDelete:
		if idx < 0 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		name := str(rows[idx]["name"])
		// An object still referenced by a policy cannot be deleted (FortiOS error -23).
		for _, t := range []string{"firewall/policy", "firewall/shaping-policy"} {
			for _, p := range f.tables[t] {
				b, _ := json.Marshal(p)
				if table != t && strings.Contains(string(b), `"`+name+`"`) {
					fail(-23)
					return
				}
			}
		}
		f.tables[table] = append(rows[:idx:idx], rows[idx+1:]...)
		reply(map[string]any{"status": "success"})
	}
}

func (f *fgCMDB) driver(t *testing.T, pin, token string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(f.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(f.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "fg", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "token", []byte(token), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func (f *fgCMDB) count(table, prefix string) int {
	n := 0
	for _, r := range f.tables[table] {
		if strings.HasPrefix(str(r["name"]), prefix) {
			n++
		}
	}
	return n
}

const fgMAC = "aa:bb:cc:00:00:10"

func TestFortiGateRateLimit(t *testing.T) {
	ctx := context.Background()
	f := newFgCMDB(t)
	d := f.driver(t, "", fgToken)
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapRateLimit) || !caps.Supports(router.CapSchedule) {
		t.Fatalf("capabilities: %v", err)
	}
	ch, err := d.SetRateLimit(ctx, fgMAC, router.RateLimit{DownKbps: 5000, UpKbps: 1000})
	if err != nil || !ch.Applied {
		t.Fatalf("SetRateLimit: %v", err)
	}
	noSecret(t, "SetRateLimit", ch)
	pols := f.tables["firewall/shaping-policy"]
	if len(pols) != 2 || pols[0]["name"] != "ld-lim-aabbcc000010" || pols[0]["traffic-shaper"] != "ld-lim-aabbcc000010-up" || pols[0]["traffic-shaper-reverse"] != "ld-lim-aabbcc000010-dn" || pols[1]["name"] != "Admin VoIP" {
		t.Fatalf("shaping policies: %v", pols)
	}
	if a := named(f.tables["firewall/address"], "name", "ld-lim-aabbcc000010"); a == nil || a["subnet"] != "192.168.30.10 255.255.255.255" {
		t.Fatalf("address: %v", f.tables["firewall/address"])
	}
	// Download only: the upload shaper goes away.
	if _, err := d.SetRateLimit(ctx, fgMAC, router.RateLimit{DownKbps: 2000}); err != nil {
		t.Fatal(err)
	}
	if f.count("firewall.shaper/traffic-shaper", "ld-lim-") != 1 || str(named(f.tables["firewall.shaper/traffic-shaper"], "name", "ld-lim-aabbcc000010-dn")["maximum-bandwidth"]) != "2000" {
		t.Fatalf("shapers: %v", f.tables["firewall.shaper/traffic-shaper"])
	}
	if ch, err := d.ClearRateLimit(ctx, fgMAC); err != nil || !ch.Applied {
		t.Fatalf("ClearRateLimit: %v", err)
	}
	if f.count("firewall/shaping-policy", "ld-") != 0 || f.count("firewall.shaper/traffic-shaper", "ld-") != 0 || f.count("firewall/address", "ld-") != 0 || len(f.tables["firewall/shaping-policy"]) != 1 {
		t.Fatalf("leftovers: %v", f.tables)
	}
	if ch, err := d.ClearRateLimit(ctx, fgMAC); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestFortiGateSchedule(t *testing.T) {
	ctx := context.Background()
	f := newFgCMDB(t)
	d := f.driver(t, "", fgToken)
	ch, err := d.SetSchedule(ctx, fgMAC, []router.Window{{Days: []time.Weekday{1, 2, 3, 4, 5}, Start: "22:00", End: "06:30"}})
	if err != nil || !ch.Applied {
		t.Fatalf("SetSchedule: %v", err)
	}
	scheds := f.tables["firewall.schedule/recurring"]
	if len(scheds) != 2 || scheds[0]["day"] != "monday tuesday wednesday thursday friday" || scheds[0]["start"] != "22:00" || scheds[0]["end"] != "00:00" ||
		scheds[1]["day"] != "tuesday wednesday thursday friday saturday" || scheds[1]["start"] != "00:00" || scheds[1]["end"] != "06:30" {
		t.Fatalf("schedules: %v", scheds)
	}
	pols := f.tables["firewall/policy"]
	if len(pols) != 3 || pols[0]["action"] != "deny" || pols[1]["action"] != "deny" || pols[2]["name"] != "LAN to WAN" || pols[0]["comments"] != schComment(fgMAC) {
		t.Fatalf("policies: %v", pols)
	}
	// All days, all day: one pair, the previous generation removed.
	if _, err := d.SetSchedule(ctx, fgMAC, []router.Window{{Days: []time.Weekday{0, 1, 2, 3, 4, 5, 6}, Start: "00:00", End: "00:00"}}); err != nil {
		t.Fatal(err)
	}
	if f.count("firewall/policy", "ld-sch-") != 1 || f.count("firewall.schedule/recurring", "ld-sch-") != 1 {
		t.Fatalf("replace: %v", f.tables)
	}
	s := f.tables["firewall.schedule/recurring"][0]
	if s["start"] != "00:00" || s["end"] != "00:00" || !strings.Contains(str(s["day"]), "sunday") {
		t.Fatalf("all day: %v", s)
	}
	// Empty = clear; the administrator's policy stays.
	if ch, err := d.SetSchedule(ctx, fgMAC, nil); err != nil || !ch.Applied || ch.Action != "clear_schedule" {
		t.Fatalf("clear: %v %+v", err, ch)
	}
	if len(f.tables["firewall/policy"]) != 1 || f.count("firewall.schedule/recurring", "ld-") != 0 || f.count("firewall/address", "ld-") != 0 {
		t.Fatalf("leftovers: %v", f.tables)
	}
}

func TestFortiGateLimitRefusals(t *testing.T) {
	ctx := context.Background()
	win := []router.Window{{Days: []time.Weekday{6}, Start: "09:00", End: "10:00"}}

	t.Run("refused policy keeps the previous schedule", func(t *testing.T) {
		f := newFgCMDB(t)
		d := f.driver(t, "", fgToken)
		if _, err := d.SetSchedule(ctx, fgMAC, win); err != nil {
			t.Fatal(err)
		}
		f.failPath = "firewall/policy"
		_, err := d.SetSchedule(ctx, fgMAC, []router.Window{{Days: []time.Weekday{0}, Start: "09:00", End: "10:00"}})
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "-5") {
			t.Fatalf("want the FortiOS error, got %v", err)
		}
		if f.count("firewall/policy", "ld-sch-") != 1 || f.count("firewall.schedule/recurring", "ld-sch-") != 1 || f.tables["firewall.schedule/recurring"][0]["day"] != "saturday" {
			t.Fatalf("previous schedule not kept: %v", f.tables)
		}
	})
	t.Run("refused shaper", func(t *testing.T) {
		f := newFgCMDB(t)
		d := f.driver(t, "", fgToken)
		f.failPath = "firewall.shaper/traffic-shaper"
		if _, err := d.SetRateLimit(ctx, fgMAC, router.RateLimit{UpKbps: 10}); !errors.Is(err, router.ErrRejected) {
			t.Fatal(err)
		}
		if f.count("firewall/shaping-policy", "ld-") != 0 {
			t.Fatal("a policy without its shaper was created")
		}
	})
	t.Run("bad input and unknown device", func(t *testing.T) {
		f := newFgCMDB(t)
		d := f.driver(t, "", fgToken)
		if _, err := d.SetRateLimit(ctx, fgMAC, router.RateLimit{}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetSchedule(ctx, fgMAC, []router.Window{{Days: []time.Weekday{1}, Start: "09:00", End: "9:30"}}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetSchedule(ctx, "aa:bb:cc:00:00:99", win); !errors.Is(err, router.ErrNotFound) {
			t.Fatal(err)
		}
		if f.writes != 0 {
			t.Fatal("refused input reached the FortiGate")
		}
	})
	t.Run("wrong token", func(t *testing.T) {
		f := newFgCMDB(t)
		d := f.driver(t, "", "wrong")
		_, err := d.SetSchedule(ctx, fgMAC, win)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatal(err)
		}
		noSecret(t, "error", err)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		f := newFgCMDB(t)
		d := f.driver(t, strings.Repeat("cd", 32), fgToken)
		if _, err := d.SetRateLimit(ctx, fgMAC, router.RateLimit{UpKbps: 10}); !errors.Is(err, router.ErrCertificate) || f.writes != 0 {
			t.Fatal(err)
		}
	})
}
