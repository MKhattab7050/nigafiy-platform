import type { NextFunction, Request, Response } from 'express';
import type { EndpointPlatform } from '@lan-detective/shared-types';
import { safeEqual, sha256 } from '../../../common/crypto.ts';
import { AppError } from '../../../common/http.ts';
import { systemPool } from '../../../infrastructure/db.ts';
import type { EndpointContext } from '../schema.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Authenticates `Authorization: Bearer lda_<endpoint-id>.<secret>` and loads the tenant binding from the database. */
export async function requireEndpointAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer lda_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match || !UUID.test(match[1]!)) {
    throw new AppError(401, 'invalid_endpoint_credential', 'Endpoint credential is missing, invalid or revoked');
  }
  const { rows } = await systemPool.query<{
    id: string;
    organization_id: string;
    site_id: string;
    device_id: string | null;
    name: string;
    platform: EndpointPlatform;
    credential_hash: string | null;
    connection_state: EndpointContext['connectionState'];
  }>(
    `SELECT id, organization_id, site_id, device_id, name, platform, credential_hash, connection_state
       FROM endpoints WHERE id = $1 AND status = 'active'`,
    [match[1]],
  );
  const row = rows[0];
  if (!row?.credential_hash || !safeEqual(row.credential_hash, sha256(match[2]!))) {
    throw new AppError(401, 'invalid_endpoint_credential', 'Endpoint credential is missing, invalid or revoked');
  }
  req.endpoint = {
    id: row.id,
    organizationId: row.organization_id,
    siteId: row.site_id,
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    connectionState: row.connection_state,
  };
  next();
}
