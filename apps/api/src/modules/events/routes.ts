import { Router } from 'express';
import { z } from 'zod';
import type { AuditEntry, NetworkEvent } from '@lan-detective/shared-types';
import { auth, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const eventsRouter: Router = Router();

export const EVENT_SELECT = `
  SELECT e.id, e.site_id, s.name AS site_name, e.device_id, e.check_id, e.collector_id, e.type, e.severity, e.title,
         e.details, e.source, e.occurred_at, e.received_at
    FROM network_events e LEFT JOIN sites s ON s.id = e.site_id`;

const listQuery = z.object({
  site_id: z.uuid().optional(),
  device_id: z.uuid().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  type: z.string().max(60).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  // Keyset pagination: pass the occurred_at of the last row you received.
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

eventsRouter.get('/events', async (req, res) => {
  const ctx = auth(req);
  const q = parse(listQuery, req.query);
  const result = await withTenant(ctx.organizationId, (db) =>
    db.query<NetworkEvent>(
      `${EVENT_SELECT}
        WHERE ($1::uuid IS NULL OR e.site_id = $1)
          AND ($2::uuid IS NULL OR e.device_id = $2)
          AND ($3::text IS NULL OR e.severity = $3)
          AND ($4::text IS NULL OR e.type = $4)
          AND ($5::timestamptz IS NULL OR e.occurred_at >= $5)
          AND ($6::timestamptz IS NULL OR e.occurred_at < $6)
        ORDER BY e.occurred_at DESC, e.id
        LIMIT $7`,
      [q.site_id ?? null, q.device_id ?? null, q.severity ?? null, q.type ?? null, q.from ?? null, q.before ?? null, q.limit + 1],
    ),
  );
  const items = result.rows.slice(0, q.limit);
  res.json({ items, next_before: result.rows.length > q.limit ? items.at(-1)!.occurred_at : null });
});

eventsRouter.get('/audit-logs', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
  const result = await withTenant(ctx.organizationId, (db) =>
    db.query<AuditEntry>(
      `SELECT id, user_email, action, target_type, target_id, metadata, created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
      [q.limit],
    ),
  );
  res.json({ items: result.rows });
});
