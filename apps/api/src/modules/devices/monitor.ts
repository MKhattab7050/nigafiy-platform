import type { Request } from 'express';
import type { DeviceMonitorResult } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';

/**
 * One-click monitoring of a device: a ping check that follows the device when its IP address
 * changes. Returns the existing check when the device already has one. Throws 404 / 409 (no address).
 * Shared by POST /devices/:id/monitor and the bulk POST /devices/monitor.
 */
export async function monitorDevice(db: Db, req: Request, organizationId: string, id: string): Promise<{ check_id: string; created: boolean }> {
  const device = (
    await db.query<{ site_id: string; ip: string | null; label: string }>(
      `SELECT site_id, host(current_ip) AS ip, coalesce(display_name, hostname, host(current_ip)) AS label FROM devices WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!device) throw notFound('Device');
  if (!device.ip) throw new AppError(409, 'no_address', 'This device has no known IP address to monitor');
  const existing = await db.query<{ id: string }>(`SELECT id FROM monitoring_checks WHERE device_id = $1 LIMIT 1`, [id]);
  if (existing.rowCount) return { check_id: existing.rows[0]!.id, created: false };
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO monitoring_checks (organization_id, site_id, device_id, name, kind, role, target, interval_seconds, failure_threshold, latency_warn_ms, loss_warn_pct)
     VALUES ($1,$2,$3,$4,'icmp','service',$5,60,3,200,20) RETURNING id`,
    [organizationId, device.site_id, id, `Ping ${device.label}`.slice(0, 80), device.ip],
  );
  const checkId = inserted.rows[0]!.id;
  await audit(db, req, 'check.created', { type: 'monitoring_check', id: checkId }, { from_device: id, target: device.ip });
  return { check_id: checkId, created: true };
}

/** The bulk form: the same rules per id; a failure for one id is reported in its result and does not stop the others. */
export async function monitorDevices(db: Db, req: Request, organizationId: string, ids: string[]): Promise<DeviceMonitorResult[]> {
  const results: DeviceMonitorResult[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      const r = await monitorDevice(db, req, organizationId, id);
      results.push({ id, status: r.created ? 'created' : 'exists', check_id: r.check_id, error: null });
    } catch (err) {
      // Only the validation outcomes are per-id; anything else (a database failure) fails the whole request.
      if (!(err instanceof AppError) || (err.code !== 'not_found' && err.code !== 'no_address')) throw err;
      results.push({ id, status: err.code, check_id: null, error: { code: err.code, message: err.message } });
    }
  }
  return results;
}
