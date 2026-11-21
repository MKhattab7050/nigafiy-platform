import type { CollectorContext, SmartCheckItem } from '../../common/collector-protocol.ts';
import type { Db } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { processDhcpProbe, summarizeDhcp } from './dhcp.ts';
import { processBanners, processDhcpFingerprints, summarizeBanners, summarizeFingerprints } from './identify.ts';
import { processUpnpAudit, summarizeUpnp } from './upnp.ts';
import { processWifiScan, summarizeWifi } from './wifi.ts';

/**
 * Applies one `smart_check` telemetry item (one run of one check by one collector):
 *  1. records the run (status, error, a short summary) — the "last run" shown per check;
 *  2. clears a "run now" request the run answers;
 *  3. hands the data to the check's processor.
 * A failed run (e.g. "could not listen on UDP 68", "no Wi-Fi adapter") is recorded as such and
 * changes no finding: not being able to measure is never reported as "healthy" or as a fault.
 */
export async function processSmartCheck(db: Db, c: CollectorContext, item: SmartCheckItem, now: Date): Promise<void> {
  const ranAt = new Date(item.ts);
  const summary =
    item.check === 'rogue_dhcp'
      ? summarizeDhcp(item.dhcp)
      : item.check === 'upnp'
        ? summarizeUpnp(item.upnp)
        : item.check === 'wifi'
          ? summarizeWifi(item.wifi)
          : item.check === 'banners'
            ? summarizeBanners(item.banners)
            : summarizeFingerprints(item.dhcp_fingerprints);
  await db.query(
    `INSERT INTO smart_check_runs (organization_id, site_id, collector_id, check_kind, run_id, trigger, ok, error_kind, error, duration_ms, summary, ran_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (organization_id, collector_id, check_kind) DO UPDATE
        SET site_id = EXCLUDED.site_id, run_id = EXCLUDED.run_id, trigger = EXCLUDED.trigger, ok = EXCLUDED.ok, error_kind = EXCLUDED.error_kind,
            error = EXCLUDED.error, duration_ms = EXCLUDED.duration_ms, summary = EXCLUDED.summary, ran_at = EXCLUDED.ran_at
      WHERE smart_check_runs.ran_at <= EXCLUDED.ran_at`,
    [c.organizationId, c.siteId, c.id, item.check, item.run_id, item.trigger, item.ok, item.error?.kind ?? null, item.error?.message ?? null, item.duration_ms ?? null, JSON.stringify(summary), ranAt],
  );
  await db.query(`DELETE FROM smart_check_requests WHERE organization_id = $1 AND site_id = $2 AND check_kind = $3 AND requested_at <= $4`, [
    c.organizationId,
    c.siteId,
    item.check,
    ranAt,
  ]);

  switch (item.check) {
    case 'rogue_dhcp':
      await processDhcpProbe(db, c, item, now);
      break;
    case 'upnp':
      await processUpnpAudit(db, c, item, now);
      break;
    case 'wifi':
      await processWifiScan(db, c, item, now);
      break;
    case 'banners':
      await processBanners(db, c, item);
      break;
    case 'dhcp_fingerprints':
      await processDhcpFingerprints(db, c, item, now);
      break;
  }
  await notifyRealtime(db, c.organizationId, 'checks');
}
