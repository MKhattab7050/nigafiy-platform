import type { CollectorContext, Heartbeat } from '../../common/collector-protocol.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { buildAccessPolicy } from '../access/index.ts';
import { recordCollectorGap } from '../collectors/index.ts';
import { withConfigBackupSecrets } from '../configbackup/index.ts';
import { emitEvent } from '../events/index.ts';
import { buildSnmpConfig } from '../ports/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { buildRouterConfig } from '../routers/index.ts';
import { buildSmartCheckConfig } from '../security/index.ts';

export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * Records a collector heartbeat and answers with its full configuration (discovery scopes, checks,
 * access-control policy, SNMP targets) and the commands waiting for it — all in one transaction.
 */
export function recordHeartbeat(c: CollectorContext, body: Heartbeat, remoteAddress: string | null) {
  const now = new Date();

  return withTenant(c.organizationId, async (db) => {
    // The previous heartbeat, to record a long silence as a monitoring gap (collectors/monitor-gaps.ts).
    const previous = await db.query<{ last_heartbeat_at: Date | null }>(`SELECT last_heartbeat_at FROM collectors WHERE id = $1 FOR UPDATE`, [c.id]);
    await db.query(
      `UPDATE collectors
          SET last_heartbeat_at = $2, connection_state = 'online', hostname = $3, version = $4, os = $5, arch = $6,
              gateway_ip = $7, interfaces = $8, spool_depth = $9, last_ip = $10, access_status = $11, mndp_status = $12
        WHERE id = $1`,
      [
        c.id,
        now,
        body.hostname,
        body.version,
        body.os,
        body.arch,
        body.gateway_ip ?? null,
        JSON.stringify(body.interfaces),
        body.spool_depth,
        remoteAddress,
        body.access_status ? JSON.stringify(body.access_status) : null,
        body.mndp_status ? JSON.stringify(body.mndp_status) : null,
      ],
    );
    await recordCollectorGap(db, c, previous.rows[0]?.last_heartbeat_at ?? null, now);
    if (c.connectionState !== 'online') {
      if (c.connectionState === 'offline') {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          collectorId: c.id,
          type: 'collector_online',
          severity: 'info',
          title: `Collector "${c.name}" reconnected`,
          details: { buffered_batches_waiting: body.spool_depth, note: 'Telemetry buffered while disconnected is uploaded with its original timestamps.' },
          source: 'platform',
          occurredAt: now,
        });
      }
    }
    await notifyRealtime(db, c.organizationId, 'collectors');
    if (body.completed_commands.length) {
      await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = $3 WHERE collector_id = $1 AND id = ANY($2)`, [c.id, body.completed_commands, now]);
    }

    const site = await db.query<{ discovery_interval_seconds: number; mndp_listen: boolean }>(`SELECT discovery_interval_seconds, mndp_listen FROM sites WHERE id = $1`, [c.siteId]);
    const scopes = await db.query<{ id: string; cidr: string }>(
      `SELECT id, cidr::text AS cidr FROM network_scopes WHERE site_id = $1 AND enabled ORDER BY cidr`,
      [c.siteId],
    );
    const checks = await db.query(
      `SELECT id, kind, target, port, interval_seconds, config, snmp_target_id FROM monitoring_checks WHERE site_id = $1 AND enabled ORDER BY array_position(ARRAY['gateway','internet','dns','service'], role), name, id`,
      [c.siteId],
    );
    // A wake, router or toolbox request that could not be delivered within 10 / 10 / 5 minutes expires: waking a computer
    // or running an on-demand test long after someone asked is not what they wanted.
    await db.query(
      `UPDATE collector_commands SET status = 'completed', completed_at = $2
        WHERE collector_id = $1 AND status <> 'completed'
          AND ((kind = 'wake_device' AND created_at < $2::timestamptz - interval '10 minutes')
               OR (kind = 'run_tool' AND created_at < $2::timestamptz - interval '5 minutes')
               OR (starts_with(kind, 'router_') AND created_at < $2::timestamptz - interval '10 minutes'))`,
      [c.id, now],
    );
    // Commands stay "delivered" (and are re-sent) until the collector acknowledges completion.
    const commands = await db.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `UPDATE collector_commands SET status = 'delivered', delivered_at = coalesce(delivered_at, $2)
        WHERE collector_id = $1 AND status <> 'completed' RETURNING id, kind, payload`,
      [c.id, now],
    );

    return {
      server_time: now.toISOString(),
      config: {
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
        discovery: {
          interval_seconds: site.rows[0]?.discovery_interval_seconds ?? 300,
          // The server-side source of truth for what may be probed. The collector additionally
          // enforces its own local allow-list and hard limits.
          scopes: scopes.rows,
        },
        checks: checks.rows,
        access: await buildAccessPolicy(db, c.siteId, now),
        // Read credentials for the switches of this site (Port Detective). Sent over the authenticated channel only.
        snmp: await buildSnmpConfig(db, c.siteId, c.id),
        // The site's routers with their administrator credentials (router control). Same channel, never cached by the collector.
        routers: await buildRouterConfig(db, c.siteId, now),
        // Smart network checks (modules/security): schedules and "run now" requests.
        smart_checks: await buildSmartCheckConfig(db, c.organizationId, c.siteId),
        // Whether the receive-only MikroTik neighbour listener (UDP 5678) may run at this site.
        mndp: { enabled: site.rows[0]?.mndp_listen ?? true },
      },
      // Configuration backups get their device's SSH credentials here, for the pending run only.
      commands: await withConfigBackupSecrets(db, c, commands.rows),
    };
  });
}
