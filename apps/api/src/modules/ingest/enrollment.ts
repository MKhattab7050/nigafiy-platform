import type { z } from 'zod';
import { randomToken, sha256 } from '../../common/crypto.ts';
import type { enrollSchema } from '../../common/collector-protocol.ts';
import { withSystem } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

export interface EnrolledCollector {
  collector: { id: string; organization_id: string; site_id: string; name: string };
  secret: string;
}

/**
 * Enrollment: exchange a single-use, expiring enrollment token (created by an administrator)
 * for a long-lived per-collector credential. The organization and site come from the token's
 * database row — never from anything the collector sends. Returns null for an invalid token.
 */
export async function enrollCollector(body: z.infer<typeof enrollSchema>, remoteAddress: string | null): Promise<EnrolledCollector | null> {
  const secret = randomToken(32);
  const enrolled = await withSystem(async (db) => {
    // Single statement = atomic: two racing requests cannot both consume the token.
    const updated = await db.query<{ id: string; organization_id: string; site_id: string; name: string }>(
      `UPDATE collectors
          SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
              hostname = $3, version = $4, os = $5, arch = $6, last_ip = $7
        WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()
        RETURNING id, organization_id, site_id, name`,
      [sha256(body.enrollment_token), sha256(secret), body.hostname, body.version, body.os, body.arch, remoteAddress],
    );
    const row = updated.rows[0];
    if (!row) return null;
    await emitEvent(db, row.organization_id, {
      siteId: row.site_id,
      collectorId: row.id,
      type: 'collector_enrolled',
      severity: 'info',
      title: `Collector "${row.name}" enrolled`,
      details: { hostname: body.hostname, version: body.version, os: body.os, arch: body.arch, remote_address: remoteAddress },
      source: 'platform',
      occurredAt: new Date(),
    });
    await notifyRealtime(db, row.organization_id, 'collectors');
    return row;
  });
  return enrolled ? { collector: enrolled, secret } : null;
}
