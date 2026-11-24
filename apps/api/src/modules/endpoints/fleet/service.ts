import type { z } from 'zod';
import type { EndpointCommand, EndpointDetail, EndpointSeriesPoint, EndpointSummary, Role } from '@nigafiy/shared-types';
import { notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { buildCapabilities, evaluateComplianceItems } from '../capabilities.ts';
import { ENDPOINT_SUMMARY_SELECT, payloadForAudit } from '../repo.ts';
import { latestFrame } from '../remote-desktop/frames.ts';
import type { SeriesRange, endpointListQuery } from '../schema.ts';

// Fleet & inventory: the read side of the endpoints module.

/** `%text%` for ILIKE with LIKE's wildcards escaped (backslash is the default escape character). */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function listEndpoints(organizationId: string, q: z.infer<typeof endpointListQuery>, userId: string | null = null): Promise<EndpointSummary[]> {
  const like = q.q ? contains(q.q) : null;
  const items = await withTenant(organizationId, (db) =>
    db.query<EndpointSummary>(
      `${ENDPOINT_SUMMARY_SELECT.replace(
        'FROM endpoints e',
        `, EXISTS (SELECT 1 FROM fleet_favourites f WHERE f.user_id = $6::uuid AND f.endpoint_id = e.id) AS favourite,
           (SELECT max(fs.started_at) FROM fleet_sessions fs WHERE fs.endpoint_id = e.id AND fs.operator_user_id = $6::uuid) AS my_last_session_at,
           (SELECT count(*)::int FROM fleet_help_requests h WHERE h.endpoint_id = e.id AND h.state = 'open') AS open_help_requests
         FROM endpoints e`,
      )}
        WHERE e.kind = 'agent'
          AND ($1::uuid IS NULL OR e.site_id = $1)
          AND ($2::uuid IS NULL OR e.device_id = $2)
          AND ($3::text IS NULL OR e.platform = $3)
          AND ($4::text IS NULL OR e.compliance_status = $4)
          AND ($5::text IS NULL OR ($5 = 'none' AND e.fleet_group_id IS NULL) OR e.fleet_group_id::text = $5)
          AND ($7::text IS NULL OR e.name ILIKE $7 OR e.hostname ILIKE $7 OR e.nigafiy_id = replace(replace($8, ' ', ''), '-', '')
               OR host(e.primary_ip) = $8 OR EXISTS (SELECT 1 FROM unnest(e.logged_in_users) u WHERE u ILIKE $7))
          AND ($9::text IS NULL OR $9 = ANY (e.tags))
          AND (NOT $10::boolean OR EXISTS (SELECT 1 FROM fleet_favourites f WHERE f.user_id = $6::uuid AND f.endpoint_id = e.id))
          AND ($11::text IS NULL OR EXISTS (SELECT 1 FROM unnest(e.logged_in_users) u WHERE u ILIKE $11))
        ORDER BY CASE e.connection_state WHEN 'online' THEN 0 WHEN 'offline' THEN 1 ELSE 2 END, e.name`,
      [
        q.site_id ?? null,
        q.device_id ?? null,
        q.platform ?? null,
        q.compliance_status ?? null,
        q.fleet_group ?? null,
        userId,
        like,
        q.q ?? null,
        q.tag ?? null,
        Boolean(q.favourites),
        q.user ? contains(q.user) : null,
      ],
    ),
  );
  return items.rows;
}

/** Full detail incl. inventory, capabilities and the latest commands (payloads redacted as for the audit log). */
export function getEndpointDetail(organizationId: string, id: string, role?: Role): Promise<EndpointDetail> {
  return withTenant(organizationId, async (db) => {
    await db.query(
      `UPDATE endpoint_commands
          SET status = 'expired', error = 'Command expired before the agent executed it', completed_at = now()
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered') AND created_at < now() - interval '10 minutes'
          AND NOT (status = 'delivered' AND kind IN ('script_run', 'patch_install', 'patch_reboot_prompt'))`,
      [id],
    );
    const ep = (
      await db.query<EndpointDetail>(
        `${ENDPOINT_SUMMARY_SELECT.replace(
          'FROM endpoints e',
          ', e.security, e.policy, e.rd_session, e.disks, e.interfaces, e.processes, e.services, e.software, e.connections, e.hardware, e.hardware_updated_at FROM endpoints e',
        )}
          WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const commands = await db.query<EndpointCommand>(
      `SELECT id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at
         FROM endpoint_commands
        WHERE endpoint_id = $1
        ORDER BY created_at DESC
        LIMIT 60`,
      [id],
    );
    const isViewer = role === 'viewer';
    ep.commands = commands.rows.map((c) => ({
      ...c,
      payload: payloadForAudit(c.kind, c.payload),
      result_data: isViewer && (c.kind === 'fs_op' || c.kind === 'rd_capture') ? null : c.result_data,
    }));
    // The latest frame of an open session, from the transient relay (never stored); not for viewers.
    ep.last_rd_frame = !isViewer && ep.rd_session ? (latestFrame(ep.id)?.frame ?? null) : null;
    ep.capabilities = buildCapabilities(ep.platform);
    // Per-item verdicts with their evidence (the stored status/reasons come from the same function).
    ep.compliance_items = evaluateComplianceItems({ platform: ep.platform, diskUsedPct: ep.disk_used_pct, security: ep.security, allowedLocalAdmins: ep.policy?.allowed_local_admins });
    return ep;
  });
}

const RANGES: Record<SeriesRange, { seconds: number; bucket: number }> = {
  '15m': { seconds: 900, bucket: 20 },
  '1h': { seconds: 3600, bucket: 60 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
};

export async function getSeries(organizationId: string, id: string, range: SeriesRange) {
  const r = RANGES[range]!;
  const to = new Date();
  const from = new Date(to.getTime() - r.seconds * 1000);

  const points = await withTenant(organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM endpoints WHERE id = $1`, [id])).rowCount) throw notFound('Endpoint');
    const result = await db.query<EndpointSeriesPoint>(
      `SELECT date_bin(make_interval(secs => $4), ts, timestamptz '2000-01-01') AS ts,
              avg(cpu_pct)::float8 AS cpu_pct,
              avg(ram_pct)::float8 AS ram_pct,
              avg(disk_used_pct)::float8 AS disk_used_pct,
              count(*)::int AS samples
         FROM endpoint_samples
        WHERE endpoint_id = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [id, from, to, r.bucket],
    );
    return result.rows;
  });

  return { from, to, bucket_seconds: r.bucket, points };
}
