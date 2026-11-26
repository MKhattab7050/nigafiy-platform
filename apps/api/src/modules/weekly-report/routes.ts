import type { WeeklyReportsView } from '@nigafiy/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { auth, notFound, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { REPORT_SELECT, currentWeekPreview, reportView } from './service.ts';

export const weeklyReportRouter: Router = Router();

/** The latest stored report, the list of weeks (newest first), the notify setting and how many channels it would reach. */
weeklyReportRouter.get('/reports/weekly', async (req, res) => {
  const ctx = auth(req);
  const view = await withTenant(ctx.organizationId, async (db): Promise<WeeklyReportsView> => {
    const latest = await db.query(`${REPORT_SELECT} ORDER BY week_start DESC LIMIT 1`);
    const list = await db.query<{ week_start: string; score: number | null; created_at: Date }>(
      `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, score, created_at FROM weekly_reports ORDER BY week_start DESC LIMIT 26`,
    );
    const settings = await db.query<{ notify: boolean }>(`SELECT notify FROM weekly_report_settings`);
    const channels = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_channels WHERE enabled`);
    return {
      reports: list.rows.map((r) => ({ week_start: r.week_start, score: r.score, created_at: r.created_at.toISOString() })),
      latest: latest.rows[0] ? reportView(latest.rows[0]) : null,
      settings: { notify: settings.rows[0]?.notify ?? false },
      channels: channels.rows[0]?.n ?? 0,
    };
  });
  res.json(view);
});

/** This week so far (worked out now, not stored). */
weeklyReportRouter.get('/reports/weekly/current', async (req, res) => {
  const ctx = auth(req);
  res.json(await currentWeekPreview(ctx.organizationId));
});

weeklyReportRouter.get('/reports/weekly/:week', async (req, res) => {
  const ctx = auth(req);
  const { week } = parse(z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.params);
  const row = await withTenant(ctx.organizationId, (db) => db.query(`${REPORT_SELECT} WHERE week_start = $1::date`, [week]));
  if (!row.rows[0]) throw notFound('Weekly report');
  res.json(reportView(row.rows[0]));
});

/** Also send the report through the notification channels (off by default). */
weeklyReportRouter.put('/reports/weekly/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ notify: z.boolean() }), req.body);
  await withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `INSERT INTO weekly_report_settings (organization_id, notify, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (organization_id) DO UPDATE SET notify = EXCLUDED.notify, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.organizationId, body.notify, ctx.userId],
    );
    await audit(db, req, 'weekly_report.settings', { type: 'organization', id: ctx.organizationId }, { notify: body.notify });
  });
  res.json({ notify: body.notify });
});
