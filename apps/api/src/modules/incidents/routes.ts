import { Router } from 'express';
import { z } from 'zod';
import type { DoctorReport, Incident, IncidentActivity, IncidentDetail, Member, NetworkEvent } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import { addActivity, rediagnose } from '../correlation/index.ts';
import { diagnoseSiteNetwork, diagnoseSmartChecks } from '../doctor/index.ts';
import { EVENT_SELECT } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { INCIDENT_SELECT } from './queries.ts';

export const incidentsRouter: Router = Router();

const REPLAY_MARGIN_MS = 30 * 60_000;

incidentsRouter.get('/incidents', async (req, res) => {
  const ctx = auth(req);
  const q = parse(
    z.object({
      status: z.enum(['active', 'resolved', 'all']).default('all'),
      site_id: z.uuid().optional(),
      // The device card's Watch action: incidents opened for this device or that took in one of its events.
      device_id: z.uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(25),
    }),
    req.query,
  );
  const result = await withTenant(ctx.organizationId, (db) =>
    db.query<Incident & { total: string }>(
      `${INCIDENT_SELECT.replace('SELECT i.id', 'SELECT count(*) OVER() AS total, i.id')}
        WHERE ($1::uuid IS NULL OR i.site_id = $1)
          AND ($2 = 'all' OR ($2 = 'active') = (i.status <> 'resolved'))
          AND ($5::uuid IS NULL OR i.device_id = $5 OR EXISTS (
                SELECT 1 FROM incident_events ie JOIN network_events ne ON ne.id = ie.event_id
                 WHERE ie.incident_id = i.id AND ne.device_id = $5))
        ORDER BY (i.status = 'resolved'), array_position(ARRAY['critical','warning','info'], i.severity), i.opened_at DESC
        LIMIT $3 OFFSET $4`,
      [q.site_id ?? null, q.status, q.page_size, (q.page - 1) * q.page_size, q.device_id ?? null],
    ),
  );
  res.json({ items: result.rows.map(({ total: _t, ...i }) => i), total: Number(result.rows[0]?.total ?? 0), page: q.page, page_size: q.page_size });
});

async function loadDetail(db: Db, id: string): Promise<IncidentDetail> {
  const base = (
    await db.query<Incident & Pick<IncidentDetail, 'check_id' | 'device_id' | 'collector_id' | 'diagnosis' | 'diagnosed_at'>>(
      `${INCIDENT_SELECT.replace('FROM incidents i', ', i.check_id, i.device_id, i.collector_id, i.diagnosis, i.diagnosed_at FROM incidents i')} WHERE i.id = $1`,
      [id],
    )
  ).rows[0];
  if (!base) throw notFound('Incident');
  const activity = await db.query<IncidentActivity>(`SELECT id, kind, user_name, body, created_at FROM incident_activity WHERE incident_id = $1 ORDER BY created_at, id`, [id]);
  // Replay window: what happened at the site before, during and after the incident.
  const opened = new Date(base.opened_at);
  const ended = base.resolved_at ? new Date(base.resolved_at) : new Date();
  const from = new Date(opened.getTime() - REPLAY_MARGIN_MS);
  const to = new Date(ended.getTime() + REPLAY_MARGIN_MS);
  const events = await db.query<NetworkEvent & { linked: boolean }>(
    `${EVENT_SELECT.replace('FROM network_events e', ', EXISTS (SELECT 1 FROM incident_events ie WHERE ie.incident_id = $1 AND ie.event_id = e.id) AS linked FROM network_events e')}
      WHERE e.occurred_at BETWEEN $2 AND $3
        AND (e.site_id IS NOT DISTINCT FROM $4 OR EXISTS (SELECT 1 FROM incident_events ie WHERE ie.incident_id = $1 AND ie.event_id = e.id))
      ORDER BY e.occurred_at, e.id LIMIT 500`,
    [id, from, to, base.site_id],
  );
  return {
    ...base,
    activity: activity.rows,
    window: { from: from.toISOString(), to: to.toISOString() },
    timeline: events.rows.map((e) => {
      const at = new Date(e.occurred_at).getTime();
      return { ...e, phase: at < opened.getTime() ? 'before' : base.resolved_at && at > ended.getTime() ? 'after' : 'during' };
    }),
  };
}

incidentsRouter.get('/incidents/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await withTenant(ctx.organizationId, (db) => loadDetail(db, id)));
});

async function actor(userId: string): Promise<{ id: string; name: string }> {
  const row = await systemPool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return { id: userId, name: row.rows[0]?.display_name ?? 'Unknown user' };
}

/** Members of the caller's organization (for assignment). Explicitly scoped; reads the identity table. */
incidentsRouter.get('/members', async (req, res) => {
  const ctx = auth(req);
  const rows = await systemPool.query<Member>(
    `SELECT u.id, u.display_name, u.email, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.status = 'active'
      ORDER BY u.display_name`,
    [ctx.organizationId],
  );
  res.json({ items: rows.rows });
});

incidentsRouter.post('/incidents/:id/acknowledge', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const who = await actor(ctx.userId);
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1 AND status = 'open'`, [id]);
    if (!updated.rowCount) throw new AppError(409, 'not_open', 'Only an open incident can be acknowledged');
    await addActivity(db, ctx.organizationId, id, 'acknowledged', 'Acknowledged', new Date(), who);
    await audit(db, req, 'incident.acknowledged', { type: 'incident', id });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.json({ ok: true });
});

incidentsRouter.post('/incidents/:id/resolve', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ note: z.string().trim().min(3, 'Describe what fixed it (at least 3 characters)').max(2000) }), req.body);
  const who = await actor(ctx.userId);
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE incidents SET status = 'resolved', resolved_at = now(), resolution_kind = 'manual', resolution_note = $2 WHERE id = $1 AND status <> 'resolved'`,
      [id, body.note],
    );
    if (!updated.rowCount) throw new AppError(409, 'already_resolved', 'This incident is already resolved');
    await addActivity(db, ctx.organizationId, id, 'resolved', `Resolved: ${body.note}`, new Date(), who);
    await audit(db, req, 'incident.resolved', { type: 'incident', id });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.json({ ok: true });
});

/** The resolution note of an incident (also auto-resolved ones) can be completed later: it is what future diagnoses cite. */
incidentsRouter.patch('/incidents/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ assigned_to: z.uuid().nullable().optional(), resolution_note: z.string().trim().min(3).max(2000).optional() }).strict(), req.body);
  const who = await actor(ctx.userId);
  let assignee: { id: string; display_name: string } | null = null;
  if (body.assigned_to) {
    // Only members of this organization can be assigned.
    const member = await systemPool.query<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.id = $2 AND m.status = 'active'`,
      [ctx.organizationId, body.assigned_to],
    );
    assignee = member.rows[0] ?? null;
    if (!assignee) throw new AppError(400, 'not_a_member', 'That user is not a member of this organization');
  }
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM incidents WHERE id = $1`, [id])).rowCount) throw notFound('Incident');
    if (body.assigned_to !== undefined) {
      await db.query(`UPDATE incidents SET assigned_to = $2, assigned_to_name = $3 WHERE id = $1`, [id, assignee?.id ?? null, assignee?.display_name ?? null]);
      await addActivity(db, ctx.organizationId, id, 'assigned', assignee ? `Assigned to ${assignee.display_name}` : 'Unassigned', new Date(), who);
    }
    if (body.resolution_note !== undefined) {
      const updated = await db.query(`UPDATE incidents SET resolution_note = $2 WHERE id = $1 AND status = 'resolved'`, [id, body.resolution_note]);
      if (!updated.rowCount) throw new AppError(409, 'not_resolved', 'A resolution note can only be set on a resolved incident');
      await addActivity(db, ctx.organizationId, id, 'comment', `Resolution note updated: ${body.resolution_note}`, new Date(), who);
    }
    await audit(db, req, 'incident.updated', { type: 'incident', id }, { fields: Object.keys(body) });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.json({ ok: true });
});

incidentsRouter.post('/incidents/:id/comments', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const who = await actor(ctx.userId);
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM incidents WHERE id = $1`, [id])).rowCount) throw notFound('Incident');
    await addActivity(db, ctx.organizationId, id, 'comment', body.body, new Date(), who);
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.status(201).json({ ok: true });
});

incidentsRouter.post('/incidents/:id/diagnose', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const row = (
      await db.query<{ id: string; kind: 'network' | 'service' | 'collector' | 'device'; site_id: string | null; check_id: string | null; device_id: string | null; collector_id: string | null; opened_at: Date; resolved_at: Date | null; status: string }>(
        `SELECT id, kind, site_id, check_id, device_id, collector_id, opened_at, resolved_at, status FROM incidents WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw notFound('Incident');
    // A resolved incident keeps the diagnosis of the fault; re-running now would describe a healthy network.
    if (row.status === 'resolved') throw new AppError(409, 'already_resolved', 'The diagnosis of a resolved incident is kept as it was during the fault');
    await rediagnose(db, ctx.organizationId, row);
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.json({ ok: true });
});

// ── Network Doctor: live diagnosis of each site's network path, incident or not ──

incidentsRouter.get('/doctor', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const reports = await withTenant(ctx.organizationId, async (db) => {
    const sites = await db.query<{ id: string; name: string; collectors_online: number }>(
      `SELECT s.id, s.name,
              (SELECT count(*) FROM collectors c WHERE c.site_id = s.id AND c.status = 'active' AND c.connection_state = 'online')::int AS collectors_online
         FROM sites s WHERE ($1::uuid IS NULL OR s.id = $1) ORDER BY s.name`,
      [q.site_id ?? null],
    );
    const out: DoctorReport[] = [];
    for (const site of sites.rows) {
      const active = await db.query<{ id: string; number: number }>(`SELECT id, number FROM incidents WHERE correlation_key = $1 AND status <> 'resolved'`, [`site:${site.id}:network`]);
      out.push({
        site_id: site.id,
        site_name: site.name,
        diagnosis: await diagnoseSiteNetwork(db, ctx.organizationId, site.id, active.rows[0]?.id ?? null),
        active_incident: active.rows[0] ?? null,
        collectors_online: site.collectors_online,
        // Smart checks (DHCP, Wi-Fi) that need attention; healthy and not-measured ones are left out.
        smart: await diagnoseSmartChecks(db, ctx.organizationId, site.id, new Date(), true),
      });
    }
    return out;
  });
  res.json({ items: reports });
});

/** Ask the site's collectors to run every check now instead of waiting for the next interval. */
incidentsRouter.post('/doctor/run-checks', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ site_id: z.uuid() }), req.body);
  const queued = await withTenant(ctx.organizationId, async (db) => {
    const collectors = await db.query<{ id: string }>(`SELECT id FROM collectors WHERE site_id = $1 AND status = 'active' AND connection_state = 'online'`, [body.site_id]);
    for (const c of collectors.rows) {
      const pending = await db.query(`SELECT 1 FROM collector_commands WHERE collector_id = $1 AND kind = 'run_checks' AND status <> 'completed'`, [c.id]);
      if (!pending.rowCount) await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, created_by) VALUES ($1,$2,'run_checks',$3)`, [ctx.organizationId, c.id, ctx.userId]);
    }
    if (collectors.rowCount) await audit(db, req, 'doctor.run_checks', { type: 'site', id: body.site_id });
    return collectors.rowCount ?? 0;
  });
  if (!queued) throw new AppError(409, 'no_collector_online', 'No collector at this site is currently reporting, so nothing can be measured');
  res.status(202).json({ ok: true, collectors: queued });
});
