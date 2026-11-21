import type { NextFunction, Request, Response } from 'express';
import { safeEqual, sha256 } from '../../common/crypto.ts';
import type { CollectorContext } from '../../common/collector-protocol.ts';
import { AppError } from '../../common/http.ts';
import { systemPool } from '../../infrastructure/db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalidCredential = () => new AppError(401, 'invalid_collector_credential', 'Collector credential is missing, invalid or revoked');

/** Authenticates `Authorization: Bearer ldc_<collector-id>.<secret>` and loads the tenant binding from the database. */
export async function requireCollector(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer ldc_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match || !UUID.test(match[1]!)) throw invalidCredential();
  const { rows } = await systemPool.query<{
    id: string;
    organization_id: string;
    site_id: string;
    name: string;
    credential_hash: string | null;
    connection_state: CollectorContext['connectionState'];
    gateway_ip: string | null;
    os: string | null;
    hostname: string | null;
  }>(
    `SELECT id, organization_id, site_id, name, credential_hash, connection_state, host(gateway_ip) AS gateway_ip, os, hostname
       FROM collectors WHERE id = $1 AND status = 'active'`,
    [match[1]],
  );
  const row = rows[0];
  if (!row?.credential_hash || !safeEqual(row.credential_hash, sha256(match[2]!))) throw invalidCredential();
  req.collector = {
    id: row.id,
    organizationId: row.organization_id,
    siteId: row.site_id,
    name: row.name,
    connectionState: row.connection_state,
    gatewayIp: row.gateway_ip,
    os: row.os,
    hostname: row.hostname,
  };
  next();
}
