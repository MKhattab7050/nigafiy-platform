package asus

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

func TestAsusSchedule(t *testing.T) {
	ctx := context.Background()
	f := newFakeAsus(t)
	d := openTestAsus(t, f, "asus-pass")
	sc := d.(router.Scheduler)
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapSchedule) || caps.Supports(router.CapRateLimit) || !strings.Contains(caps.Get(router.CapRateLimit).Note, "no name") {
		t.Fatalf("capabilities: %v %+v", err, caps)
	}
	mac := "aa:bb:cc:00:00:01"
	// School nights 21:30-06:45 (overnight) and all of Saturday.
	ch, err := sc.SetSchedule(ctx, mac, []router.Window{
		{Days: []time.Weekday{0, 1, 2, 3, 4}, Start: "21:30", End: "06:45"},
		{Days: []time.Weekday{6}, Start: "00:00", End: "00:00"},
	})
	if err != nil || !ch.Applied {
		t.Fatalf("SetSchedule: %v %+v", err, ch)
	}
	if f.nvram["MULTIFILTER_MAC"] != "AA:BB:CC:00:00:03>AA:BB:CC:00:00:01" || f.nvram["MULTIFILTER_ENABLE"] != "2>1" ||
		f.nvram["MULTIFILTER_DEVICENAME"] != "Kid-Tablet>LD:"+mac {
		t.Fatalf("lists: %v", f.nvram)
	}
	// Sun-Thu 21:30-24:00 (mask 0x1F), Mon-Fri 00:00-06:45 (0x3E), Saturday all day (0x40).
	if got := f.nvram["MULTIFILTER_MACFILTER_DAYTIME_V2"]; got != "W03E21000700<W04122000800>W11F21302400<W13E00000645<W14000002400" {
		t.Fatalf("V2 list: %q", got)
	}
	// The same schedule again changes nothing.
	n := f.applies
	if ch, err := sc.SetSchedule(ctx, mac, []router.Window{{Days: []time.Weekday{0, 1, 2, 3, 4}, Start: "21:30", End: "06:45"}, {Days: []time.Weekday{6}, Start: "00:00", End: "00:00"}}); err != nil || ch.Applied || f.applies != n {
		t.Fatalf("repeat: %v %+v", err, ch)
	}
	// Blocking outright while a Nigafiy schedule exists is refused (one entry per device).
	if _, err := d.Block(ctx, mac); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("block over schedule: %v", err)
	}
	// A block entry added later keeps the V2 list aligned.
	if _, err := d.Block(ctx, "aa:bb:cc:00:00:02"); err != nil {
		t.Fatal(err)
	}
	if v := strings.Split(f.nvram["MULTIFILTER_MACFILTER_DAYTIME_V2"], ">"); len(v) != 3 || v[1] != "W11F21302400<W13E00000645<W14000002400" {
		t.Fatalf("alignment: %v", v)
	}
	// Empty = clear: only our entry goes.
	if ch, err := sc.SetSchedule(ctx, mac, nil); err != nil || !ch.Applied {
		t.Fatalf("clear: %v", err)
	}
	if f.nvram["MULTIFILTER_MAC"] != "AA:BB:CC:00:00:03>AA:BB:CC:00:00:02" || f.nvram["MULTIFILTER_MACFILTER_DAYTIME_V2"] != "W03E21000700<W04122000800>W03E21000700<W04122000800" {
		t.Fatalf("after clear: %v", f.nvram)
	}
	if ch, err := sc.ClearSchedule(ctx, mac); err != nil || ch.Applied {
		t.Fatalf("clear again: %v %+v", err, ch)
	}
}

func TestAsusScheduleRefusals(t *testing.T) {
	ctx := context.Background()
	win := []router.Window{{Days: []time.Weekday{1}, Start: "08:00", End: "09:00"}}
	t.Run("administrator's entry", func(t *testing.T) {
		f := newFakeAsus(t)
		d := openTestAsus(t, f, "asus-pass")
		if _, err := d.(router.Scheduler).SetSchedule(ctx, "aa:bb:cc:00:00:03", win); !errors.Is(err, router.ErrRejected) || f.applies != 0 {
			t.Fatal(err)
		}
	})
	t.Run("old firmware", func(t *testing.T) {
		f := newFakeAsus(t)
		f.nvram["buildno"] = "384"
		d := openTestAsus(t, f, "asus-pass")
		caps, _ := d.Capabilities(ctx)
		if c := caps.Get(router.CapSchedule); c.Supported || !strings.Contains(c.Note, "3.0.0.4.384") {
			t.Fatalf("%+v", c)
		}
		if _, err := d.(router.Scheduler).SetSchedule(ctx, "aa:bb:cc:00:00:01", win); !errors.Is(err, router.ErrUnsupported) || f.applies != 0 {
			t.Fatal(err)
		}
	})
	t.Run("bad input", func(t *testing.T) {
		f := newFakeAsus(t)
		d := openTestAsus(t, f, "asus-pass")
		if _, err := d.(router.Scheduler).SetSchedule(ctx, "aa:bb:cc:00:00:01", []router.Window{{Days: []time.Weekday{1}, Start: "08:00", End: "24:00"}}); !errors.Is(err, router.ErrInvalidArgument) || f.applies != 0 {
			t.Fatal(err)
		}
	})
	t.Run("pin mismatch", func(t *testing.T) {
		f := newFakeAsus(t)
		host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
		port, _ := strconv.Atoi(portStr)
		addr := netip.MustParseAddr(host)
		d, err := router.Open(router.Target{ID: "as1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: strings.Repeat("78", 32), Timeout: 5 * time.Second},
			func(context.Context) (string, []byte, error) { return "admin", []byte("asus-pass"), nil },
			router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.(router.Scheduler).SetSchedule(ctx, "aa:bb:cc:00:00:01", win); !errors.Is(err, router.ErrCertificate) || f.applies != 0 {
			t.Fatal(err)
		}
	})
	t.Run("wrong password", func(t *testing.T) {
		f := newFakeAsus(t)
		d := openTestAsus(t, f, "nope")
		_, err := d.(router.Scheduler).SetSchedule(ctx, "aa:bb:cc:00:00:01", win)
		if !errors.Is(err, router.ErrBadCredentials) || strings.Contains(err.Error(), "nope") || f.applies != 0 {
			t.Fatal(err)
		}
	})
}
