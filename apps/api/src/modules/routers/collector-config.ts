import type { Db } from '../../infrastructure/db.ts';
import { openRouterCredentials } from './credentials.ts';

/**
 * The routers block of a collector's heartbeat configuration. It contains the administrator
 * credentials, so it is sent only to a collector of the router's own site over its authenticated
 * channel; the collector keeps it in memory only.
 *
 * Left out: disabled routers, routers outside an enabled authorized scope, https-pinned routers
 * without a confirmed pin, and routers whose logins are paused (rejected credentials until they are
 * replaced; a router lock-out until its wait has passed) — so the collector never retries a login
 * that could lock the administrator out.
 */
export async function buildRouterConfig(db: Db, siteId: string, now: Date) {
  const rows = (
    await db.query<{
      id: string;
      vendor: string;
      address: string;
      port: number | null;
      transport: string;
      pin_sha256: string | null;
      secret_enc: string;
      credentials_updated_at: Date;
      refresh_interval_seconds: number;
    }>(
      `SELECT r.id, r.vendor, host(r.address) AS address, r.port, r.transport, r.pin_sha256, r.secret_enc, r.credentials_updated_at, r.refresh_interval_seconds
         FROM site_routers r
        WHERE r.site_id = $1 AND r.enabled
          AND (r.transport <> 'https-pinned' OR r.pin_sha256 IS NOT NULL)
          AND r.login_paused_reason IS DISTINCT FROM 'bad_credentials'
          AND (r.login_paused_until IS NULL OR r.login_paused_until <= $2)
          AND EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = r.site_id AND s.enabled AND r.address <<= s.cidr)
        ORDER BY r.address`,
      [siteId, now],
    )
  ).rows;
  return {
    targets: rows.flatMap((r) => {
      const creds = openRouterCredentials(r.secret_enc);
      if (!creds) return [];
      return [
        {
          id: r.id,
          vendor: r.vendor,
          address: r.address,
          ...(r.port ? { port: r.port } : {}),
          transport: r.transport,
          ...(r.pin_sha256 ? { pin_sha256: r.pin_sha256 } : {}),
          username: creds.username,
          password: creds.password,
          credentials_version: r.credentials_updated_at.toISOString(),
          refresh_interval_seconds: r.refresh_interval_seconds,
        },
      ];
    }),
  };
}
