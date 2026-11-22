import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, sha256 } from '../../common/crypto.ts';
import type { Db } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { sanitizeConfig } from './sanitize.ts';

/** What is stored for one configuration: sanitized text (contents) and the sealed raw copy. */
export interface PreparedConfig {
  text: string;
  sha256: string;
  sizeBytes: number;
  lineCount: number;
  redactions: Record<string, number>;
  redactedTotal: number;
}

/**
 * The target's fingerprint key (random, sealed per target). Created on first use. The caller holds the
 * target row lock (ingest) or creates it idempotently (a concurrent creator loses the UPDATE race and
 * re-reads the winner's key).
 */
export async function fingerprintKey(db: Db, targetId: string): Promise<Buffer> {
  const row = (await db.query<{ k: string | null }>(`SELECT secret_fp_key_enc AS k FROM config_backup_targets WHERE id = $1`, [targetId])).rows[0];
  if (row?.k) return Buffer.from(decryptSecret(row.k), 'hex');
  const key = randomBytes(32);
  const set = await db.query(`UPDATE config_backup_targets SET secret_fp_key_enc = $2 WHERE id = $1 AND secret_fp_key_enc IS NULL`, [targetId, encryptSecret(key.toString('hex'))]);
  if (set.rowCount) return key;
  const again = (await db.query<{ k: string }>(`SELECT secret_fp_key_enc AS k FROM config_backup_targets WHERE id = $1`, [targetId])).rows[0];
  return Buffer.from(decryptSecret(again!.k), 'hex');
}

export function prepareConfig(normalizedText: string, key: Buffer): PreparedConfig {
  const s = sanitizeConfig(normalizedText, key);
  const lines = s.text === '' ? 0 : s.text.replace(/\n$/, '').split('\n').length;
  return { text: s.text, sha256: sha256(s.text), sizeBytes: Buffer.byteLength(s.text, 'utf8'), lineCount: lines, redactions: s.redactions, redactedTotal: s.total };
}

/**
 * Converts one target's content rows written before secret sanitization (migration 041): the stored
 * text becomes the sealed raw copy, the sanitized text replaces it, and versions follow the new hash.
 * Returns the number of rows converted. A row that cannot be decrypted (application key changed) is
 * left as it is and logged; it is never shown unsanitized (reads sanitize in memory or refuse).
 */
export async function resanitizeTarget(db: Db, targetId: string): Promise<number> {
  const rows = (
    await db.query<{ sha256: string; organization_id: string; content_enc: string }>(
      `SELECT sha256, organization_id, content_enc FROM config_backup_contents WHERE target_id = $1 AND NOT sanitized FOR UPDATE`,
      [targetId],
    )
  ).rows;
  if (!rows.length) return 0;
  const key = await fingerprintKey(db, targetId);
  let converted = 0;
  for (const r of rows) {
    let raw: string;
    try {
      raw = decryptSecret(r.content_enc);
    } catch {
      logger.warn({ target_id: targetId }, 'configuration backup content cannot be decrypted; left for re-backup');
      continue;
    }
    const p = prepareConfig(raw, key);
    const exists = p.sha256 !== r.sha256 && (await db.query(`SELECT 1 FROM config_backup_contents WHERE target_id = $1 AND sha256 = $2`, [targetId, p.sha256])).rowCount;
    if (exists) {
      // Another old row already sanitizes to the same text: point its versions there and drop this one.
      await db.query(`UPDATE config_backup_versions SET sha256 = $3 WHERE target_id = $1 AND sha256 = $2`, [targetId, r.sha256, p.sha256]);
      await db.query(`DELETE FROM config_backup_contents WHERE target_id = $1 AND sha256 = $2`, [targetId, r.sha256]);
    } else {
      // ON UPDATE CASCADE (migration 041) moves the versions with the hash.
      await db.query(
        `UPDATE config_backup_contents SET sha256 = $3, content_enc = $4, size_bytes = $5, line_count = $6, sanitized = true, redactions = $7
          WHERE target_id = $1 AND sha256 = $2`,
        [targetId, r.sha256, p.sha256, encryptSecret(p.text), p.sizeBytes, p.lineCount, JSON.stringify(p.redactions)],
      );
    }
    await db.query(
      `INSERT INTO config_backup_raw (target_id, sha256, organization_id, raw_enc) VALUES ($1,$2,$3,$4)
       ON CONFLICT (target_id, sha256) DO NOTHING`,
      [targetId, p.sha256, r.organization_id, encryptSecret(raw)],
    );
    converted++;
  }
  return converted;
}

/** Background conversion (configuration-backup job): a bounded batch per run, across organizations. */
export async function resanitizeLegacy(db: Db, limit = 200): Promise<number> {
  const targets = (
    await db.query<{ target_id: string }>(`SELECT DISTINCT target_id FROM config_backup_contents WHERE NOT sanitized LIMIT $1`, [limit])
  ).rows;
  let n = 0;
  for (const t of targets) n += await resanitizeTarget(db, t.target_id);
  return n;
}
