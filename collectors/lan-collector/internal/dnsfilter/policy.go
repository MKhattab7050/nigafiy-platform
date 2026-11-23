// Package dnsfilter is Nigafiy's network-wide access control that works with any router.
//
// The collector answers DNS for the devices on the network (the owner points the router's DHCP
// "DNS server" at the collector host). Ordinary questions are forwarded unchanged to the real
// upstream resolver; a question that a device's rules forbid gets an empty answer (0.0.0.0 / ::),
// so the site or app cannot be reached. Nothing is intercepted or spoofed: devices only use this
// resolver because the network owner configured the router to hand it out.
//
// Limits (stated in the product): a device that uses its own encrypted DNS, a VPN, or a hard-coded
// resolver bypasses this filter; known encrypted-DNS endpoints are blocked to push devices back to
// the network resolver, but that is not a guarantee. Bandwidth limits are not possible at DNS level.
package dnsfilter

import (
	"strings"
	"time"
	// Embedded IANA zone data: Windows hosts have no zoneinfo database, and schedules must be
	// evaluated in the site's zone wherever the collector runs.
	_ "time/tzdata"
)

// Window is a period when the internet is off for a device ("bedtime"). Days use 0 = Sunday.
// When To is not after From the window crosses midnight (22:00 → 07:00).
type Window struct {
	Days []int  `json:"days"`
	From string `json:"from"`
	To   string `json:"to"`
}

// Rule is the effective rule for one device, already merged by the cloud from the site defaults,
// the device's profile and the device's own settings.
type Rule struct {
	Categories  []string   `json:"blocked_categories"`
	Blocked     []string   `json:"blocked_domains"`
	Allowed     []string   `json:"allowed_domains"`
	PausedUntil *time.Time `json:"paused_until,omitempty"`
	Schedule    []Window   `json:"schedule,omitempty"`
}

// Client binds a rule to a device. The device is recognised by MAC (from the neighbour table) and,
// as a fallback, by the IP address the cloud last saw for it.
type Client struct {
	MAC  string `json:"mac"`
	IP   string `json:"ip"`
	Rule Rule   `json:"rule"`
}

// Policy is the whole filter configuration delivered by the cloud.
type Policy struct {
	Enabled   bool     `json:"enabled"`
	Upstreams []string `json:"upstreams"`
	Default   Rule     `json:"default"`
	Clients   []Client `json:"clients"`
	// Timezone is the site's IANA zone (e.g. "Europe/Berlin") in which schedule windows are
	// evaluated. Empty means the collector host's local time (older clouds do not send it).
	Timezone string `json:"timezone,omitempty"`
}

// Location resolves the policy's timezone. Empty → host-local time. A zone that cannot be loaded
// also falls back to host-local time, and ok is false so the caller can report it; schedules keep
// working rather than silently never matching.
func (p Policy) Location() (loc *time.Location, ok bool) {
	tz := strings.TrimSpace(p.Timezone)
	if tz == "" {
		return time.Local, true
	}
	l, err := time.LoadLocation(tz)
	if err != nil {
		return time.Local, false
	}
	return l, true
}

// Decision is the outcome for one question.
type Decision struct {
	Blocked  bool
	Reason   string // "paused", "schedule", "domain", "category", "encrypted_dns"
	Category string
}

// alwaysCategory is enforced whenever the filter is on: encrypted-DNS endpoints that would let a
// device silently bypass the network's rules.
const alwaysCategory = "encrypted_dns"

func minutes(hhmm string) (int, bool) {
	if len(hhmm) != 5 || hhmm[2] != ':' {
		return 0, false
	}
	h, m := int(hhmm[0]-'0')*10+int(hhmm[1]-'0'), int(hhmm[3]-'0')*10+int(hhmm[4]-'0')
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

func hasDay(days []int, d int) bool {
	for _, x := range days {
		if x == d {
			return true
		}
	}
	return false
}

// Active reports whether the window covers the moment t (in t's location).
func (w Window) Active(t time.Time) bool {
	from, ok1 := minutes(w.From)
	to, ok2 := minutes(w.To)
	if !ok1 || !ok2 {
		return false
	}
	now := t.Hour()*60 + t.Minute()
	day := int(t.Weekday())
	if from < to {
		return hasDay(w.Days, day) && now >= from && now < to
	}
	prev := (day + 6) % 7
	return (hasDay(w.Days, day) && now >= from) || (hasDay(w.Days, prev) && now < to)
}

// Normalize lower-cases a DNS name and strips the trailing dot.
func Normalize(name string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
}

// matchSuffix reports whether name or one of its parent domains is in set.
func matchSuffix(set map[string]struct{}, name string) bool {
	for n := name; n != ""; {
		if _, ok := set[n]; ok {
			return true
		}
		i := strings.IndexByte(n, '.')
		if i < 0 {
			return false
		}
		n = n[i+1:]
	}
	return false
}

func listMatch(list []string, name string) bool {
	for _, d := range list {
		d = Normalize(d)
		if d != "" && (name == d || strings.HasSuffix(name, "."+d)) {
			return true
		}
	}
	return false
}

// Decide applies a rule to one DNS name at the moment now. Allowed domains win over everything
// except a paused device or an active bedtime window, which turn the whole internet off.
func Decide(r Rule, name string, now time.Time, lists *Lists) Decision {
	name = Normalize(name)
	if r.PausedUntil != nil && now.Before(*r.PausedUntil) {
		return Decision{Blocked: true, Reason: "paused"}
	}
	for _, w := range r.Schedule {
		if w.Active(now) {
			return Decision{Blocked: true, Reason: "schedule"}
		}
	}
	if listMatch(r.Allowed, name) {
		return Decision{}
	}
	if listMatch(r.Blocked, name) {
		return Decision{Blocked: true, Reason: "domain"}
	}
	if lists != nil {
		if lists.Has(alwaysCategory, name) {
			return Decision{Blocked: true, Reason: "encrypted_dns", Category: alwaysCategory}
		}
		for _, c := range r.Categories {
			if lists.Has(c, name) {
				return Decision{Blocked: true, Reason: "category", Category: c}
			}
		}
	}
	return Decision{}
}
