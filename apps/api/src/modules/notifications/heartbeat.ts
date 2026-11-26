import type { OutsideHeartbeat } from '@nigafiy/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import { auth, parse, requireRole } from '../../common/http.ts';
import { withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { getOutbound } from './dispatch.ts';
import { assertDestinationUrl } from './routes.ts';

/**
 * Optional outside heartbeat (UX review item 2). Nigafiy runs on one PC: when that PC is off nothing
 * inside it can warn anyone. An outside service (healthchecks.io, an Uptime Kuma "push" monitor) can:
 * while monitoring runs, Nigafiy sends a plain GET to the push URL about once a minute; when the pings
 * stop, that service alerts the owner by its own channels.
 *
 * "Monitoring runs" means: the server is up and at least one Sensor of the organization is reporting.
 * If only the server is up but no Sensor reports, nothing is being watched, so no ping is sent.
 *
 * The URL often carries a secret token (the healthchecks.io UUID), so it is sealed and never returned;
 * only its host is shown. It follows the same outbound rules as webhooks: https only, and public
 * addresses only, unless ALLOW_PRIVATE_WEBHOOKS allows http and LAN targets (a LAN Uptime Kuma).
 */
export const HEARTBEAT_INTERVAL_SECONDS = 60;

export const heartbeatRouter: Router = Router();

const putBody = z.object({ url: z.url().max(500) });

const SELECT = `SELECT url_host, last_ping_at, last_status, last_error FROM monitor_heartbeat`;

function view(row: { url_host: string; last_ping_at: Date | null; last_status: number | null; last_error: string | null } | undefined): OutsideHeartbeat {
  return {
    configured: !!row,
    url_host: row?.url_host ?? null,
    last_ping_at: row?.last_ping_at ? row.last_ping_at.toISOString() : null,
    last_status: row?.last_status ?? null,
    last_error: row?.last_error ?? null,
    interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
  };
}

/** One ping; never throws. The error text never contains the URL (it may hold a token). */
export async function pingOnce(url: string): Promise<{ status: number | null; error: string | null }> {
  try {
    const status = await getOutbound(url, { 'User-Agent': 'Nigafiy-Heartbeat/1' });
    return { status, error: status >= 200 && status < 300 ? null : `The service answered HTTP ${status}` };
  } catch (err) {
    let msg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ');
    msg = msg.replaceAll(url, '[url]');
    try {
      const u = new URL(url);
      if (u.pathname.length > 1) msg = msg.replaceAll(u.pathname, '/[path]');
    } catch {
      /* ignore */
    }
    return { status: null, error: msg.slice(0, 200) };
  }
}

heartbeatRouter.get('/notifications/heartbeat', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const row = await withTenant(ctx.organizationId, (db) => db.query(SELECT));
  res.json(view(row.rows[0]));
});

heartbeatRouter.put('/notifications/heartbeat', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(putBody, req.body);
  const url = assertDestinationUrl(body.url);
  const host = url.hostname.toLowerCase();
  // Ping once right away so the owner sees at once whether the service answers.
  const first = await pingOnce(url.toString());
  const row = await withTenant(ctx.organizationId, async (db) => {
    const saved = await db.query(
      `INSERT INTO monitor_heartbeat (organization_id, url_sealed, url_host, last_ping_at, last_status, last_error, updated_by, updated_at)
       VALUES ($1, $2, $3, now(), $4, $5, $6, now())
       ON CONFLICT (organization_id) DO UPDATE
         SET url_sealed = EXCLUDED.url_sealed, url_host = EXCLUDED.url_host, last_ping_at = EXCLUDED.last_ping_at,
             last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING url_host, last_ping_at, last_status, last_error`,
      [ctx.organizationId, encryptSecret(url.toString()), host, first.status, first.error, ctx.userId],
    );
    // The audit trail records the host only, never the URL (it may carry a token).
    await audit(db, req, 'outside_heartbeat.set', { type: 'organization', id: ctx.organizationId }, { host });
    return saved.rows[0];
  });
  res.json(view(row));
});

heartbeatRouter.delete('/notifications/heartbeat', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  await withTenant(ctx.organizationId, async (db) => {
    const removed = await db.query(`DELETE FROM monitor_heartbeat WHERE organization_id = $1`, [ctx.organizationId]);
    if (removed.rowCount) await audit(db, req, 'outside_heartbeat.removed', { type: 'organization', id: ctx.organizationId });
  });
  res.json(view(undefined));
});

/**
 * The `outside-heartbeat` job: ping every configured URL whose organization has a Sensor reporting
 * right now. Pings run in parallel, outside any transaction; results are stored for the settings page.
 */
export async function sendOutsideHeartbeats(): Promise<void> {
  const due = await withSystem((db) =>
    db.query<{ organization_id: string; url_sealed: string }>(
      `SELECT h.organization_id, h.url_sealed FROM monitor_heartbeat h
        WHERE EXISTS (SELECT 1 FROM collectors c WHERE c.organization_id = h.organization_id AND c.status = 'active' AND c.connection_state = 'online')`,
    ),
  );
  if (!due.rows.length) return;
  const results = await Promise.all(
    due.rows.map(async (r) => {
      let url: string;
      try {
        url = decryptSecret(r.url_sealed);
      } catch (err) {
        logger.error({ err, organization_id: r.organization_id }, 'outside heartbeat URL could not be decrypted');
        return { organization_id: r.organization_id, status: null, error: 'The saved URL could not be read; enter it again' };
      }
      return { organization_id: r.organization_id, ...(await pingOnce(url)) };
    }),
  );
  await withSystem(async (db) => {
    for (const r of results) {
      await db.query(`UPDATE monitor_heartbeat SET last_ping_at = now(), last_status = $2, last_error = $3 WHERE organization_id = $1`, [r.organization_id, r.status, r.error]);
    }
  });
}
