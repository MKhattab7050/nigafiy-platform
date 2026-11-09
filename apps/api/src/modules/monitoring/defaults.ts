import type { Db } from '../../infrastructure/db.ts';

/** `auto:gateway` is resolved by the collector to the default gateway of the host it runs on. */
export const AUTO_GATEWAY = 'auto:gateway';

/**
 * Starter checks for a new site so "is it the LAN, DNS or the ISP?" has data from minute one.
 * They are ordinary checks: an administrator can edit or delete every one of them.
 */
export async function createDefaultChecks(db: Db, organizationId: string, siteId: string): Promise<void> {
  await db.query(
    `INSERT INTO monitoring_checks (organization_id, site_id, name, kind, role, target, interval_seconds, latency_warn_ms, loss_warn_pct)
     VALUES
       ($1,$2,'Default gateway','icmp','gateway',$3,30,50,5),
       ($1,$2,'Internet — 1.1.1.1 (Cloudflare)','icmp','internet','1.1.1.1',30,150,5),
       ($1,$2,'Internet — 8.8.8.8 (Google)','icmp','internet','8.8.8.8',30,150,5),
       ($1,$2,'DNS resolution (system resolver)','dns','dns','example.com',60,300,NULL)`,
    [organizationId, siteId, AUTO_GATEWAY],
  );
}
