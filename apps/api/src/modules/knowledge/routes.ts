import { Router } from 'express';
import type { KnowledgeDetail, KnowledgeList, KnowledgeRevision, KnowledgeUse, Role } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, auth, forbidden, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import { addActivity } from '../correlation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { ENTRY_SELECT, type EntryRow, addRevision, formatEntry, loadEntry } from './repo.ts';
import { type KnowledgeCreate, createSchema, listQuery, patchSchema, suggestQuery, useParams, useSchema, voteSchema } from './schema.ts';
import { suggest } from './suggest.ts';

export const knowledgeRouter: Router = Router();

const RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };
const atLeast = (ctx: AuthContext, min: Role) => RANK[ctx.role] >= RANK[min];

/** Viewers read published knowledge only; candidates and drafts are work in progress of technicians. */
const visibleStatuses = (ctx: AuthContext) => (atLeast(ctx, 'technician') ? ['candidate', 'draft', 'published', 'discarded'] : ['published']);

async function actor(userId: string): Promise<{ id: string; name: string }> {
  const row = await systemPool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return { id: userId, name: row.rows[0]?.display_name ?? 'Unknown user' };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

async function requireEntry(db: Db, id: string): Promise<{ id: string; status: string; source: string; revision: number; title: string; fix_steps: string; cause: string }> {
  const row = (await db.query<{ id: string; status: string; source: string; revision: number; title: string; fix_steps: string; cause: string }>(
    `SELECT id, status, source, revision, title, fix_steps, cause FROM knowledge_entries WHERE id = $1 FOR UPDATE`,
    [id],
  )).rows[0];
  if (!row) throw notFound('Knowledge entry');
  return row;
}

/** Linked site / device / check must exist in this organization (RLS hides other tenants' rows). */
async function checkLinks(db: Db, body: Partial<Pick<KnowledgeCreate, 'site_id' | 'device_id' | 'check_id'>>): Promise<void> {
  const probes: [string | null | undefined, string, string][] = [
    [body.site_id, 'sites', 'site_id'],
    [body.device_id, 'devices', 'device_id'],
    [body.check_id, 'monitoring_checks', 'check_id'],
  ];
  for (const [value, table, field] of probes) {
    if (value && !(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [value])).rowCount) {
      throw new AppError(400, 'validation_error', 'The request is invalid', [{ path: field, message: 'Not found in this organization' }]);
    }
  }
}

// ── list, counts, tags ──

knowledgeRouter.get('/knowledge', async (req, res) => {
  const ctx = auth(req);
  const q = parse(listQuery, req.query);
  const visible = visibleStatuses(ctx);
  const statuses = q.status === 'all' ? visible.filter((s) => s !== 'discarded') : visible.filter((s) => s === q.status);
  const text = q.q?.trim() || null;
  const result = await withTenant(ctx.organizationId, async (db): Promise<KnowledgeList> => {
    const rows = await db.query<EntryRow & { total: string }>(
      `${ENTRY_SELECT.replace('SELECT k.id,', 'SELECT count(*) OVER() AS total, k.id,')}
        WHERE k.status = ANY($2::text[])
          AND ($3::text IS NULL OR k.kind = $3)
          AND ($4::text IS NULL OR k.tags @> ARRAY[lower($4::text)])
          AND ($5::text IS NULL OR k.rule_ids @> ARRAY[$5::text])
          AND ($6::text IS NULL OR k.search @@ websearch_to_tsquery('simple', $6) OR k.title ILIKE $7 ESCAPE '\\' OR k.symptoms ILIKE $7 ESCAPE '\\'
               OR k.fix_steps ILIKE $7 ESCAPE '\\' OR array_to_string(k.tags, ' ') ILIKE $7 ESCAPE '\\')
        ORDER BY CASE WHEN $6::text IS NULL THEN 0 ELSE ts_rank_cd(k.search, websearch_to_tsquery('simple', $6)) END DESC,
                 array_position(ARRAY['candidate','draft','published','discarded'], k.status), k.updated_at DESC, k.id
        LIMIT $8 OFFSET $9`,
      [ctx.userId, statuses, q.kind ?? null, q.tag ?? null, q.rule ?? null, text, text ? `%${escapeLike(text)}%` : null, q.page_size, (q.page - 1) * q.page_size],
    );
    const counts = await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM knowledge_entries WHERE status = ANY($1::text[]) GROUP BY status`, [visible]);
    const by = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    return {
      items: rows.rows.map(({ total: _t, ...r }) => formatEntry(r)),
      total: Number(rows.rows[0]?.total ?? 0),
      page: q.page,
      page_size: q.page_size,
      counts: { candidate: by.candidate ?? 0, draft: by.draft ?? 0, published: by.published ?? 0, discarded: by.discarded ?? 0 },
    };
  });
  res.json(result);
});

/** Counts per status (the sidebar badge shows candidates waiting for review). */
knowledgeRouter.get('/knowledge/counts', async (req, res) => {
  const ctx = auth(req);
  const visible = visibleStatuses(ctx);
  const rows = await withTenant(ctx.organizationId, (db) =>
    db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM knowledge_entries WHERE status = ANY($1::text[]) GROUP BY status`, [visible]),
  );
  const by = Object.fromEntries(rows.rows.map((r) => [r.status, r.n]));
  res.json({ candidate: by.candidate ?? 0, draft: by.draft ?? 0, published: by.published ?? 0, discarded: by.discarded ?? 0 });
});

knowledgeRouter.get('/knowledge/tags', async (req, res) => {
  const ctx = auth(req);
  const rows = await withTenant(ctx.organizationId, (db) =>
    db.query<{ tag: string; count: number }>(
      `SELECT t AS tag, count(*)::int AS count FROM knowledge_entries, unnest(tags) t
        WHERE status = ANY($1::text[]) AND status <> 'discarded' GROUP BY t ORDER BY count(*) DESC, t LIMIT 60`,
      [visibleStatuses(ctx)],
    ),
  );
  res.json({ items: rows.rows });
});

// ── suggestions ──

knowledgeRouter.get('/knowledge/suggest', async (req, res) => {
  const ctx = auth(req);
  const q = parse(suggestQuery, req.query);
  res.json(await withTenant(ctx.organizationId, (db) => suggest(db, ctx.organizationId, ctx.userId, q)));
});

// ── detail ──

knowledgeRouter.get('/knowledge/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const detail = await withTenant(ctx.organizationId, async (db): Promise<KnowledgeDetail> => {
    const entry = await loadEntry(db, ctx.userId, id);
    if (!entry || !visibleStatuses(ctx).includes(entry.status)) throw notFound('Knowledge entry');
    const revisions = await db.query<Omit<KnowledgeRevision, 'created_at'> & { created_at: Date }>(
      `SELECT id, revision, action, user_name, created_at, snapshot FROM knowledge_revisions WHERE entry_id = $1 ORDER BY created_at DESC, revision DESC LIMIT 100`,
      [id],
    );
    const uses = await db.query<Omit<KnowledgeUse, 'created_at'> & { created_at: Date }>(
      `SELECT u.incident_id, i.number AS incident_number, i.title AS incident_title, u.user_name, u.created_at
         FROM knowledge_uses u JOIN incidents i ON i.id = u.incident_id WHERE u.entry_id = $1 ORDER BY u.created_at DESC LIMIT 50`,
      [id],
    );
    return {
      ...entry,
      revisions: revisions.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })),
      used_on: uses.rows.map((u) => ({ ...u, created_at: new Date(u.created_at).toISOString() })),
    };
  });
  res.json(detail);
});

// ── create / edit ──

knowledgeRouter.post('/knowledge', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createSchema, req.body);
  if (body.publish && !atLeast(ctx, 'admin')) throw forbidden('Only an administrator can publish knowledge');
  if (body.publish && !body.fix_steps.trim()) throw new AppError(400, 'fix_required', 'Describe the fix before publishing');
  const who = await actor(ctx.userId);
  const entry = await withTenant(ctx.organizationId, async (db) => {
    await checkLinks(db, body);
    const status = body.publish ? 'published' : 'draft';
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO knowledge_entries (organization_id, status, source, kind, title, symptoms, cause, cause_source, fix_steps, tags, rule_ids, incident_kinds,
                                      event_types, device_types, vendors, site_id, device_id, check_id, edited,
                                      created_by, created_by_name, updated_by, updated_by_name, published_by, published_by_name, published_at)
       VALUES ($1,$2,'manual',$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18,$17,$18,
               CASE WHEN $2 = 'published' THEN $17::uuid END, CASE WHEN $2 = 'published' THEN $18 END, CASE WHEN $2 = 'published' THEN now() END)
       RETURNING id`,
      [
        ctx.organizationId, status, body.kind, body.title, body.symptoms, body.cause, body.fix_steps, body.tags, body.rule_ids, body.incident_kinds,
        body.event_types, body.device_types, body.vendors, body.site_id, body.device_id, body.check_id, who.id, who.name,
      ],
    );
    const id = inserted.rows[0]!.id;
    await addRevision(db, ctx.organizationId, id, 'created', who);
    if (status === 'published') await addRevision(db, ctx.organizationId, id, 'published', who);
    await audit(db, req, 'knowledge.created', { type: 'knowledge', id }, { status, kind: body.kind, title: body.title });
    await notifyRealtime(db, ctx.organizationId, 'events');
    return loadEntry(db, ctx.userId, id);
  });
  res.status(201).json(entry);
});

const CONTENT_COLUMNS = ['kind', 'title', 'symptoms', 'cause', 'fix_steps', 'tags', 'rule_ids', 'incident_kinds', 'event_types', 'device_types', 'vendors', 'site_id', 'device_id', 'check_id'] as const;

knowledgeRouter.patch('/knowledge/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(patchSchema, req.body);
  const who = await actor(ctx.userId);
  const entry = await withTenant(ctx.organizationId, async (db) => {
    const current = await requireEntry(db, id);
    if (current.status === 'discarded') throw new AppError(409, 'discarded', 'Restore this candidate before editing it');
    if (current.status === 'published' && !atLeast(ctx, 'admin')) throw forbidden('Only an administrator can edit published knowledge');
    if (current.revision !== body.expected_revision) {
      throw new AppError(409, 'stale_revision', 'Someone else saved this article since you opened it. Reload to see their changes.', { revision: current.revision });
    }
    if (current.status === 'published' && body.fix_steps !== undefined && !body.fix_steps.trim()) throw new AppError(400, 'fix_required', 'A published article needs fix steps');
    await checkLinks(db, body);
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const col of CONTENT_COLUMNS) {
      if (body[col] === undefined) continue;
      values.push(body[col]);
      sets.push(`${col} = $${values.length}`);
    }
    // Rewriting or explicitly confirming the cause turns the doctor's inference into a person's statement.
    if ((body.cause !== undefined && body.cause !== current.cause) || body.confirm_cause) sets.push(`cause_source = 'manual'`);
    if (!sets.length) throw new AppError(400, 'nothing_to_change', 'Change at least one field');
    values.push(who.id, who.name);
    await db.query(
      `UPDATE knowledge_entries SET ${sets.join(', ')}, edited = true, revision = revision + 1, updated_by = $${values.length - 1}, updated_by_name = $${values.length}, updated_at = now()
        WHERE id = $1`,
      values,
    );
    await addRevision(db, ctx.organizationId, id, 'edited', who);
    await audit(db, req, 'knowledge.updated', { type: 'knowledge', id }, { fields: Object.keys(body).filter((k) => k !== 'expected_revision'), status: current.status });
    await notifyRealtime(db, ctx.organizationId, 'events');
    return loadEntry(db, ctx.userId, id);
  });
  res.json(entry);
});

// ── status transitions ──

interface Transition {
  from: string[];
  to: (source: string) => string;
  action: KnowledgeRevision['action'];
  audit: string;
  min: Role;
}
const TRANSITIONS: Record<string, Transition> = {
  publish: { from: ['candidate', 'draft'], to: () => 'published', action: 'published', audit: 'knowledge.published', min: 'admin' },
  unpublish: { from: ['published'], to: () => 'draft', action: 'unpublished', audit: 'knowledge.unpublished', min: 'admin' },
  discard: { from: ['candidate', 'draft'], to: () => 'discarded', action: 'discarded', audit: 'knowledge.discarded', min: 'technician' },
  restore: { from: ['discarded'], to: (source) => (source === 'incident' ? 'candidate' : 'draft'), action: 'restored', audit: 'knowledge.restored', min: 'technician' },
};

for (const [name, tr] of Object.entries(TRANSITIONS)) {
  knowledgeRouter.post(`/knowledge/:id/${name}`, requireRole(tr.min), async (req, res) => {
    const ctx = auth(req);
    const { id } = parse(idParams, req.params);
    const who = await actor(ctx.userId);
    const entry = await withTenant(ctx.organizationId, async (db) => {
      const current = await requireEntry(db, id);
      if (!tr.from.includes(current.status)) throw new AppError(409, 'invalid_status', `This entry is ${current.status}; it cannot be ${tr.action} now`);
      if (name === 'publish' && !current.fix_steps.trim()) throw new AppError(400, 'fix_required', 'Describe the fix before publishing');
      const to = tr.to(current.source);
      await db.query(
        `UPDATE knowledge_entries SET status = $2, updated_by = $3, updated_by_name = $4, updated_at = now(),
                published_by = CASE WHEN $2 = 'published' THEN $3::uuid ELSE published_by END,
                published_by_name = CASE WHEN $2 = 'published' THEN $4 ELSE published_by_name END,
                published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END
          WHERE id = $1`,
        [id, to, who.id, who.name],
      );
      await addRevision(db, ctx.organizationId, id, tr.action, who);
      await audit(db, req, tr.audit, { type: 'knowledge', id }, { from: current.status, to, title: current.title });
      await notifyRealtime(db, ctx.organizationId, 'events');
      return loadEntry(db, ctx.userId, id);
    });
    res.json(entry);
  });
}

knowledgeRouter.delete('/knowledge/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const current = await requireEntry(db, id);
    await db.query(`DELETE FROM knowledge_entries WHERE id = $1`, [id]);
    // knowledge_captured keeps the incident marked as captured, so a deleted candidate does not come back.
    await audit(db, req, 'knowledge.deleted', { type: 'knowledge', id }, { title: current.title, status: current.status, source: current.source });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.status(204).end();
});

// ── feedback ──

async function requirePublished(db: Db, id: string): Promise<{ title: string }> {
  const row = (await db.query<{ status: string; title: string }>(`SELECT status, title FROM knowledge_entries WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('Knowledge entry');
  if (row.status !== 'published') throw new AppError(409, 'not_published', 'Feedback can only be given on published knowledge');
  return row;
}

/** "Did this help?": one vote per user and entry; voting again changes the vote. */
knowledgeRouter.put('/knowledge/:id/vote', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(voteSchema, req.body);
  const entry = await withTenant(ctx.organizationId, async (db) => {
    await requirePublished(db, id);
    await db.query(
      `INSERT INTO knowledge_votes (organization_id, entry_id, user_id, helpful) VALUES ($1,$2,$3,$4)
       ON CONFLICT (entry_id, user_id) DO UPDATE SET helpful = EXCLUDED.helpful, updated_at = now()`,
      [ctx.organizationId, id, ctx.userId, body.helpful],
    );
    await audit(db, req, 'knowledge.voted', { type: 'knowledge', id }, { helpful: body.helpful });
    return loadEntry(db, ctx.userId, id);
  });
  res.json(entry);
});

knowledgeRouter.delete('/knowledge/:id/vote', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const entry = await withTenant(ctx.organizationId, async (db) => {
    const removed = await db.query(`DELETE FROM knowledge_votes WHERE entry_id = $1 AND user_id = $2`, [id, ctx.userId]);
    if (!removed.rowCount) throw notFound('Vote');
    await audit(db, req, 'knowledge.vote_removed', { type: 'knowledge', id });
    return loadEntry(db, ctx.userId, id);
  });
  res.json(entry);
});

/** "Mark as fix used": links the entry to the incident it fixed (and notes it on the incident's activity). */
knowledgeRouter.post('/knowledge/:id/uses', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(useSchema, req.body);
  const who = await actor(ctx.userId);
  const entry = await withTenant(ctx.organizationId, async (db) => {
    const { title } = await requirePublished(db, id);
    const incident = (await db.query<{ number: number }>(`SELECT number FROM incidents WHERE id = $1`, [body.incident_id])).rows[0];
    if (!incident) throw notFound('Incident');
    const inserted = await db.query(
      `INSERT INTO knowledge_uses (organization_id, entry_id, incident_id, user_id, user_name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [ctx.organizationId, id, body.incident_id, who.id, who.name],
    );
    if (inserted.rowCount) {
      await addActivity(db, ctx.organizationId, body.incident_id, 'comment', `Knowledge used as the fix: ${title}`, new Date(), who);
      await audit(db, req, 'knowledge.fix_used', { type: 'knowledge', id }, { incident_id: body.incident_id, incident_number: incident.number });
      await notifyRealtime(db, ctx.organizationId, 'events');
    }
    return loadEntry(db, ctx.userId, id);
  });
  res.status(201).json(entry);
});

knowledgeRouter.delete('/knowledge/:id/uses/:incidentId', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, incidentId } = parse(useParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const removed = await db.query(`DELETE FROM knowledge_uses WHERE entry_id = $1 AND incident_id = $2`, [id, incidentId]);
    if (!removed.rowCount) throw notFound('Link');
    await audit(db, req, 'knowledge.fix_unlinked', { type: 'knowledge', id }, { incident_id: incidentId });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.status(204).end();
});

