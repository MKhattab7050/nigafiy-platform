import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { validTimeZone } from './policy.ts';

// Calm alerts (UX review 2026-11-26 item 12): settings, mutes and the record of held notifications.

export const calmRouter: Router = Router();

/** What a new organization gets (the migration's trigger); shown as the starting point for older ones. */
export const CALM_DEFAULTS = {
  info_mode: 'weekly',
  warning_mode: 'immediate',
  dedup_minutes: 30,
  quiet_enabled: false,
  quiet_start: '22:00',
  quiet_end: '07:00',
  timezone: null,
  weekly_summary: true,
  weekly_day: 0,
  weekly_hour: 9,
} as const;

const SETTINGS_SELECT = `SELECT info_mode, warning_mode, dedup_minutes, quiet_enabled,
  to_char(quiet_start, 'HH24:MI') AS quiet_start, to_char(quiet_end, 'HH24:MI') AS quiet_end,
  timezone, weekly_summary, weekly_day, weekly_hour, last_weekly_at, updated_at FROM notification_settings`;

const MUTE_SELECT = `SELECT m.id, m.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS device_label,
  m.event_type, m.until, m.created_at FROM notification_mutes m LEFT JOIN devices d ON d.id = m.device_id`;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const settingsInput = z
  .object({
    info_mode: z.enum(['immediate', 'weekly']),
    warning_mode: z.enum(['immediate', 'weekly']),
    dedup_minutes: z.number().int().min(0).max(1440),
    quiet_enabled: z.boolean(),
    quiet_start: hhmm,
    quiet_end: hhmm,
    timezone: z.string().trim().min(1).max(64).nullable(),
    weekly_summary: z.boolean(),
    weekly_day: z.number().int().min(0).max(6),
    weekly_hour: z.number().int().min(0).max(23),
  })
  .strict();

calmRouter.get('/notifications/calm', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const out = await withTenant(ctx.organizationId, async (db) => {
    const row = (await db.query(SETTINGS_SELECT)).rows[0] ?? null;
    const siteTz = (await db.query<{ timezone: string }>(`SELECT timezone FROM sites ORDER BY created_at LIMIT 1`)).rows[0]?.timezone ?? null;
    const holds = (
      await db.query(
        `SELECT h.id, h.reason, h.created_at, h.released_at, c.name AS channel_name,
                e.id AS event_id, e.type, e.severity, e.title, e.device_id
           FROM notification_holds h JOIN network_events e ON e.id = h.event_id JOIN notification_channels c ON c.id = h.channel_id
          ORDER BY h.created_at DESC LIMIT 50`,
      )
    ).rows;
    const waiting = (
      await db.query<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM notification_holds WHERE released_at IS NULL AND reason IN ('quiet', 'weekly') GROUP BY reason`,
      )
    ).rows;
    return {
      // null: this organization predates calm alerts and keeps the old behaviour until settings are saved.
      settings: row,
      defaults: CALM_DEFAULTS,
      effective_timezone: validTimeZone(row?.timezone) ?? validTimeZone(siteTz) ?? 'UTC',
      waiting: Object.fromEntries(waiting.map((w) => [w.reason, w.n])),
      recent_holds: holds,
    };
  });
  res.json(out);
});

calmRouter.put('/notifications/calm', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(settingsInput, req.body);
  if (body.timezone !== null && !validTimeZone(body.timezone)) {
    throw new AppError(400, 'validation_error', 'Unknown time zone', [{ path: 'timezone', message: 'Unknown time zone' }]);
  }
  const row = await withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `INSERT INTO notification_settings (organization_id, info_mode, warning_mode, dedup_minutes, quiet_enabled, quiet_start, quiet_end,
                                          timezone, weekly_summary, weekly_day, weekly_hour, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (organization_id) DO UPDATE SET
         info_mode = EXCLUDED.info_mode, warning_mode = EXCLUDED.warning_mode, dedup_minutes = EXCLUDED.dedup_minutes,
         quiet_enabled = EXCLUDED.quiet_enabled, quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
         timezone = EXCLUDED.timezone, weekly_summary = EXCLUDED.weekly_summary, weekly_day = EXCLUDED.weekly_day,
         weekly_hour = EXCLUDED.weekly_hour, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [
        ctx.organizationId,
        body.info_mode,
        body.warning_mode,
        body.dedup_minutes,
        body.quiet_enabled,
        body.quiet_start,
        body.quiet_end,
        body.timezone,
        body.weekly_summary,
        body.weekly_day,
        body.weekly_hour,
        ctx.userId,
      ],
    );
    await audit(db, req, 'notification_settings.updated', { type: 'organization', id: ctx.organizationId }, body);
    return (await db.query(SETTINGS_SELECT)).rows[0];
  });
  res.json({ settings: row });
});

// ── Mutes ─────────────────────────────────────────────────────────────────────

const muteInput = z
  .object({
    device_id: z.uuid().nullable().default(null),
    event_type: z
      .string()
      .regex(/^[a-z0-9_]{1,60}$/)
      .nullable()
      .default(null),
    /** How long; null = until removed. */
    minutes: z.number().int().min(5).max(366 * 24 * 60).nullable().default(null),
  })
  .strict()
  .refine((v) => v.device_id !== null || v.event_type !== null, { message: 'Choose a device, an event type, or both', path: ['device_id'] });

calmRouter.get('/notifications/mutes', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const rows = await withTenant(ctx.organizationId, (db) => db.query(`${MUTE_SELECT} WHERE m.until IS NULL OR m.until > now() ORDER BY m.created_at DESC`));
  res.json({ items: rows.rows });
});

calmRouter.post('/notifications/mutes', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(muteInput, req.body);
  const row = await withTenant(ctx.organizationId, async (db) => {
    if (body.device_id && !(await db.query(`SELECT 1 FROM devices WHERE id = $1`, [body.device_id])).rowCount) throw notFound('Device');
    // The same subject muted again: extend or shorten the existing mute instead of stacking rows.
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM notification_mutes WHERE device_id IS NOT DISTINCT FROM $1::uuid AND event_type IS NOT DISTINCT FROM $2::text LIMIT 1`,
      [body.device_id, body.event_type],
    );
    const until = body.minutes === null ? null : new Date(Date.now() + body.minutes * 60_000);
    let id: string;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      await db.query(`UPDATE notification_mutes SET until = $2, created_by = $3, created_at = now() WHERE id = $1`, [id, until, ctx.userId]);
    } else {
      id = (
        await db.query<{ id: string }>(
          `INSERT INTO notification_mutes (organization_id, device_id, event_type, until, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [ctx.organizationId, body.device_id, body.event_type, until, ctx.userId],
        )
      ).rows[0]!.id;
    }
    await audit(db, req, 'notification_mute.set', { type: body.device_id ? 'device' : 'organization', id: body.device_id ?? ctx.organizationId }, {
      event_type: body.event_type,
      until,
    });
    return (await db.query(`${MUTE_SELECT} WHERE m.id = $1`, [id])).rows[0];
  });
  res.status(201).json(row);
});

calmRouter.delete('/notifications/mutes/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const gone = await db.query<{ device_id: string | null; event_type: string | null }>(`DELETE FROM notification_mutes WHERE id = $1 RETURNING device_id, event_type`, [id]);
    if (!gone.rows[0]) throw notFound('Mute');
    await audit(db, req, 'notification_mute.removed', { type: gone.rows[0].device_id ? 'device' : 'organization', id: gone.rows[0].device_id ?? ctx.organizationId }, {
      event_type: gone.rows[0].event_type,
    });
  });
  res.status(204).end();
});
