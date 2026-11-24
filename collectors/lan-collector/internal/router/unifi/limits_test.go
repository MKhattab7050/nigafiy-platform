package unifi

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
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// ufLimits is a UniFi OS test double for user groups and v2 traffic rules (protocol double only).
type ufLimits struct {
	users      []map[string]any
	groups     []map[string]any
	rules      []map[string]any
	noV2       bool
	failWrites bool
	writes     int
	nextID     int
	srv        *httptest.Server
}

func newUfLimits(t *testing.T) *ufLimits {
	st := &ufLimits{
		users: []map[string]any{
			{"_id": "u1", "mac": "aa:bb:cc:00:00:10", "usergroup_id": "g-def"},
			{"_id": "u2", "mac": "aa:bb:cc:00:00:20", "usergroup_id": "g-admin"},
		},
		groups: []map[string]any{
			{"_id": "g-def", "name": "Default", "attr_hidden_id": "Default", "attr_no_delete": true, "qos_rate_max_down": -1, "qos_rate_max_up": -1},
			{"_id": "g-admin", "name": "Kids", "qos_rate_max_down": 4000, "qos_rate_max_up": 1000},
		},
		rules: []map[string]any{
			// The administrator's own rule for the same device: never touched.
			{"_id": "r-admin", "action": "BLOCK", "description": "Homework", "enabled": true, "target_devices": []any{map[string]any{"client_mac": "aa:bb:cc:00:00:10", "type": "CLIENT"}}},
		},
	}
	st.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := func(data any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "ok"}, "data": data})
		}
		if r.URL.Path == "/api/auth/login" {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if str(b["password"]) != ufPassword {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("X-Csrf-Token", ufCSRF)
			http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: ufToken})
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if c, err := r.Cookie("TOKEN"); err != nil || c.Value != ufToken || (r.Method != http.MethodGet && r.Header.Get("X-CSRF-Token") != ufCSRF) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Method != http.MethodGet {
			if st.failWrites {
				if strings.Contains(r.URL.Path, "/v2/") {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"code":"api.err.InvalidPayload","message":"bad schedule"}`))
				} else {
					_ = json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"rc": "error", "msg": "api.err.InvalidPayload"}, "data": []any{}})
				}
				return
			}
			st.writes++
		}
		const v1 = "/proxy/network/api/s/default"
		const v2 = "/proxy/network/v2/api/site/default"
		p := r.URL.Path
		switch {
		case p == "/proxy/network/api/self/sites":
			ok([]map[string]any{{"name": "default"}})
		case p == v1+"/stat/sysinfo":
			ok([]map[string]any{{"version": "8.6.9"}})
		case p == v1+"/rest/user" && r.Method == http.MethodGet:
			ok(st.users)
		case strings.HasPrefix(p, v1+"/rest/user/") && r.Method == http.MethodPut:
			for _, u := range st.users {
				if u["_id"] == strings.TrimPrefix(p, v1+"/rest/user/") {
					for k, v := range body {
						u[k] = v
					}
				}
			}
			ok([]any{})
		case p == v1+"/rest/usergroup" && r.Method == http.MethodGet:
			ok(st.groups)
		case p == v1+"/rest/usergroup" && r.Method == http.MethodPost:
			st.nextID++
			body["_id"] = fmt.Sprintf("g%d", st.nextID)
			st.groups = append(st.groups, body)
			ok([]any{body})
		case strings.HasPrefix(p, v1+"/rest/usergroup/"):
			id := strings.TrimPrefix(p, v1+"/rest/usergroup/")
			for i, g := range st.groups {
				if g["_id"] != id {
					continue
				}
				if r.Method == http.MethodDelete {
					st.groups = append(st.groups[:i], st.groups[i+1:]...)
				} else {
					for k, v := range body {
						g[k] = v
					}
				}
				break
			}
			ok([]any{})
		case strings.HasPrefix(p, v2+"/trafficrules"):
			if st.noV2 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			id := strings.TrimPrefix(strings.TrimPrefix(p, v2+"/trafficrules"), "/")
			switch r.Method {
			case http.MethodGet:
				_ = json.NewEncoder(w).Encode(st.rules)
			case http.MethodPost:
				sch, _ := body["schedule"].(map[string]any)
				if body["action"] != "BLOCK" || sch == nil || str(sch["time_range_start"]) >= str(sch["time_range_end"]) && sch["time_all_day"] != true {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"code":"api.err.InvalidTimeRange","message":"end before start"}`))
					return
				}
				st.nextID++
				body["_id"] = fmt.Sprintf("r%d", st.nextID)
				st.rules = append(st.rules, body)
				_ = json.NewEncoder(w).Encode(body)
			case http.MethodDelete:
				for i, x := range st.rules {
					if x["_id"] == id {
						st.rules = append(st.rules[:i], st.rules[i+1:]...)
						break
					}
				}
				w.WriteHeader(http.StatusOK)
			}
		default:
			ok([]any{})
		}
	}))
	t.Cleanup(st.srv.Close)
	return st
}

func (st *ufLimits) driver(t *testing.T, pin, password string) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(st.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	if pin == "" {
		sum := sha256.Sum256(st.srv.Certificate().Raw)
		pin = router.FormatPin(sum[:])
	}
	d, err := New(router.Target{ID: "uf", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: pin},
		func(context.Context) (string, []byte, error) { return "admin", []byte(password), nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func (st *ufLimits) group(name string) map[string]any {
	for _, g := range st.groups {
		if g["name"] == name {
			return g
		}
	}
	return nil
}

func (st *ufLimits) ours(mac string) []map[string]any {
	var out []map[string]any
	for _, r := range st.rules {
		if r["description"] == scheduleDescPfx+mac {
			out = append(out, r)
		}
	}
	return out
}

func TestUniFiRateLimit(t *testing.T) {
	ctx := context.Background()
	st := newUfLimits(t)
	d := st.driver(t, "", ufPassword)
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapRateLimit) || !caps.Supports(router.CapSchedule) {
		t.Fatalf("capabilities: %v %+v", err, caps)
	}
	ch, err := d.SetRateLimit(ctx, "AA-BB-CC-00-00-10", router.RateLimit{DownKbps: 2000})
	if err != nil || !ch.Applied {
		t.Fatalf("SetRateLimit: %v %+v", err, ch)
	}
	g := st.group(limitGroupPrefix + "aa:bb:cc:00:00:10")
	if g == nil || g["qos_rate_max_down"] != float64(2000) || g["qos_rate_max_up"] != float64(-1) || st.users[0]["usergroup_id"] != g["_id"] {
		t.Fatalf("router state after set: group=%v user=%v", g, st.users[0])
	}
	noSecret(t, "SetRateLimit", ch)
	// Same limit again: nothing changes.
	w := st.writes
	if ch, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 2000}); err != nil || ch.Applied || st.writes != w {
		t.Fatalf("repeat: %v %+v", err, ch)
	}
	// Change it: the same group is updated.
	if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 3000, UpKbps: 800}); err != nil {
		t.Fatal(err)
	}
	if g := st.group(limitGroupPrefix + "aa:bb:cc:00:00:10"); g["qos_rate_max_up"] != float64(800) || len(st.groups) != 3 {
		t.Fatalf("update: %v (%d groups)", g, len(st.groups))
	}
	ch, err = d.ClearRateLimit(ctx, "aa:bb:cc:00:00:10")
	if err != nil || !ch.Applied || st.users[0]["usergroup_id"] != "g-def" || st.group(limitGroupPrefix+"aa:bb:cc:00:00:10") != nil {
		t.Fatalf("ClearRateLimit: %v %+v %v", err, ch, st.users[0])
	}
	if ch, err := d.ClearRateLimit(ctx, "aa:bb:cc:00:00:10"); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestUniFiRateLimitRefusals(t *testing.T) {
	ctx := context.Background()
	st := newUfLimits(t)
	d := st.driver(t, "", ufPassword)
	// The administrator's group is never left silently.
	if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:20", router.RateLimit{DownKbps: 100}); !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "Kids") || st.users[1]["usergroup_id"] != "g-admin" {
		t.Fatalf("admin group: %v", err)
	}
	for _, l := range []router.RateLimit{{}, {DownKbps: -5, UpKbps: 10}} {
		if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", l); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("%+v: %v", l, err)
		}
	}
	if _, err := d.SetRateLimit(ctx, "01:00:5e:00:00:01", router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrInvalidArgument) {
		t.Fatal(err)
	}
	if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:99", router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrNotFound) {
		t.Fatal(err)
	}
	if st.writes != 0 || len(st.groups) != 2 {
		t.Fatalf("refused input reached the controller (%d writes)", st.writes)
	}
	// The controller refuses the write.
	st.failWrites = true
	if _, err := d.SetRateLimit(ctx, "aa:bb:cc:00:00:10", router.RateLimit{DownKbps: 100}); err == nil {
		t.Fatal("want an error when UniFi refuses")
	}
	if len(st.groups) != 2 || st.users[0]["usergroup_id"] != "g-def" {
		t.Fatal("a refused write changed the controller")
	}
}

func TestUniFiSchedule(t *testing.T) {
	ctx := context.Background()
	st := newUfLimits(t)
	d := st.driver(t, "", ufPassword)
	mac := "aa:bb:cc:00:00:10"
	// Overnight Fri+Sat 22:00-06:00 and every day 12:00-13:00.
	ch, err := d.SetSchedule(ctx, mac, []router.Window{
		{Days: []time.Weekday{5, 6}, Start: "22:00", End: "06:00"},
		{Days: []time.Weekday{0, 1, 2, 3, 4, 5, 6}, Start: "12:00", End: "13:00"},
	})
	if err != nil || !ch.Applied {
		t.Fatalf("SetSchedule: %v %+v", err, ch)
	}
	ours := st.ours(mac)
	if len(ours) != 3 {
		t.Fatalf("want 3 rules (overnight split + daily), got %d", len(ours))
	}
	s0 := ours[0]["schedule"].(map[string]any)
	s1 := ours[1]["schedule"].(map[string]any)
	s2 := ours[2]["schedule"].(map[string]any)
	if s0["time_range_start"] != "22:00" || s0["time_range_end"] != "23:59" || fmt.Sprint(s0["repeat_on_days"]) != "[fri sat]" ||
		s1["time_range_start"] != "00:00" || s1["time_range_end"] != "06:00" || fmt.Sprint(s1["repeat_on_days"]) != "[sun sat]" ||
		s2["mode"] != "EVERY_DAY" || ours[0]["matching_target"] != "INTERNET" {
		t.Fatalf("rules: %v / %v / %v", s0, s1, s2)
	}
	// Replace with all day on Sunday: old rules go, the administrator's rule stays.
	if _, err := d.SetSchedule(ctx, mac, []router.Window{{Days: []time.Weekday{0}, Start: "00:00", End: "00:00"}}); err != nil {
		t.Fatal(err)
	}
	ours = st.ours(mac)
	if len(ours) != 1 || ours[0]["schedule"].(map[string]any)["time_all_day"] != true || st.rules[0]["_id"] != "r-admin" {
		t.Fatalf("replace: %v", st.rules)
	}
	// Empty = clear.
	if ch, err := d.SetSchedule(ctx, mac, nil); err != nil || ch.Action != "clear_schedule" || !ch.Applied || len(st.ours(mac)) != 0 || len(st.rules) != 1 {
		t.Fatalf("empty schedule: %v %+v %v", err, ch, st.rules)
	}
	if ch, err := d.ClearSchedule(ctx, mac); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestUniFiScheduleRefusals(t *testing.T) {
	ctx := context.Background()
	mac := "aa:bb:cc:00:00:10"
	win := []router.Window{{Days: []time.Weekday{1}, Start: "08:00", End: "09:00"}}

	t.Run("bad input", func(t *testing.T) {
		st := newUfLimits(t)
		d := st.driver(t, "", ufPassword)
		if _, err := d.SetSchedule(ctx, mac, []router.Window{{Days: []time.Weekday{1}, Start: "25:00", End: "09:00"}}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if _, err := d.SetSchedule(ctx, mac, []router.Window{{Start: "08:00", End: "09:00"}}); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatal(err)
		}
		if st.writes != 0 {
			t.Fatal("bad input reached the controller")
		}
	})
	t.Run("controller refuses: previous schedule kept", func(t *testing.T) {
		st := newUfLimits(t)
		d := st.driver(t, "", ufPassword)
		if _, err := d.SetSchedule(ctx, mac, win); err != nil {
			t.Fatal(err)
		}
		st.failWrites = true
		_, err := d.SetSchedule(ctx, mac, []router.Window{{Days: []time.Weekday{2}, Start: "10:00", End: "11:00"}})
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "bad schedule") {
			t.Fatalf("want the controller's reason, got %v", err)
		}
		if o := st.ours(mac); len(o) != 1 || o[0]["schedule"].(map[string]any)["time_range_start"] != "08:00" {
			t.Fatalf("previous schedule lost: %v", st.rules)
		}
	})
	t.Run("old controller", func(t *testing.T) {
		st := newUfLimits(t)
		st.noV2 = true
		d := st.driver(t, "", ufPassword)
		caps, _ := d.Capabilities(ctx)
		if c := caps.Get(router.CapSchedule); c.Supported || !strings.Contains(c.Note, "7.x") || !strings.Contains(c.Note, "8.6.9") {
			t.Fatalf("capability: %+v", c)
		}
		if _, err := d.SetSchedule(ctx, mac, win); !errors.Is(err, router.ErrUnsupported) {
			t.Fatal(err)
		}
	})
	t.Run("wrong password", func(t *testing.T) {
		st := newUfLimits(t)
		d := st.driver(t, "", "nope")
		_, err := d.SetSchedule(ctx, mac, win)
		if !errors.Is(err, router.ErrBadCredentials) {
			t.Fatal(err)
		}
		noSecret(t, "error", err)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		st := newUfLimits(t)
		d := st.driver(t, strings.Repeat("ab", 32), ufPassword)
		if _, err := d.SetRateLimit(ctx, mac, router.RateLimit{DownKbps: 1}); !errors.Is(err, router.ErrCertificate) || st.writes != 0 {
			t.Fatal(err)
		}
	})
}
