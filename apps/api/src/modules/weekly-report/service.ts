import type { WeeklyReport } from '@nigafiy/shared-types';
import { type Db, withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { buildInsights, loadInsightFacts } from '../insights/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { type WeeklyFacts, weeklyEvents, weeklyImprovements, weeklyTitle } from './rules.ts';

/**
 * Weekly report: gathers the week's facts per organization (inside its tenant transaction), turns them
 * into lines with rules.ts, and stores one report per organization and local week. The `weekly-report`
 * job runs hourly; the UNIQUE (organization_id, week_start) row makes it idempotent across re-runs,
 * restarts and API instances. Sending it through the channels is opt-in (weekly_report_settings.notify).
 */

const validTz = (tz: string | null | undefined): string | null => {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

/** notification_settings.timezone, else the first site's, else UTC (same order as the calm alerts). */
export async function organizationTimezone(db: Db, organizationId: string): Promise<string> {
  const r = await db.query<{ tz: string | null; site_tz: string | null }>(
    `SELECT (SELECT timezone FROM notification_settings WHERE organization_id = $1) AS tz,
            (SELECT timezone FROM sites WHERE organization_id = $1 ORDER BY created_at LIMIT 1) AS site_tz`,
    [organizationId],
  );
  return validTz(r.rows[0]?.tz) ?? validTz(r.rows[0]?.site_tz) ?? 'UTC';
}

export interface Week {
  week_start: string;
  from: Date;
  to: Date;
}

/** The local week (Monday 00:00 in `tz`) containing `now` (offset 0) or the one before it (offset -1). */
export async function weekOf(db: Db, now: Date, tz: string, offset: 0 | -1): Promise<Week> {
  const r = await db.query<{ week_start: string; from: Date; to: Date }>(
    `SELECT to_char(w, 'YYYY-MM-DD') AS week_start, w AT TIME ZONE $2 AS "from", (w + interval '7 days') AT TIME ZONE $2 AS "to"
       FROM (SELECT date_trunc('week', $1::timestamptz AT TIME ZONE $2) + make_interval(days => 7 * $3::int) AS w) x`,
    [now, tz, offset],
  );
  return r.rows[0]!;
}

/** Merge overlapping gaps (an 'api' gap and its Sensor's 'collector' gap usually overlap), clipped to the period. */
export function mergeGaps(gaps: { started_at: Date; ended_at: Date }[], from: Date, to: Date): { from: Date; to: Date }[] {
  const merged: [number, number][] = [];
  const clipped = gaps
    .map((g) => [Math.max(g.started_at.getTime(), from.getTime()), Math.min(g.ended_at.getTime(), to.getTime())] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  for (const [s, e] of clipped) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => ({ from: new Date(s), to: new Date(e) }));
}

/** Everything the rules need for one week, read inside the organization's tenant transaction. */
export async function loadWeeklyFacts(db: Db, organizationId: string, week: Week, tz: string, now: Date): Promise<WeeklyFacts> {
  const end = week.to.getTime() < now.getTime() ? week.to : now;
  const incidents = await db.query<{ title: string; status: string; opened_at: Date; resolved_at: Date | null; domain: string | null }>(
    `SELECT title, status, opened_at, resolved_at, diagnosis ->> 'fault_domain' AS domain
       FROM incidents WHERE opened_at >= $1 AND opened_at < $2 ORDER BY opened_at`,
    [week.from, end],
  );
  const domainCount = new Map<string, number>();
  let longest: WeeklyFacts['incidents']['longest'] = null;
  for (const i of incidents.rows) {
    if (i.domain) domainCount.set(i.domain, (domainCount.get(i.domain) ?? 0) + 1);
    const open = i.status !== 'resolved' || !i.resolved_at;
    const seconds = Math.round(((open ? now : i.resolved_at!).getTime() - i.opened_at.getTime()) / 1000);
    if (!longest || seconds > longest.seconds) longest = { title: i.title, seconds, open };
  }
  const resolved = incidents.rows.filter((i) => i.status === 'resolved').length;

  const devices = await db.query<{ n: number; unreviewed: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE trust = 'unreviewed')::int AS unreviewed
       FROM devices WHERE first_seen_at >= $1 AND first_seen_at < $2`,
    [week.from, end],
  );
  const gapRows = await db.query<{ started_at: Date; ended_at: Date }>(
    `SELECT started_at, ended_at FROM monitoring_gaps WHERE ended_at > $1 AND started_at < $2`,
    [week.from, end],
  );
  const gaps = mergeGaps(gapRows.rows, week.from, end);
  const longestGap = gaps.reduce<{ from: Date; to: Date } | null>((best, g) => (!best || g.to.getTime() - g.from.getTime() > best.to.getTime() - best.from.getTime() ? g : best), null);

  const insights = buildInsights(await loadInsightFacts(db, organizationId, null));
  const previous = await db.query<{ score: number | null }>(
    `SELECT score FROM weekly_reports WHERE week_start < $1::date AND score IS NOT NULL ORDER BY week_start DESC LIMIT 1`,
    [week.week_start],
  );
  const hb = await db.query(`SELECT 1 FROM monitor_heartbeat LIMIT 1`);

  return {
    timezone: tz,
    score: insights.score,
    previousScore: previous.rows[0]?.score ?? null,
    incidents: {
      opened: incidents.rows.length,
      resolved,
      stillOpen: incidents.rows.length - resolved,
      longest,
      domains: [...domainCount].map(([domain, n]) => ({ domain, n })).sort((a, b) => b.n - a.n),
    },
    newDevices: { n: devices.rows[0]?.n ?? 0, unreviewed: devices.rows[0]?.unreviewed ?? 0 },
    gaps: { n: gaps.length, totalSeconds: Math.round(gaps.reduce((s, g) => s + (g.to.getTime() - g.from.getTime()), 0) / 1000), longest: longestGap },
    insights: insights.insights,
    heartbeatConfigured: !!hb.rowCount,
  };
}

interface ReportRow {
  id: string;
  week_start: string;
  period_from: Date;
  period_to: Date;
  timezone: string;
  score: number | null;
  previous_score: number | null;
  events: WeeklyReport['events'];
  improvements: WeeklyReport['improvements'];
  notified_at: Date | null;
  created_at: Date;
}

export const REPORT_SELECT = `SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, period_from, period_to, timezone, score, previous_score,
       events, improvements, notified_at, created_at FROM weekly_reports`;

export function reportView(r: ReportRow): WeeklyReport {
  return {
    id: r.id,
    week_start: r.week_start,
    period_from: r.period_from.toISOString(),
    period_to: r.period_to.toISOString(),
    timezone: r.timezone,
    final: true,
    score: r.score,
    previous_score: r.previous_score,
    events: r.events,
    improvements: r.improvements,
    notified_at: r.notified_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

/** "This week so far": the same rules over the current, unfinished week. Not stored. */
export async function currentWeekPreview(organizationId: string, now = new Date()): Promise<WeeklyReport> {
  return withTenant(organizationId, async (db) => {
    const tz = await organizationTimezone(db, organizationId);
    const week = await weekOf(db, now, tz, 0);
    const facts = await loadWeeklyFacts(db, organizationId, week, tz, now);
    return {
      id: null,
      week_start: week.week_start,
      period_from: week.from.toISOString(),
      period_to: now.toISOString(),
      timezone: tz,
      final: false,
      score: facts.score,
      previous_score: facts.previousScore,
      events: weeklyEvents(facts),
      improvements: weeklyImprovements(facts),
      notified_at: null,
      created_at: null,
    };
  });
}

/** Lines for a channel message: at most six are shown, so the first four events and the top improvement. */
function notificationDetails(week: string, events: WeeklyReport['events'], improvements: WeeklyReport['improvements']): Record<string, unknown> {
  const d: Record<string, unknown> = { week };
  for (const e of events.slice(0, 4)) d[e.code] = e.text;
  if (improvements[0]) d.next_week = improvements[0].text;
  return d;
}

/**
 * The `weekly-report` job: for every organization with a Sensor enrolled before the week ended, store
 * the report of the last finished local week if it is not there yet; send it when the user asked.
 * Returns how many reports were made.
 */
export async function generateWeeklyReports(now = new Date()): Promise<number> {
  const orgs = (
    await withSystem((db) =>
      db.query<{ organization_id: string }>(`SELECT DISTINCT organization_id FROM collectors WHERE status = 'active' ORDER BY organization_id`),
    )
  ).rows;
  let made = 0;
  for (const { organization_id: org } of orgs) {
    try {
      if (await generateWeeklyReport(org, now)) made++;
    } catch (err) {
      // One organization's failure must not stop the others; the next hourly run tries again.
      logger.error({ err, organization_id: org }, 'weekly report failed');
    }
  }
  return made;
}

/** One organization: the last finished week's report, once. Returns true when it was made now. */
export async function generateWeeklyReport(organizationId: string, now = new Date()): Promise<boolean> {
  const prepared = await withTenant(organizationId, async (db) => {
    const tz = await organizationTimezone(db, organizationId);
    const week = await weekOf(db, now, tz, -1);
    const exists = await db.query(`SELECT 1 FROM weekly_reports WHERE week_start = $1::date`, [week.week_start]);
    if (exists.rowCount) return null;
    // Nothing was being watched in that week: no report.
    const watched = await db.query(`SELECT 1 FROM collectors WHERE status = 'active' AND created_at < $1 LIMIT 1`, [week.to]);
    if (!watched.rowCount) return null;
    const facts = await loadWeeklyFacts(db, organizationId, week, tz, now);
    const notify = (await db.query<{ notify: boolean }>(`SELECT notify FROM weekly_report_settings`)).rows[0]?.notify ?? false;
    return { tz, week, facts, notify, events: weeklyEvents(facts), improvements: weeklyImprovements(facts) };
  });
  if (!prepared) return false;
  const { tz, week, facts, notify, events, improvements } = prepared;

  // The owner connection writes the row (lan_app may only read reports); ON CONFLICT keeps it to one per week.
  return withSystem(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO weekly_reports (organization_id, week_start, period_from, period_to, timezone, score, previous_score, events, improvements)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, week_start) DO NOTHING RETURNING id`,
      [organizationId, week.week_start, week.from, week.to, tz, facts.score, facts.previousScore, JSON.stringify(events), JSON.stringify(improvements)],
    );
    const id = inserted.rows[0]?.id;
    if (!id) return false;
    if (notify) {
      const channels = await db.query<{ id: string }>(`SELECT id FROM notification_channels WHERE organization_id = $1 AND enabled`, [organizationId]);
      if (channels.rowCount) {
        const ev = await db.query<{ id: string }>(
          `INSERT INTO network_events (organization_id, type, severity, title, details, source, occurred_at)
           VALUES ($1, 'weekly_report', 'info', $2, $3, 'platform', $4) RETURNING id`,
          [organizationId, weeklyTitle(facts), JSON.stringify(notificationDetails(week.week_start, events, improvements)), now],
        );
        // policy_at set: the report is the summary itself, the calm-alert policy must not hold it again.
        await db.query(
          `INSERT INTO notification_deliveries (organization_id, channel_id, event_id, policy_at)
           SELECT $1, id, $2, $3 FROM notification_channels WHERE organization_id = $1 AND enabled
           ON CONFLICT DO NOTHING`,
          [organizationId, ev.rows[0]!.id, now],
        );
        await db.query(`UPDATE weekly_reports SET notified_at = $2 WHERE id = $1`, [id, now]);
        await notifyRealtime(db, organizationId, 'events');
      }
    }
    return true;
  });
}
