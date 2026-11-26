import { Router } from 'express';
import { z } from 'zod';
import type { DashboardGuidance, GuidanceStep } from '@nigafiy/shared-types';
import { auth, parse } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const guidanceRouter: Router = Router();

/**
 * Event types that count as "a report reached you": the calm-alerts summary (notifications/policy.ts)
 * and a weekly report event, should one be added under that name.
 */
const REPORT_EVENTS = ['notification_summary', 'weekly_report'];

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * GET /dashboard/guidance: getting-started progress and the facts behind the dashboard numbers.
 *
 * Nothing here is stored by hand. Each step is read from what already happened:
 *  - installed: the account exists (this request is proof), dated by its first site
 *  - scanned:   a discovery sweep finished
 *  - reviewed:  devices exist and none is still "unreviewed"
 *  - alerts:    an enabled alert channel that can actually deliver (a Telegram channel needs a chat id
 *               or a linked chat, a push channel needs a subscribed browser)
 *  - report:    a summary was sent at least once
 */
guidanceRouter.get('/dashboard/guidance', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const site = site_id ?? null;

  const body = await withTenant(ctx.organizationId, async (db): Promise<DashboardGuidance> => {
    const sites = await db.query<{ first_at: Date | null; interval: number | null }>(
      `SELECT min(created_at) AS first_at, min(discovery_interval_seconds)::int AS interval
         FROM sites WHERE ($1::uuid IS NULL OR id = $1)`,
      [site],
    );
    const sweeps = await db.query<{ first_at: Date | null; last_at: Date | null; day: number }>(
      `SELECT min(finished_at) AS first_at, max(finished_at) AS last_at,
              count(*) FILTER (WHERE finished_at > now() - interval '24 hours')::int AS day
         FROM discovery_runs WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    const devices = await db.query<{ total: number; unreviewed: number; untyped: number; reviewed_at: Date | null }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE trust = 'unreviewed')::int AS unreviewed,
              count(*) FILTER (WHERE device_type = 'unknown' OR type_confidence = 'low')::int AS untyped,
              max(trust_changed_at) AS reviewed_at
         FROM devices WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    // Alert channels belong to the organization, not to a site.
    const channels = await db.query<{ n: number; first_at: Date | null }>(
      `SELECT count(*)::int AS n, min(c.created_at) AS first_at
         FROM notification_channels c
        WHERE c.enabled
          AND (c.kind NOT IN ('telegram', 'push')
               OR (c.kind = 'telegram' AND c.config ? 'chat_id')
               OR EXISTS (SELECT 1 FROM telegram_chats t WHERE t.channel_id = c.id)
               OR EXISTS (SELECT 1 FROM webpush_subscriptions w WHERE w.channel_id = c.id))`,
    );
    const report = await db.query<{ first_at: Date | null }>(
      `SELECT min(occurred_at) AS first_at FROM network_events WHERE type = ANY($1)`,
      [REPORT_EVENTS],
    );
    const settings = await db.query<{ weekly_summary: boolean }>(`SELECT weekly_summary FROM notification_settings LIMIT 1`);

    const s = sites.rows[0]!;
    const w = sweeps.rows[0]!;
    const d = devices.rows[0]!;
    const c = channels.rows[0]!;
    const steps: GuidanceStep[] = [
      { key: 'installed', done: true, at: iso(s.first_at) },
      { key: 'scanned', done: w.first_at !== null, at: iso(w.first_at) },
      { key: 'reviewed', done: d.total > 0 && d.unreviewed === 0, at: d.total > 0 && d.unreviewed === 0 ? iso(d.reviewed_at) : null },
      { key: 'alerts', done: c.n > 0, at: iso(c.first_at) },
      { key: 'report', done: report.rows[0]!.first_at !== null, at: iso(report.rows[0]!.first_at) },
    ];
    return {
      generated_at: new Date().toISOString(),
      steps,
      complete: steps.every((x) => x.done),
      facts: {
        devices_total: d.total,
        devices_unreviewed: d.unreviewed,
        devices_untyped: d.untyped,
        last_sweep_at: iso(w.last_at),
        sweeps_24h: w.day,
        sweep_interval_seconds: s.interval,
        alert_channels: c.n,
        // Settings are created with the organization (058_calm_alerts.sql); no row reads as the default.
        weekly_summary: settings.rows[0]?.weekly_summary ?? true,
      },
    };
  });
  res.json(body);
});
