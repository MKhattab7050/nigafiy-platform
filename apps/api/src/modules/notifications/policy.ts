import type { NotificationAction } from '@nigafiy/shared-types/notification-actions';
import { logger } from '../../infrastructure/logger.ts';
import { type Db, withSystem } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';

// Calm alerts (UX review 2026-11-26 item 12; migration 058).
//
// Every queued delivery starts with policy_at NULL. Before the dispatcher sends, applyDeliveryPolicy
// decides each one:
//   1. a matching mute (device, type, or type for one device)  → held as 'muted' (record only)
//   2. critical                                                → sent at once
//   3. quiet hours on                                          → held as 'quiet' (summary when they end)
//   4. its severity is set to "weekly" and the summary is on   → held as 'weekly'
//   5. same channel + device + type sent within dedup_minutes → held as 'duplicate' (record only)
//   6. otherwise                                               → sent at once (policy_at = now)
// Organizations without a notification_settings row keep the old behaviour: only mutes apply.
// A held delivery is removed from the queue and recorded in notification_holds, so nothing vanishes
// without a trace. releaseCalmSummaries turns held items into ONE summary event per group of channels
// (quiet hours ended, or the weekly summary is due); a summary is an ordinary event + deliveries, so the
// existing channel renderers send it. Summary deliveries skip the policy (policy_at set at insert).

export interface CalmSettings {
  info_mode: 'immediate' | 'weekly';
  warning_mode: 'immediate' | 'weekly';
  dedup_minutes: number;
  quiet_enabled: boolean;
  /** 'HH:MM' or 'HH:MM:SS' wall-clock time. */
  quiet_start: string;
  quiet_end: string;
  timezone: string | null;
  weekly_summary: boolean;
  weekly_day: number;
  weekly_hour: number;
  last_weekly_at: Date;
}

export type HoldReason = 'quiet' | 'weekly' | 'muted' | 'duplicate';
export type PolicyDecision = { send: true } | { send: false; reason: HoldReason };

/** A time zone name Intl understands, else null. */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Wall-clock weekday (0 = Sunday), hour and minute of `now` in `tz` (invalid → UTC). */
export function localParts(now: Date, tz: string | null): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone(tz) ?? 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday: Math.max(0, weekday), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

const toMinutes = (hhmm: string): number => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Quiet hours are on at `now`; a window whose end is not after its start runs past midnight. */
export function quietActive(s: Pick<CalmSettings, 'quiet_enabled' | 'quiet_start' | 'quiet_end'>, now: Date, tz: string | null): boolean {
  if (!s.quiet_enabled) return false;
  const start = toMinutes(s.quiet_start);
  const end = toMinutes(s.quiet_end);
  if (start === end) return false;
  const { hour, minute } = localParts(now, tz);
  const t = hour * 60 + minute;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The weekly summary is due: its local day and hour, at most once a day; or a week was missed (PC off). */
export function weeklyDue(s: Pick<CalmSettings, 'weekly_summary' | 'weekly_day' | 'weekly_hour' | 'last_weekly_at'>, now: Date, tz: string | null): boolean {
  if (!s.weekly_summary) return false;
  const since = now.getTime() - new Date(s.last_weekly_at).getTime();
  if (since >= (7 * 24 + 1) * 3600_000) return true;
  if (since < 20 * 3600_000) return false;
  const { weekday, hour } = localParts(now, tz);
  return weekday === s.weekly_day && hour === s.weekly_hour;
}

/** The decision for one delivery, given what the database said about mutes and recent sends. */
export function decide(
  ev: { severity: string },
  settings: CalmSettings | null,
  facts: { muted: boolean; quiet: boolean; recentDuplicate: boolean },
): PolicyDecision {
  if (facts.muted) return { send: false, reason: 'muted' };
  if (ev.severity === 'critical' || !settings) return { send: true };
  if (facts.quiet) return { send: false, reason: 'quiet' };
  const mode = ev.severity === 'info' ? settings.info_mode : settings.warning_mode;
  // "Weekly" without the weekly summary would hold forever: send instead.
  if (mode === 'weekly' && settings.weekly_summary) return { send: false, reason: 'weekly' };
  if (facts.recentDuplicate) return { send: false, reason: 'duplicate' };
  return { send: true };
}

interface PendingRow {
  id: string;
  organization_id: string;
  channel_id: string;
  event_id: string;
  created_at: Date;
  type: string;
  severity: string;
  device_id: string | null;
  actions: NotificationAction[] | null;
  settings: CalmSettings | null;
  site_tz: string | null;
}

const SETTINGS_JSON = `CASE WHEN s.organization_id IS NULL THEN NULL ELSE jsonb_build_object(
    'info_mode', s.info_mode, 'warning_mode', s.warning_mode, 'dedup_minutes', s.dedup_minutes,
    'quiet_enabled', s.quiet_enabled, 'quiet_start', s.quiet_start::text, 'quiet_end', s.quiet_end::text,
    'timezone', s.timezone, 'weekly_summary', s.weekly_summary, 'weekly_day', s.weekly_day,
    'weekly_hour', s.weekly_hour, 'last_weekly_at', s.last_weekly_at) END`;

const FIRST_SITE_TZ = (org: string) => `(SELECT st.timezone FROM sites st WHERE st.organization_id = ${org} ORDER BY st.created_at LIMIT 1)`;

/** Only the 'open' links survive a hold: single-use tokens would be stale by the time a summary goes out. */
const openOnly = (actions: NotificationAction[] | null): NotificationAction[] | null => {
  const kept = Array.isArray(actions) ? actions.filter((a) => a?.kind === 'open').map(({ token: _t, ...a }) => a) : [];
  return kept.length ? kept : null;
};

/** Decide every delivery the policy has not looked at yet. Returns how many were sent on / held. */
export async function applyDeliveryPolicy(now = new Date()): Promise<{ passed: number; held: number }> {
  let passed = 0;
  let held = 0;
  await withSystem(async (db) => {
    const rows = (
      await db.query<PendingRow>(
        `SELECT d.id, d.organization_id, d.channel_id, d.event_id, d.created_at,
                e.type, e.severity, e.device_id,
                coalesce(d.actions, e.details -> 'actions') AS actions,
                ${SETTINGS_JSON} AS settings,
                ${FIRST_SITE_TZ('d.organization_id')} AS site_tz
           FROM notification_deliveries d
           JOIN network_events e ON e.id = d.event_id
           LEFT JOIN notification_settings s ON s.organization_id = d.organization_id
          WHERE d.policy_at IS NULL AND d.status = 'pending'
          ORDER BY d.created_at
          LIMIT 200
            FOR UPDATE OF d SKIP LOCKED`,
      )
    ).rows;
    for (const r of rows) {
      const settings = r.settings;
      const tz = validTimeZone(settings?.timezone) ?? validTimeZone(r.site_tz);
      const muted = !!(
        await db.query(
          `SELECT 1 FROM notification_mutes
            WHERE organization_id = $1 AND (until IS NULL OR until > $4)
              AND ((device_id = $2::uuid AND (event_type IS NULL OR event_type = $3)) OR (device_id IS NULL AND event_type = $3))
            LIMIT 1`,
          [r.organization_id, r.device_id, r.type, now],
        )
      ).rowCount;
      let recentDuplicate = false;
      if (settings && settings.dedup_minutes > 0 && r.device_id && r.severity !== 'critical') {
        recentDuplicate = !!(
          await db.query(
            `SELECT 1 FROM notification_deliveries d2 JOIN network_events e2 ON e2.id = d2.event_id
              WHERE d2.channel_id = $1 AND d2.id <> $2 AND d2.policy_at IS NOT NULL
                AND e2.device_id = $3 AND e2.type = $4
                AND d2.created_at > $5::timestamptz - make_interval(mins => $6) AND d2.created_at <= $5::timestamptz
              LIMIT 1`,
            [r.channel_id, r.id, r.device_id, r.type, r.created_at, settings.dedup_minutes],
          )
        ).rowCount;
      }
      const decision = decide(r, settings, { muted, quiet: settings ? quietActive(settings, now, tz) : false, recentDuplicate });
      if (decision.send) {
        await db.query(`UPDATE notification_deliveries SET policy_at = $2 WHERE id = $1`, [r.id, now]);
        passed++;
        continue;
      }
      await db.query(
        `INSERT INTO notification_holds (organization_id, channel_id, event_id, reason, actions, created_at, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (channel_id, event_id) DO NOTHING`,
        [
          r.organization_id,
          r.channel_id,
          r.event_id,
          decision.reason,
          JSON.stringify(openOnly(r.actions)),
          now,
          // Record-only reasons are never released into a quiet-hours summary.
          null,
        ],
      );
      await db.query(`DELETE FROM notification_deliveries WHERE id = $1`, [r.id]);
      held++;
    }
  });
  return { passed, held };
}

// ── Summaries ─────────────────────────────────────────────────────────────────

interface HeldItem {
  hold_id: string;
  channel_id: string;
  event_id: string;
  reason: HoldReason;
  severity: string;
  type: string;
  title: string;
  occurred_at: Date;
}

const MAX_LISTED = 15;

function formatWhen(d: Date, tz: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: validTimeZone(tz) ?? 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

/** The details of a summary event: counts first (what renderers show), then the listed items. */
export function summaryDetails(
  kind: 'quiet_hours' | 'weekly',
  items: readonly Pick<HeldItem, 'severity' | 'type' | 'title' | 'occurred_at'>[],
  counts: { muted: number; duplicate: number },
  period: { from: Date; to: Date },
  tz: string | null,
): Record<string, unknown> {
  const bySeverity = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
  const byType: Record<string, number> = {};
  for (const i of items) {
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byType[i.type] = (byType[i.type] ?? 0) + 1;
  }
  const sorted = [...items].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  return {
    summary: kind,
    held: items.length,
    warnings: bySeverity.warning,
    info: bySeverity.info,
    ...(kind === 'weekly' ? { muted: counts.muted, collapsed_repeats: counts.duplicate } : {}),
    items: sorted.slice(0, MAX_LISTED).map((i) => `${formatWhen(new Date(i.occurred_at), tz)} · ${i.title}`),
    ...(sorted.length > MAX_LISTED ? { more: sorted.length - MAX_LISTED } : {}),
    by_type: byType,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
  };
}

export function summaryTitle(kind: 'quiet_hours' | 'weekly', held: number, counts: { muted: number; duplicate: number }): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  if (kind === 'quiet_hours') return `While quiet hours were on: ${n(held, 'notification')}`;
  const extra = [counts.muted ? `${counts.muted} muted` : '', counts.duplicate ? `${n(counts.duplicate, 'repeat')} collapsed` : ''].filter(Boolean).join(', ');
  return `Weekly summary: ${n(held, 'notification')}${extra ? ` (${extra})` : ''}`;
}

/**
 * Turn held items of one organization into summary events: channels that held the same items share one
 * event (usually there is one). Marks the released holds. Returns the number of summary events.
 */
async function sendSummaries(
  db: Db,
  organizationId: string,
  kind: 'quiet_hours' | 'weekly',
  released: HeldItem[],
  recordOnly: HeldItem[],
  period: { from: Date; to: Date },
  tz: string | null,
  now: Date,
): Promise<number> {
  const channels = new Map<string, { items: HeldItem[]; muted: number; duplicate: number }>();
  const slot = (id: string) => {
    let c = channels.get(id);
    if (!c) channels.set(id, (c = { items: [], muted: 0, duplicate: 0 }));
    return c;
  };
  for (const h of released) slot(h.channel_id).items.push(h);
  for (const h of recordOnly) {
    const c = slot(h.channel_id);
    if (h.reason === 'muted') c.muted++;
    else if (h.reason === 'duplicate') c.duplicate++;
  }
  const groups = new Map<string, { channelIds: string[]; items: HeldItem[]; muted: number; duplicate: number }>();
  for (const [channelId, c] of channels) {
    const key = JSON.stringify([c.items.map((i) => i.event_id).sort(), c.muted, c.duplicate]);
    const g = groups.get(key);
    if (g) g.channelIds.push(channelId);
    else groups.set(key, { channelIds: [channelId], ...c });
  }
  let sent = 0;
  for (const g of groups.values()) {
    if (!g.items.length && !g.muted && !g.duplicate) continue;
    const counts = { muted: g.muted, duplicate: g.duplicate };
    const ev = await db.query<{ id: string }>(
      `INSERT INTO network_events (organization_id, type, severity, title, details, source, occurred_at)
       VALUES ($1,'notification_summary','info',$2,$3,'platform',$4) RETURNING id`,
      [organizationId, summaryTitle(kind, g.items.length, counts), JSON.stringify(summaryDetails(kind, g.items, counts, period, tz)), now],
    );
    await db.query(
      `INSERT INTO notification_deliveries (organization_id, channel_id, event_id, policy_at)
       SELECT organization_id, id, $2, $3 FROM notification_channels WHERE organization_id = $1 AND id = ANY($4) AND enabled
       ON CONFLICT DO NOTHING`,
      [organizationId, ev.rows[0]!.id, now, g.channelIds],
    );
    sent++;
  }
  if (released.length) {
    await db.query(`UPDATE notification_holds SET released_at = $2 WHERE id = ANY($1)`, [released.map((h) => h.hold_id), now]);
  }
  if (sent) await notifyRealtime(db, organizationId, 'events');
  return sent;
}

const HELD_SELECT = `
  SELECT h.id AS hold_id, h.channel_id, h.event_id, h.reason, e.severity, e.type, e.title, e.occurred_at
    FROM notification_holds h JOIN network_events e ON e.id = h.event_id`;

/** Send the quiet-hours summary once quiet hours end, and the weekly summary when it is due. */
export async function releaseCalmSummaries(now = new Date()): Promise<{ quiet: number; weekly: number }> {
  const out = { quiet: 0, weekly: 0 };
  const orgs = await withSystem(
    async (db) =>
      (
        await db.query<{ organization_id: string; settings: CalmSettings; site_tz: string | null; quiet_open: boolean }>(
          `SELECT s.organization_id, ${SETTINGS_JSON} AS settings, ${FIRST_SITE_TZ('s.organization_id')} AS site_tz,
                  EXISTS (SELECT 1 FROM notification_holds h WHERE h.organization_id = s.organization_id AND h.reason = 'quiet' AND h.released_at IS NULL) AS quiet_open
             FROM notification_settings s`,
        )
      ).rows,
  );
  for (const o of orgs) {
    const s = { ...o.settings, last_weekly_at: new Date(o.settings.last_weekly_at) };
    const tz = validTimeZone(s.timezone) ?? validTimeZone(o.site_tz);
    try {
      if (o.quiet_open && !quietActive(s, now, tz)) {
        out.quiet += await withSystem(async (db) => {
          const held = (
            await db.query<HeldItem>(`${HELD_SELECT} WHERE h.organization_id = $1 AND h.reason = 'quiet' AND h.released_at IS NULL FOR UPDATE OF h SKIP LOCKED`, [o.organization_id])
          ).rows;
          if (!held.length) return 0;
          const from = new Date(Math.min(...held.map((h) => new Date(h.occurred_at).getTime())));
          return sendSummaries(db, o.organization_id, 'quiet_hours', held, [], { from, to: now }, tz, now);
        });
      }
      if (weeklyDue(s, now, tz)) {
        out.weekly += await withSystem(async (db) => {
          // Claim the week first so two servers never send it twice.
          const claimed = await db.query(
            `UPDATE notification_settings SET last_weekly_at = $2 WHERE organization_id = $1 AND date_trunc('milliseconds', last_weekly_at) = $3`,
            [o.organization_id, now, s.last_weekly_at],
          );
          if (!claimed.rowCount) return 0;
          const weekly = (
            await db.query<HeldItem>(`${HELD_SELECT} WHERE h.organization_id = $1 AND h.reason = 'weekly' AND h.released_at IS NULL`, [o.organization_id])
          ).rows;
          const recordOnly = (
            await db.query<HeldItem>(`${HELD_SELECT} WHERE h.organization_id = $1 AND h.reason IN ('muted', 'duplicate') AND h.created_at > $2`, [
              o.organization_id,
              s.last_weekly_at,
            ])
          ).rows;
          return sendSummaries(db, o.organization_id, 'weekly', weekly, recordOnly, { from: s.last_weekly_at, to: now }, tz, now);
        });
      }
    } catch (err) {
      logger.warn({ organization_id: o.organization_id, err: err instanceof Error ? err.message : String(err) }, 'calm alert summary failed');
    }
  }
  return out;
}
