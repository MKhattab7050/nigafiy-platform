package asus

// Blocking schedules on Asuswrt (Built: R2, docs/features/router-controls.md): Parental Controls →
// Time Scheduling, the same MULTIFILTER_* lists the block uses, on firmware 3.0.0.4.386 and newer.
//
// Source: asuswrt-merlin.ng release/src/router/www/ParentalControl.asp (initial(), applyRule(),
// addRow_main()) and www/js/weekSchedule/weekSchedule.js (PC_init_data,
// PC_transform_offtime_json_to_string). MULTIFILTER_ENABLE / _MAC / _DEVICENAME /
// _MACFILTER_DAYTIME_V2 are parallel lists separated by ">" (one entry per device); ENABLE 1 means
// time scheduling; a DAYTIME_V2 entry is one or more 12-character rules separated by "<":
// mode "W" (offline: the device has no internet during the rule), enable "1", weekday bitmask as two
// upper-case hex digits (Sunday = bit 0 … Saturday = bit 6), start HHMM, end HHMM (all day:
// 0000-2400). Applied with rc_service restart_firewall, as the page does.
//
// Nigafiy's entry for a device is named "LD:<mac>" in MULTIFILTER_DEVICENAME (the block's tag); a
// device that already has an entry the administrator made is refused, never changed. Windows that
// cross midnight are split (router.SplitWindows), so every rule ends after it starts on the same
// day. Older firmware (before 386) used another, undocumented DAYTIME format: not offered there.
//
// Rate limits are not offered on Asuswrt: the Bandwidth Limiter list (qos_bw_rulelist, QoS_EZQoS.asp:
// rules "enable>target>download>upload>priority" separated by "<") has no name or comment field, so a
// rule Nigafiy made could not be told apart from the administrator's; it also works only in QoS
// mode "Bandwidth Limiter" (qos_type 2), and switching modes reboots the router and replaces
// Adaptive QoS.

import (
	"context"
	"fmt"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	v2Build          = 386
	defaultDaytimeV2 = "W03E21000700<W04122000800" // what the page writes for a new device (both rules off)
	mechSchedule     = "Asuswrt Parental Controls time scheduling (MULTIFILTER_MACFILTER_DAYTIME_V2)"
	rateNote         = "Not offered: Asuswrt's Bandwidth Limiter rules (qos_bw_rulelist) have no name or comment, so a Nigafiy limit could not be told apart from the administrator's; it also needs QoS in Bandwidth Limiter mode, and switching modes reboots the router. Set limits under QoS → Bandwidth Limiter"
)

var _ router.Scheduler = (*Driver)(nil)

func (d *Driver) scheduleCapability() router.CapabilityStatus {
	if d.build >= v2Build {
		return router.CapabilityStatus{Capability: router.CapSchedule, Supported: true, Mechanism: mechSchedule,
			Note: "Adds the device to Parental Controls → Time Scheduling with offline times (firmware 386 and newer); a device the administrator already lists there is not changed"}
	}
	fw := "unknown"
	if d.info != nil && d.info.Firmware != "" {
		fw = d.info.Firmware
	}
	return router.CapabilityStatus{Capability: router.CapSchedule, Supported: false,
		Note: "Not offered on this firmware (" + fw + "): Asuswrt before 3.0.0.4.386 stores Parental Controls schedules in an older format Nigafiy does not write; Nigafiy enforces the schedule itself with the router's block"}
}

func encodeRules(segs []router.Segment) string {
	parts := make([]string, len(segs))
	for i, s := range segs {
		mask := 0
		for _, d := range s.Days {
			mask |= 1 << uint(d)
		}
		end := strings.ReplaceAll(s.End, ":", "")
		parts[i] = fmt.Sprintf("W1%02X%s%s", mask, strings.ReplaceAll(s.Start, ":", ""), end)
	}
	return strings.Join(parts, "<")
}

func (d *Driver) requireV2(ctx context.Context, op string) error {
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return err
		}
	}
	if d.build < v2Build {
		return router.Errorf(router.ErrUnsupported, op, "Asuswrt firmware %s has no V2 Parental Controls schedule (needs 3.0.0.4.386 or newer)", d.info.Firmware)
	}
	return nil
}

// SetSchedule puts the device in Time Scheduling with the windows as offline times.
func (d *Driver) SetSchedule(ctx context.Context, rawMAC string, windows []router.Window) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if len(windows) == 0 {
		return d.ClearSchedule(ctx, mac)
	}
	segs, err := router.SplitWindows(windows)
	if err != nil {
		return router.Change{}, err
	}
	if err := d.requireV2(ctx, "schedule"); err != nil {
		return router.Change{}, err
	}
	rows, err := d.readMultifilter(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	want := encodeRules(segs)
	idx := -1
	for i, r := range rows {
		if r.mac != mac {
			continue
		}
		if !strings.HasPrefix(r.name, ldTagPrefix) {
			return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "the administrator already lists this device in Asuswrt Parental Controls (%q); Nigafiy does not change that entry", r.name)
		}
		if r.enable == "2" {
			return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "the device is blocked outright by Nigafiy; unblock it before giving it a schedule")
		}
		idx = i
	}
	if idx >= 0 && rows[idx].enable == "1" && rows[idx].dayV2 == want {
		return router.Change{Action: "schedule", MAC: mac, Mechanism: mechSchedule, Applied: false, AlreadyInEffect: true, Detail: "Asuswrt already has this schedule for the device", Undo: undoSchedule(mac)}, nil
	}
	row := mfRow{enable: "1", mac: mac, name: ldTagPrefix + mac, day: "<", dayV2: want}
	if idx >= 0 {
		rows[idx] = row
	} else {
		rows = append(rows, row)
	}
	if err := d.writeMultifilter(ctx, "schedule", rows); err != nil {
		return router.Change{}, err
	}
	after, err := d.readMultifilter(ctx, "schedule")
	if err != nil {
		return router.Change{}, err
	}
	ok := false
	for _, r := range after {
		ok = ok || (r.mac == mac && r.enable == "1" && r.dayV2 == want && r.name == ldTagPrefix+mac)
	}
	if !ok {
		return router.Change{}, router.Errorf(router.ErrRejected, "schedule", "Asuswrt accepted the change but Parental Controls does not show the new schedule for %s", mac)
	}
	return router.Change{
		Action:    "schedule",
		MAC:       mac,
		Mechanism: mechSchedule,
		Applied:   true,
		Detail:    fmt.Sprintf("Asuswrt Parental Controls takes %s offline %s (rules %s)", strings.ToUpper(mac), router.DescribeWindows(windows), want),
		Undo:      undoSchedule(mac),
	}, nil
}

func undoSchedule(mac string) string {
	return fmt.Sprintf("Remove the schedule in Nigafiy, or delete the entry %q under Parental Controls → Time Scheduling", ldTagPrefix+mac)
}

// ClearSchedule removes the device's Nigafiy Time Scheduling entry.
func (d *Driver) ClearSchedule(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	rows, err := d.readMultifilter(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	var kept []mfRow
	removed := ""
	for _, r := range rows {
		if r.mac == mac && r.enable == "1" && strings.HasPrefix(r.name, ldTagPrefix) {
			removed = r.dayV2
			continue
		}
		kept = append(kept, r)
	}
	if removed == "" {
		return router.Change{Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy schedule for this device in Asuswrt Parental Controls"}, nil
	}
	if err := d.writeMultifilter(ctx, "clear_schedule", kept); err != nil {
		return router.Change{}, err
	}
	after, err := d.readMultifilter(ctx, "clear_schedule")
	if err != nil {
		return router.Change{}, err
	}
	for _, r := range after {
		if r.mac == mac && r.enable == "1" && strings.HasPrefix(r.name, ldTagPrefix) {
			return router.Change{}, router.Errorf(router.ErrRejected, "clear_schedule", "Asuswrt still lists the Nigafiy schedule for %s", mac)
		}
	}
	return router.Change{
		Action: "clear_schedule", MAC: mac, Mechanism: mechSchedule, Applied: true,
		Detail: "removed the Nigafiy Time Scheduling entry (rules " + removed + ")",
		Undo:   "Set the schedule again in Nigafiy",
	}, nil
}
