package zyxel

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
	"github.com/lan-detective/lan-collector/internal/router/zyxel/zyxeltest"
)

// limitsFixture plays the owner's firmware as read on 2026-11-21: QoS off, auto mapping None,
// four default WAN queues, no classes, parental control off with no profiles.
func limitsFixture() zyxeltest.Config {
	cfg := controlsFixture()
	cfg.QoS = map[string]any{"AutoMapType": "None", "DownRate": float64(0), "Enable": false, "UpRate": float64(0)}
	for i, n := range []string{"Highest", "High", "Medium", "Low"} {
		cfg.QoSQueues = append(cfg.QoSQueues, map[string]any{"BufferManagement": "DT", "Enable": true, "Index": float64(i + 1), "idx": float64(i + 1),
			"Interface": "WAN", "Name": n, "Priority": float64(i + 1), "RateLimit": float64(-1), "SchedulerAlgorithm": "SP", "Weight": float64(1)})
	}
	cfg.ParentalWritable = true
	cfg.RotateSessionKey = true
	return cfg
}

func TestRateLimitUploadQueueClassAndQoSSwitch(t *testing.T) {
	srv := start(t, limitsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	ctx := context.Background()

	caps, err := d.Capabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c := caps.Get(router.CapRateLimit); !c.Supported || !strings.Contains(c.Note, "upload only") {
		t.Fatalf("rate limit capability: %+v", c)
	}
	if !caps.Supports(router.CapSchedule) {
		t.Fatalf("schedule capability: %+v", caps.Get(router.CapSchedule))
	}

	rl := d.(router.RateLimiter)
	if _, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{DownKbps: 5000, UpKbps: 1000}); !errors.Is(err, router.ErrUnsupported) {
		t.Fatalf("download limit must be refused, got %v", err)
	}
	ch, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{UpKbps: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || !strings.Contains(ch.Detail, "QoS was off") {
		t.Fatalf("change: %+v", ch)
	}
	g, queues, classes := srv.QoSState()
	if g["Enable"] != true || g["AutoMapType"] != "None" {
		t.Fatalf("QoS global: %v", g)
	}
	if len(queues) != 5 || queues[4]["Name"] != "LD-aabbcc000001" || queues[4]["RateLimit"] != float64(1000) || queues[4]["Interface"] != "WAN" {
		t.Fatalf("queues: %v", queues)
	}
	if len(classes) != 1 || classes[0]["SourceMACAddress"] != "AA:BB:CC:00:00:01" || classes[0]["Queue"] != float64(5) ||
		classes[0]["Interface"] != "LAN" || classes[0]["SourceMACEnable"] != true || classes[0]["defaultQ"] != false {
		t.Fatalf("classes: %v", classes)
	}
	for i := 0; i < 4; i++ {
		if queues[i]["RateLimit"] != float64(-1) {
			t.Fatalf("an administrator queue was changed: %v", queues[i])
		}
	}

	// Same limit again: nothing changes. A new rate updates the queue in place.
	if ch, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{UpKbps: 1000}); err != nil || !ch.AlreadyInEffect || ch.Applied {
		t.Fatalf("repeat: %+v %v", ch, err)
	}
	if _, err := rl.SetRateLimit(ctx, "aa:bb:cc:00:00:01", router.RateLimit{UpKbps: 2000}); err != nil {
		t.Fatal(err)
	}
	if _, queues, classes = srv.QoSState(); len(queues) != 5 || queues[4]["RateLimit"] != float64(2000) || len(classes) != 1 {
		t.Fatalf("update: %v %v", queues, classes)
	}

	ch, err = rl.ClearRateLimit(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || !strings.Contains(ch.Detail, "QoS turned off again") {
		t.Fatalf("clear: %+v %v", ch, err)
	}
	if g, queues, classes = srv.QoSState(); g["Enable"] != false || len(queues) != 4 || len(classes) != 0 {
		t.Fatalf("after clear: %v %v %v", g, queues, classes)
	}
	if ch, err := rl.ClearRateLimit(ctx, "aa:bb:cc:00:00:01"); err != nil || !ch.AlreadyInEffect {
		t.Fatalf("clear again: %+v %v", ch, err)
	}
	if srv.CSRFRejected != 0 {
		t.Fatalf("CSRF rejected %d", srv.CSRFRejected)
	}
}

func TestRateLimitRefusesWhenQueuesFullOrAutoMapping(t *testing.T) {
	cfg := limitsFixture()
	for i := 5; i <= 8; i++ {
		cfg.QoSQueues = append(cfg.QoSQueues, map[string]any{"Index": float64(i), "idx": float64(i), "Name": "admin", "Interface": "WAN", "RateLimit": float64(-1), "Enable": true})
	}
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	if _, err := d.(router.RateLimiter).SetRateLimit(context.Background(), "aa:bb:cc:00:00:01", router.RateLimit{UpKbps: 500}); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("full queues: %v", err)
	}
	if g, _, classes := srv.QoSState(); g["Enable"] != false || len(classes) != 0 {
		t.Fatal("a refused limit must not change the router")
	}

	cfg = limitsFixture()
	cfg.QoS["AutoMapType"] = "Ethernet Priority"
	srv = start(t, cfg)
	d = open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	if _, err := d.(router.RateLimiter).SetRateLimit(context.Background(), "aa:bb:cc:00:00:01", router.RateLimit{UpKbps: 500}); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("auto mapping: %v", err)
	}
}

func TestScheduleProfileFromBlockedWindows(t *testing.T) {
	srv := start(t, limitsFixture())
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	ctx := context.Background()
	sc := d.(router.Scheduler)
	every := []time.Weekday{0, 1, 2, 3, 4, 5, 6}

	ch, err := sc.SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: every, Start: "22:00", End: "07:00"}})
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Applied || !strings.Contains(ch.Detail, "07:00-22:00") || !strings.Contains(ch.Detail, "parental control was off") {
		t.Fatalf("change: %+v", ch)
	}
	on, profiles := srv.Parental()
	if !on || len(profiles) != 1 {
		t.Fatalf("parental: %v %v", on, profiles)
	}
	p := profiles[0]
	if p["pcpName"] != "LD-aabbcc000001" || p["MACAddressList"] != "AA:BB:CC:00:00:01" || p["TimeRangeList"] != "07:00-22:00" ||
		p["Days"] != "Mon,Tue,Wed,Thu,Fri,Sat,Sun" || p["ServicePolicy"] != "Block" || p["UrlPolicy"] != "Block" || p["URLFilter"] != "" {
		t.Fatalf("profile: %v", p)
	}

	// The blocks list shows it as LAN Detective's own schedule.
	blocks, err := d.Blocked(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, b := range blocks {
		if b.MAC == "aa:bb:cc:00:00:01" && b.Owner == router.OwnerProduct && b.Managed {
			found = true
		}
	}
	if !found {
		t.Fatalf("blocks: %+v", blocks)
	}

	// Changing the windows edits the same profile; repeating them changes nothing.
	weekdays := []time.Weekday{1, 2, 3, 4, 5}
	if _, err := sc.SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: weekdays, Start: "00:00", End: "06:00"}, {Days: weekdays, Start: "13:00", End: "15:00"}}); err != nil {
		t.Fatal(err)
	}
	if _, profiles = srv.Parental(); len(profiles) != 1 || profiles[0]["TimeRangeList"] != "06:00-13:00,15:00-23:59" || profiles[0]["Days"] != "Mon,Tue,Wed,Thu,Fri" {
		t.Fatalf("edited: %v", profiles)
	}
	if ch, err := sc.SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: weekdays, Start: "13:00", End: "15:00"}, {Days: weekdays, Start: "00:00", End: "06:00"}}); err != nil || !ch.AlreadyInEffect {
		t.Fatalf("repeat: %+v %v", ch, err)
	}

	ch, err = sc.ClearSchedule(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied || !strings.Contains(ch.Detail, "parental control turned off again") {
		t.Fatalf("clear: %+v %v", ch, err)
	}
	if on, profiles = srv.Parental(); on || len(profiles) != 0 {
		t.Fatalf("after clear: %v %v", on, profiles)
	}
	if srv.CSRFRejected != 0 {
		t.Fatalf("CSRF rejected %d", srv.CSRFRejected)
	}
}

// The owner's router had EasyMesh on: it accepted the profile but never enforced it. The driver
// must not offer or set a schedule that would silently do nothing.
func TestScheduleRefusedWhileMeshIsOn(t *testing.T) {
	cfg := limitsFixture()
	on, off := true, false
	cfg.EasyMesh, cfg.OneConnect = &on, &off
	srv := start(t, cfg)
	d := open(t, srv, &creds{user: "admin", pass: testPassword}, nil)
	defer d.Close(context.Background())
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if c := caps.Get(router.CapSchedule); c.Supported || !strings.Contains(c.Note, "EasyMesh") {
		t.Fatalf("schedule capability with mesh on: %+v", c)
	}
	_, err = d.(router.Scheduler).SetSchedule(context.Background(), "aa:bb:cc:00:00:01",
		[]router.Window{{Days: []time.Weekday{0, 1, 2, 3, 4, 5, 6}, Start: "20:00", End: "23:00"}})
	if !errors.Is(err, router.ErrRejected) {
		t.Fatalf("want refused, got %v", err)
	}
	if pc, profiles := srv.Parental(); pc || len(profiles) != 0 {
		t.Fatal("a refused schedule must not change the router")
	}
}

func TestAllowedRangesRules(t *testing.T) {
	every := []time.Weekday{0, 1, 2, 3, 4, 5, 6}
	for _, tc := range []struct {
		in   []router.Window
		want string
		bad  bool
	}{
		{in: []router.Window{{Days: every, Start: "22:00", End: "07:00"}}, want: "07:00-22:00"},
		{in: []router.Window{{Days: every, Start: "00:00", End: "24:00"}}, bad: true},                      // whole day
		{in: []router.Window{{Days: every, Start: "10:00", End: "10:00"}}, bad: true},                      // empty window
		{in: []router.Window{{Days: every, Start: "01:00", End: "02:00"}, {Days: []time.Weekday{1}, Start: "03:00", End: "04:00"}}, bad: true}, // mixed days
		{in: []router.Window{{Days: every, Start: "01:00", End: "02:00"}, {Days: every, Start: "03:00", End: "04:00"},
			{Days: every, Start: "05:00", End: "06:00"}}, bad: true}, // four allowed periods
		{in: []router.Window{{Days: every, Start: "20:00", End: "24:00"}}, want: "00:00-20:00"},
		{in: []router.Window{{Days: every, Start: "09:00", End: "12:00"}, {Days: every, Start: "11:00", End: "13:00"}}, want: "00:00-09:00,13:00-23:59"},
	} {
		_, got, err := allowedRanges(tc.in)
		if tc.bad {
			if !errors.Is(err, router.ErrInvalidArgument) {
				t.Errorf("%v: want invalid, got %v %v", tc.in, got, err)
			}
			continue
		}
		if err != nil || strings.Join(got, ",") != tc.want {
			t.Errorf("%v: got %v %v, want %s", tc.in, got, err, tc.want)
		}
	}
	if !isLDObject("LD-aabbcc000001") || isLDObject("LD-admin") || isLDObject("Highest") {
		t.Error("isLDObject")
	}
}
