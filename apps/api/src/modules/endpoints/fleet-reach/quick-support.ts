import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomInt, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import type { FleetQuickSupport, RemoteDesktopFrame, RemoteDesktopSession } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { hmacSha256, randomToken, safeEqual, sha256 } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { inferPlatformFromOs } from '../capabilities.ts';
import type { EndpointContext } from '../schema.ts';
import { auditEndpointEvent } from '../remote-desktop/sessions.ts';
import { startSession } from '../remote-desktop/service.ts';

// Quick Support (migration 037): a computer that is not enrolled runs nigafiy-support.exe, which
// Fleet hands out with the company's server bound into it, and reads a 9-digit code and a one-time
// PIN to the operator. ATTENDED only (the person clicks Accept), at most the Support profile.
//
//   download   GET /fleet/quick-support/download?site_id=  → the exe + a signed trailer:
//              { server, tls_pin, link, key }. "link" is an HMAC-signed, 7-day token naming the
//              organization and site. The trailer is signed with this server's Ed25519 key, which is
//              derived from APP_ENCRYPTION_KEY (nothing stored; rotating the key retires old
//              downloads). The exe refuses a trailer whose signature does not verify, so the URL
//              cannot be changed in a download; at registration the server signs the program's
//              random nonce with the same key, so a server without that key cannot answer as this one.
//   register   POST /api/v1/agent/quick-support/register (the link) → a short-lived endpoint row
//              (kind quick_support, its own credential), code + PIN (only the PIN's hash is kept),
//              valid 10 minutes until an operator connects.
//   connect    POST /fleet/quick-support/connect {code, pin, reason} → wrong PINs count; 5 lock the
//              code; per-operator rate limit; then the normal session start (consent dialog,
//              banner with End, audit) with forced attended mode and the Support cap.
//   end        the session ends (either side) or the code expires → the row ends, the endpoint's
//              credential is revoked; the program sees it on its next status poll, deletes its
//              temporary folder and exits.

const LINK_TTL_S = 7 * 24 * 3600;
const CODE_TTL_MIN = 10;
export const MAX_PIN_FAILURES = 5;
const TRAILER_MAGIC = Buffer.from('NIGAFIYQS1');

const linkKey = () => Buffer.from(hkdfSync('sha256', Buffer.from(env.APP_ENCRYPTION_KEY, 'hex'), Buffer.alloc(0), 'nigafiy-quick-support-link', 32)).toString('hex');

function signingKey() {
  const seed = Buffer.from(hkdfSync('sha256', Buffer.from(env.APP_ENCRYPTION_KEY, 'hex'), Buffer.alloc(0), 'nigafiy-quick-support-ed25519', 32));
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubRaw = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv, pubRaw };
}

/** The public key the program checks, and its short fingerprint (shown in Fleet and by the program). */
export function quickSupportKey(): { public_key: string; fingerprint: string } {
  const { pubRaw } = signingKey();
  const fp = createHash('sha256').update(pubRaw).digest('hex').slice(0, 16).toUpperCase();
  return { public_key: pubRaw.toString('base64'), fingerprint: fp.match(/.{4}/g)!.join('-') };
}

export function issueLink(orgId: string, siteId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + LINK_TTL_S;
  const body = `qsl1.${orgId}.${siteId}.${exp}`;
  return `${body}.${hmacSha256(linkKey(), body)}`;
}

export function verifyLink(link: string, nowMs = Date.now()): { orgId: string; siteId: string } | null {
  const m = /^qsl1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.(\d{10})\.([0-9a-f]{64})$/.exec(link);
  if (!m) return null;
  const body = `qsl1.${m[1]}.${m[2]}.${m[3]}`;
  if (!safeEqual(hmacSha256(linkKey(), body), m[4]!)) return null;
  if (Number(m[3]) * 1000 < nowMs) return null;
  return { orgId: m[1]!, siteId: m[2]! };
}

/** The bytes appended to the exe: "\n" + JSON + u32le length of the JSON + magic. */
export function buildTrailer(o: { server: string; tlsPin: string | null; link: string; issuedBy: string }): Buffer {
  const { priv, pubRaw } = signingKey();
  const payload = Buffer.from(JSON.stringify({ v: 1, server: o.server, tls_pin: o.tlsPin ?? '', link: o.link, issued_by: o.issuedBy, key: pubRaw.toString('base64') }));
  const sig = sign(null, Buffer.concat([Buffer.from('nigafiy-qs1\n'), payload]), priv);
  const json = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), sig: sig.toString('base64') }));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return Buffer.concat([Buffer.from('\n'), json, len, TRAILER_MAGIC]);
}

/**
 * The Microsoft Store version of Quick Support (docs/operations/microsoft-store.md) cannot carry a
 * trailer: a Store package is the same signed file for everybody. It reads the same signed binding
 * from a link instead: `nigafiy-support:qs1/<base64url of the trailer JSON>`. The program checks the
 * signature exactly as for the trailer, so the server cannot be changed in a link either.
 */
export const STORE_LINK_PREFIX = 'nigafiy-support:qs1/';

export function bindingLink(trailer: Buffer): string {
  // trailer = "\n" + JSON + u32le(len) + magic
  const len = trailer.readUInt32LE(trailer.length - TRAILER_MAGIC.length - 4);
  const json = trailer.subarray(1, 1 + len);
  return STORE_LINK_PREFIX + json.toString('base64url');
}

/** GET /fleet/quick-support/link?site_id=: the binding as a link for the Store version (same validity as a download). */
export async function quickSupportLink(req: Request, ctx: AuthContext, siteId: string, server: { url: string; pin: string | null }): Promise<{ link: string; fingerprint: string; expires_in_seconds: number }> {
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    await audit(db, req, 'fleet.quick_support_link_issued', { type: 'site', id: siteId }, { server: server.url, fingerprint: quickSupportKey().fingerprint });
  });
  const trailer = buildTrailer({ server: server.url, tlsPin: server.pin, link: issueLink(ctx.organizationId, siteId), issuedBy: ctx.userEmail });
  return { link: bindingLink(trailer), fingerprint: quickSupportKey().fingerprint, expires_in_seconds: LINK_TTL_S };
}

export function proofFor(nonce: string, code: string): string {
  return sign(null, Buffer.from(`nigafiy-qs-proof\n${nonce}\n${code}`), signingKey().priv).toString('base64');
}

export function quickSupportExePath(): string {
  if (env.QUICK_SUPPORT_EXE) return env.QUICK_SUPPORT_EXE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../../../agents/endpoint-agent/bin/nigafiy-support.exe');
}

/** GET /fleet/quick-support/download: the exe with this server, this organization and site bound in. */
export async function downloadQuickSupport(req: Request, ctx: AuthContext, siteId: string, server: { url: string; pin: string | null }): Promise<Buffer> {
  const exe = quickSupportExePath();
  if (!existsSync(exe)) {
    throw new AppError(503, 'quick_support_not_built', 'nigafiy-support.exe has not been built on this server (pnpm build:agent, or set QUICK_SUPPORT_EXE)');
  }
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    await audit(db, req, 'fleet.quick_support_downloaded', { type: 'site', id: siteId }, { server: server.url, fingerprint: quickSupportKey().fingerprint });
  });
  return Buffer.concat([readFileSync(exe), buildTrailer({ server: server.url, tlsPin: server.pin, link: issueLink(ctx.organizationId, siteId), issuedBy: ctx.userEmail })]);
}

export interface QuickRegistration {
  endpoint_id: string;
  credential: string;
  code: string;
  pin: string;
  expires_at: string;
  proof: string;
  heartbeat_interval_seconds: number;
}

/** The program registers: a short-lived endpoint, a live code and a one-time PIN. */
export async function registerQuickSupport(body: { link: string; nonce: string; hostname: string; os: string; os_version?: string; arch: string; agent_version?: string }): Promise<QuickRegistration> {
  const bound = verifyLink(body.link);
  if (!bound) throw new AppError(401, 'quick_support_link_invalid', 'This Quick Support program is not valid any more: download a new one from Fleet');
  const secret = randomToken(32);
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const platform = inferPlatformFromOs(body.os, 'windows');
  return withSystem(async (db) => {
    const site = await db.query(`SELECT 1 FROM sites WHERE organization_id = $1 AND id = $2`, [bound.orgId, bound.siteId]);
    if (!site.rowCount) throw new AppError(401, 'quick_support_link_invalid', 'This Quick Support program is not valid any more: download a new one from Fleet');
    const name = `Quick Support · ${body.hostname}`.slice(0, 80);
    const ep = (
      await db.query<{ id: string }>(
        `INSERT INTO endpoints (organization_id, site_id, name, status, connection_state, credential_hash, platform, hostname, os, os_version, arch,
                                agent_version, last_heartbeat_at, kind, policy)
         VALUES ($1,$2,$3,'active','online',$4,$5,$6,$7,$8,$9,$10, now(), 'quick_support', '{"remote_desktop_consent":"prompt"}'::jsonb) RETURNING id`,
        [bound.orgId, bound.siteId, name, sha256(secret), platform, body.hostname, body.os, body.os_version ?? null, body.arch, body.agent_version ?? null],
      )
    ).rows[0]!;
    // A code nobody else is using right now (the unique index decides; retry on a clash).
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = String(randomInt(100_000_000, 1_000_000_000));
      const id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      const ins = await db.query<{ expires_at: Date }>(
        `INSERT INTO fleet_quick_support (id, organization_id, site_id, endpoint_id, code, pin_hash, hostname, os, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9::int))
         ON CONFLICT DO NOTHING RETURNING expires_at`,
        [id, bound.orgId, bound.siteId, ep.id, code, pinHash(id, pin), body.hostname, body.os, CODE_TTL_MIN],
      );
      if (!ins.rows[0]) continue;
      await auditEndpointEvent(db, bound.orgId, ep.id, 'fleet.quick_support_registered', { quick_support_id: id, hostname: body.hostname, os: body.os });
      return {
        endpoint_id: ep.id,
        credential: `lda_${ep.id}.${secret}`,
        code,
        pin,
        expires_at: ins.rows[0].expires_at.toISOString(),
        proof: proofFor(body.nonce, code),
        heartbeat_interval_seconds: 20,
      };
    }
    throw new AppError(503, 'quick_support_busy', 'No free code: try again');
  });
}

const pinHash = (id: string, pin: string) => sha256(`${id}:${pin}`);

/** Ends a Quick Support row and revokes its endpoint's credential (in the caller's transaction). */
async function finish(db: Db, orgId: string, row: { id: string; endpoint_id: string }, state: 'ended' | 'expired' | 'locked', reason: string): Promise<void> {
  await db.query(`UPDATE fleet_quick_support SET state = $2, ended_at = now(), end_reason = $3 WHERE id = $1 AND state IN ('waiting', 'connected')`, [row.id, state, reason]);
  await db.query(`UPDATE endpoints SET status = 'revoked', revoked_at = now(), credential_hash = NULL, connection_state = 'offline', rd_session = NULL WHERE id = $1 AND kind = 'quick_support'`, [row.endpoint_id]);
  await auditEndpointEvent(db, orgId, row.endpoint_id, `fleet.quick_support_${state}`, { quick_support_id: row.id, reason });
}

/** Expired codes, ended sessions, programs gone silent: end them (job, and on reads). */
export async function runQuickSupportSweep(): Promise<number> {
  const due = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; organization_id: string; endpoint_id: string; why: 'expired' | 'ended' }>(
          `SELECT q.id, q.organization_id, q.endpoint_id,
                  CASE WHEN q.state = 'waiting' THEN 'expired' ELSE 'ended' END AS why
             FROM fleet_quick_support q
             JOIN endpoints e ON e.id = q.endpoint_id
             LEFT JOIN fleet_sessions f ON f.id = q.fleet_session_id
            WHERE (q.state = 'waiting' AND (q.expires_at <= now() OR e.last_heartbeat_at < now() - interval '2 minutes'))
               OR (q.state = 'connected' AND (f.state = 'ended' OR e.last_heartbeat_at < now() - interval '2 minutes'))
            LIMIT 200`,
        )
      ).rows,
  );
  for (const r of due) {
    await withTenant(r.organization_id, (db) => finish(db, r.organization_id, r, r.why, r.why === 'expired' ? 'code_expired' : 'session_ended'));
  }
  return due.length;
}

/** GET /api/v1/agent/quick-support/status: what the program shows, and when it exits. */
export async function quickSupportStatus(ep: EndpointContext): Promise<{ state: FleetQuickSupport['state']; expires_at: string; operator: string | null }> {
  await runQuickSupportSweep();
  const r = await withTenant(ep.organizationId, (db) =>
    db.query<{ state: FleetQuickSupport['state']; expires_at: Date; operator_email: string | null }>(
      `SELECT state, expires_at, operator_email FROM fleet_quick_support WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ep.id],
    ),
  );
  const row = r.rows[0];
  if (!row) throw notFound('Quick Support');
  return { state: row.state, expires_at: row.expires_at.toISOString(), operator: row.operator_email };
}

/** The person closed the program: end at once. */
export async function quickSupportClosedByUser(ep: EndpointContext): Promise<void> {
  await withTenant(ep.organizationId, async (db) => {
    const r = await db.query<{ id: string; endpoint_id: string; fleet_session_id: string | null }>(
      `SELECT id, endpoint_id, fleet_session_id FROM fleet_quick_support WHERE endpoint_id = $1 AND state IN ('waiting', 'connected')`,
      [ep.id],
    );
    const row = r.rows[0];
    if (!row) return;
    if (row.fleet_session_id) {
      await db.query(`UPDATE fleet_sessions SET state = 'ended', ended_at = now(), end_reason = 'quick_support_closed' WHERE id = $1 AND state <> 'ended'`, [row.fleet_session_id]);
      await db.query(`SELECT pg_notify('ld_rd_stream', $1)`, [`end|${ep.id}`]);
    }
    await finish(db, ep.organizationId, row, 'ended', 'closed_by_user');
  });
}

export async function listQuickSupport(ctx: AuthContext, limit: number): Promise<FleetQuickSupport[]> {
  await runQuickSupportSweep();
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<FleetQuickSupport>(
      `SELECT id, site_id, endpoint_id, code, state, failed_attempts, hostname, os, link_issued_by, created_at, expires_at, connected_at,
              operator_email, fleet_session_id, ended_at, end_reason
         FROM fleet_quick_support ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    // A waiting code is what lets anyone with the PIN connect: shown only once connected or ended.
    return r.rows.map((q) => (q.state === 'waiting' ? { ...q, code: `${q.code.slice(0, 3)} *** ***` } : q));
  });
}

/** POST /fleet/quick-support/connect */
export async function connectQuickSupport(
  req: Request,
  ctx: AuthContext,
  body: { code: string; pin: string; reason: string; profile_id?: string; recording_enabled: boolean },
): Promise<{ endpoint_id: string; session: RemoteDesktopSession; last_frame: RemoteDesktopFrame | null }> {
  await runQuickSupportSweep();
  const checked = await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ id: string; endpoint_id: string; pin_hash: string; state: string; failed_attempts: number; expires_at: Date }>(
      `SELECT id, endpoint_id, pin_hash, state, failed_attempts, expires_at FROM fleet_quick_support WHERE code = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [body.code],
    );
    const row = r.rows[0];
    if (!row || (row.state !== 'waiting' && row.state !== 'locked')) {
      await audit(db, req, 'fleet.quick_support_failed', { type: 'quick_support', id: row?.id ?? null }, { code: 'quick_support_code_unknown' });
      return { error: new AppError(404, 'quick_support_code_unknown', 'No Quick Support program is waiting with this code') };
    }
    if (row.state === 'locked') return { error: new AppError(423, 'quick_support_locked', 'This code is locked after too many wrong PINs: ask the person to start Quick Support again') };
    if (row.expires_at.getTime() <= Date.now()) {
      await finish(db, ctx.organizationId, row, 'expired', 'code_expired');
      return { error: new AppError(410, 'quick_support_expired', 'This code has expired: ask the person to start Quick Support again') };
    }
    if (!safeEqual(row.pin_hash, pinHash(row.id, body.pin))) {
      const failures = row.failed_attempts + 1;
      await db.query(`UPDATE fleet_quick_support SET failed_attempts = $2 WHERE id = $1`, [row.id, failures]);
      await audit(db, req, 'fleet.quick_support_failed', { type: 'quick_support', id: row.id }, { code: 'quick_support_wrong_pin', failures });
      if (failures >= MAX_PIN_FAILURES) {
        await finish(db, ctx.organizationId, row, 'locked', 'too_many_wrong_pins');
        return { error: new AppError(423, 'quick_support_locked', 'This code is locked after too many wrong PINs: ask the person to start Quick Support again') };
      }
      return { error: new AppError(401, 'quick_support_wrong_pin', `Wrong PIN (${MAX_PIN_FAILURES - failures} tries left)`) };
    }
    await db.query(`UPDATE fleet_quick_support SET state = 'connected', connected_at = now(), operator_email = $2 WHERE id = $1`, [row.id, ctx.userEmail]);
    await audit(db, req, 'fleet.quick_support_connected', { type: 'endpoint', id: row.endpoint_id }, { quick_support_id: row.id });
    return { row };
  });
  if ('error' in checked) throw checked.error;
  const { row } = checked;
  try {
    const out = await startSession(
      req,
      ctx,
      row.endpoint_id,
      { reason: body.reason, profile_id: body.profile_id, recording_enabled: body.recording_enabled, display_index: 0, quality: 68, scale: 0.75 },
      { quickSupportId: row.id },
    );
    await withTenant(ctx.organizationId, (db) => db.query(`UPDATE fleet_quick_support SET fleet_session_id = $2 WHERE id = $1`, [row.id, out.session.fleet_session_id ?? null]));
    return { endpoint_id: row.endpoint_id, ...out };
  } catch (err) {
    // The policy refused (role, hours, address…): the code goes back to waiting for another try.
    await withTenant(ctx.organizationId, (db) => db.query(`UPDATE fleet_quick_support SET state = 'waiting', connected_at = NULL, operator_email = NULL WHERE id = $1 AND state = 'connected'`, [row.id]));
    throw err;
  }
}
