package router

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Shared rules for the rate-limit and schedule controls (docs/features/router-controls.md, "Built: R2").
// Drivers whose router cannot express a window that crosses midnight split it here, so every driver
// blocks the same minutes for the same request.

// MaxWindows bounds one schedule (the API allows at most 8).
const MaxWindows = 8

// MaxRateKbps bounds one direction of a rate limit (10 Gbit/s, as the API).
const MaxRateKbps = 10_000_000

// EndOfDay is the End of a Segment that runs to midnight. Drivers write it in their router's own
// form ("23:59" where the router has no 24:00).
const EndOfDay = "24:00"

// Segment is a part of a weekly window that stays inside one day: blocked from Start to End
// ("HH:MM", End after Start; End may be EndOfDay) on each of Days.
type Segment struct {
	Days  []time.Weekday
	Start string
	End   string
}

// AllDay reports whether the segment covers the whole day.
func (s Segment) AllDay() bool { return s.Start == "00:00" && s.End == EndOfDay }

// Minutes converts "HH:MM" (or EndOfDay) to minutes after midnight.
func Minutes(hhmm string) (int, bool) {
	if hhmm == EndOfDay {
		return 24 * 60, true
	}
	if len(hhmm) != 5 || hhmm[2] != ':' {
		return 0, false
	}
	h, err1 := strconv.Atoi(hhmm[:2])
	m, err2 := strconv.Atoi(hhmm[3:])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// ValidateRateLimit refuses a limit with no direction or a negative / too large value.
func ValidateRateLimit(l RateLimit) error {
	if l.DownKbps < 0 || l.UpKbps < 0 || l.DownKbps > MaxRateKbps || l.UpKbps > MaxRateKbps {
		return Errorf(ErrInvalidArgument, "rate_limit", "limits must be between 0 and %d kbit/s", MaxRateKbps)
	}
	if l.DownKbps == 0 && l.UpKbps == 0 {
		return Errorf(ErrInvalidArgument, "rate_limit", "give a limit in at least one direction")
	}
	return nil
}

// ValidateWindows checks a schedule: 1 to MaxWindows windows, each with at least one valid day and
// "HH:MM" times. A window whose end is not after its start crosses midnight into the next day (the
// same rule the API applies); start == end is a full 24 hours from start.
func ValidateWindows(ws []Window) error {
	if len(ws) == 0 || len(ws) > MaxWindows {
		return Errorf(ErrInvalidArgument, "schedule", "give 1 to %d time windows", MaxWindows)
	}
	for i, w := range ws {
		if len(w.Days) == 0 {
			return Errorf(ErrInvalidArgument, "schedule", "window %d has no days", i+1)
		}
		for _, d := range w.Days {
			if d < time.Sunday || d > time.Saturday {
				return Errorf(ErrInvalidArgument, "schedule", "window %d has an invalid day", i+1)
			}
		}
		if _, ok := Minutes(w.Start); !ok || w.Start == EndOfDay {
			return Errorf(ErrInvalidArgument, "schedule", "window %d start must be HH:MM", i+1)
		}
		if _, ok := Minutes(w.End); !ok || w.End == EndOfDay {
			return Errorf(ErrInvalidArgument, "schedule", "window %d end must be HH:MM", i+1)
		}
	}
	return nil
}

// SplitWindows validates ws and returns segments that stay inside one day. A window crossing
// midnight becomes start→EndOfDay on its days and 00:00→end on the following days (end 00:00 adds
// nothing on the next day). Days are sorted and de-duplicated; segments with the same times are merged.
func SplitWindows(ws []Window) ([]Segment, error) {
	if err := ValidateWindows(ws); err != nil {
		return nil, err
	}
	type key struct{ s, e string }
	byTime := map[key]map[time.Weekday]bool{}
	var order []key
	add := func(days []time.Weekday, shift int, s, e string) {
		k := key{s, e}
		if byTime[k] == nil {
			byTime[k] = map[time.Weekday]bool{}
			order = append(order, k)
		}
		for _, d := range days {
			byTime[k][time.Weekday((int(d)+shift)%7)] = true
		}
	}
	for _, w := range ws {
		s, _ := Minutes(w.Start)
		e, _ := Minutes(w.End)
		if e > s {
			add(w.Days, 0, w.Start, w.End)
			continue
		}
		add(w.Days, 0, w.Start, EndOfDay)
		if e > 0 {
			add(w.Days, 1, "00:00", w.End)
		}
	}
	out := make([]Segment, 0, len(order))
	for _, k := range order {
		var days []time.Weekday
		for d := range byTime[k] {
			days = append(days, d)
		}
		sort.Slice(days, func(i, j int) bool { return days[i] < days[j] })
		out = append(out, Segment{Days: days, Start: k.s, End: k.e})
	}
	return out, nil
}

// DescribeWindows is a short human form of a schedule for Change.Detail and Undo
// ("Mon,Tue 22:00-06:00; Sat 00:00-00:00").
func DescribeWindows(ws []Window) string {
	names := [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	parts := make([]string, 0, len(ws))
	for _, w := range ws {
		ds := make([]string, 0, len(w.Days))
		for _, d := range w.Days {
			if d >= 0 && d <= 6 {
				ds = append(ds, names[d])
			}
		}
		parts = append(parts, fmt.Sprintf("%s %s-%s", strings.Join(ds, ","), w.Start, w.End))
	}
	return strings.Join(parts, "; ")
}

// DescribeLimit is "down 2000 kbit/s, up 500 kbit/s" (a direction of 0 is "no limit").
func DescribeLimit(l RateLimit) string {
	f := func(v int) string {
		if v <= 0 {
			return "no limit"
		}
		return fmt.Sprintf("%d kbit/s", v)
	}
	return fmt.Sprintf("down %s, up %s", f(l.DownKbps), f(l.UpKbps))
}
