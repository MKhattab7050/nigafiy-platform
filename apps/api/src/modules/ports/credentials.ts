import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import type { Db } from '../../infrastructure/db.ts';

// SNMP read credentials: validated, sealed (encrypted) before storage, and decrypted in exactly
// one place — the configuration sent to the site's own collector.

const secretText = z.string().min(1).max(128);
export const credentials = z.discriminatedUnion('version', [
  z.object({ version: z.literal('2c'), community: secretText }).strict(),
  z
    .object({
      version: z.literal('3'),
      username: z.string().min(1).max(64),
      auth_protocol: z.enum(['md5', 'sha', 'sha256']).optional(),
      auth_password: secretText.min(8).optional(),
      priv_protocol: z.enum(['des', 'aes']).optional(),
      priv_password: secretText.min(8).optional(),
    })
    .strict()
    .refine((c) => Boolean(c.auth_protocol) === Boolean(c.auth_password), 'authentication protocol and password go together')
    .refine((c) => Boolean(c.priv_protocol) === Boolean(c.priv_password), 'privacy protocol and password go together')
    .refine((c) => !c.priv_protocol || Boolean(c.auth_protocol), 'privacy needs authentication'),
]);
export type Credentials = z.infer<typeof credentials>;

export const seal = (c: Credentials): string => {
  const { version: _version, ...secret } = c;
  return encryptSecret(JSON.stringify(secret));
};

/**
 * Targets for the collector's configuration. The only place credentials are decrypted.
 *
 * Write credentials (port control) are included only while a port change of that switch is pending
 * and was sent to this collector (`collectorId`); otherwise the collector never holds them.
 */
export async function buildSnmpConfig(db: Db, siteId: string, collectorId?: string) {
  const rows = (
    await db.query<{
      id: string;
      host: string;
      port: number;
      version: string;
      secret_enc: string;
      poll_interval_seconds: number;
      write_version: string | null;
      write_secret_enc: string | null;
    }>(
      `SELECT t.id, host(t.host) AS host, t.port, t.version, t.secret_enc, t.poll_interval_seconds,
              w.write_version, w.write_secret_enc
         FROM snmp_targets t
         LEFT JOIN LATERAL (
           SELECT t.write_version, t.write_secret_enc
            WHERE t.write_secret_enc IS NOT NULL
              AND EXISTS (SELECT 1 FROM switch_port_requests q
                           WHERE q.target_id = t.id AND q.status = 'pending' AND q.expires_at > now()
                             AND ($2::uuid IS NULL OR q.collector_id = $2))
         ) w ON true
        WHERE t.site_id = $1 AND t.enabled
          AND EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.host <<= s.cidr)
        ORDER BY t.host`,
      [siteId, collectorId ?? null],
    )
  ).rows;
  return {
    targets: rows.flatMap((r) => {
      try {
        const target: Record<string, unknown> = { id: r.id, host: r.host, port: r.port, version: r.version, interval_seconds: r.poll_interval_seconds, ...(JSON.parse(decryptSecret(r.secret_enc)) as object) };
        if (r.write_version && r.write_secret_enc) {
          try {
            target.write = { version: r.write_version, ...(JSON.parse(decryptSecret(r.write_secret_enc)) as object) };
          } catch {
            // undecryptable write credentials: the change fails at the collector as "not_configured"
          }
        }
        return [target];
      } catch {
        return []; // undecryptable (key changed): the switch shows as never read until credentials are re-entered
      }
    }),
  };
}
