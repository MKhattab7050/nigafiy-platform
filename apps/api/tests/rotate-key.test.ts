import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyId, openWithKey, sealWithKey } from '../src/common/secret-box.ts';
import { RotationRefused, rotateEncryptionKey } from '../src/ops/rotate-key.ts';
import { SEALED_COLUMNS } from '../src/ops/sealed-columns.ts';
import { dropDatabase, scratchDatabase, withClient } from './ops-db.ts';

// rotate-key against a real, migrated PostgreSQL database (a throw-away one per file), with a real
// value in every column listed in ops/sealed-columns.ts.

const OLD = randomBytes(32);
const NEW = randomBytes(32);
const OTHER = randomBytes(32);

let db: { name: string; ownerUrl: string; appUrl: string };
/** "<table>.<column>|<pk...>" → plaintext that was sealed into it. */
const expected = new Map<string, string>();
const orgIds: string[] = [];

const cell = (table: string, column: string, key: readonly string[]) => `${table}.${column}|${key.join(',')}`;

async function readAll(c: pg.Client): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const sc of SEALED_COLUMNS) {
    const keyCols = sc.key.map((k) => `"${k}"::text`).join(', ');
    const r = await c.query({ text: `SELECT ${keyCols}, "${sc.column}" FROM "${sc.table}" WHERE "${sc.column}" IS NOT NULL`, rowMode: 'array' });
    for (const row of r.rows as string[][]) out.set(cell(sc.table, sc.column, row.slice(0, sc.key.length)), row[sc.key.length]!);
  }
  return out;
}

async function seed(c: pg.Client, key: Buffer): Promise<void> {
  const seal = (table: string, column: string, pk: string[], plain: string) => {
    expected.set(cell(table, column, pk), plain);
    return sealWithKey(key, plain);
  };
  for (const label of ['alpha', 'beta']) {
    const org = (await c.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`${label} corp`])).rows[0]!.id;
    orgIds.push(org);
    const site = (await c.query<{ id: string }>(`INSERT INTO sites (organization_id, name) VALUES ($1, 'HQ') RETURNING id`, [org])).rows[0]!.id;

    const userId = (await c.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'u') RETURNING id`, [`${label}@example.test`])).rows[0]!.id;
    await c.query(`UPDATE users SET mfa_secret_enc = $2, mfa_enabled_at = now(), mfa_pending_secret_enc = $3 WHERE id = $1`, [
      userId,
      seal('users', 'mfa_secret_enc', [userId], `TOTP-${label}-JBSWY3DPEHPK3PXP`),
      seal('users', 'mfa_pending_secret_enc', [userId], `TOTP-pending-${label}`),
    ]);

    const ch = (await c.query<{ id: string }>(`INSERT INTO notification_channels (organization_id, kind, name, url, secret_encrypted) VALUES ($1, 'webhook', 'hook', 'https://hooks.example.test/x', 'placeholder') RETURNING id`, [org])).rows[0]!.id;
    await c.query(`UPDATE notification_channels SET secret_encrypted = $2 WHERE id = $1`, [ch, seal('notification_channels', 'secret_encrypted', [ch], `whsec-${label}`)]);

    const snmp = (await c.query<{ id: string }>(`INSERT INTO snmp_targets (organization_id, site_id, host, version, secret_enc) VALUES ($1, $2, '10.20.0.2', '2c', 'placeholder') RETURNING id`, [org, site])).rows[0]!.id;
    await c.query(`UPDATE snmp_targets SET secret_enc = $2, write_version = '2c', write_secret_enc = $3 WHERE id = $1`, [
      snmp,
      seal('snmp_targets', 'secret_enc', [snmp], JSON.stringify({ community: `read-${label}` })),
      seal('snmp_targets', 'write_secret_enc', [snmp], JSON.stringify({ community: `write-${label}` })),
    ]);

    const router = (
      await c.query<{ id: string }>(`INSERT INTO site_routers (organization_id, site_id, name, vendor, address, transport, secret_enc) VALUES ($1, $2, 'gw', 'zyxel', '10.20.0.1', 'https', 'placeholder') RETURNING id`, [org, site])
    ).rows[0]!.id;
    await c.query(`UPDATE site_routers SET secret_enc = $2 WHERE id = $1`, [router, seal('site_routers', 'secret_enc', [router], JSON.stringify({ username: 'admin', password: `router-${label}` }))]);

    const target = (await c.query<{ id: string }>(`INSERT INTO config_backup_targets (organization_id, site_id, name, address) VALUES ($1, $2, 'core-sw', '10.20.0.3') RETURNING id`, [org, site])).rows[0]!.id;
    await c.query(`UPDATE config_backup_targets SET secret_enc = $2 WHERE id = $1`, [target, seal('config_backup_targets', 'secret_enc', [target], JSON.stringify({ username: 'backup', password: `ssh-${label}` }))]);
    // Several contents per target, so the composite key and batching are exercised.
    for (let i = 0; i < 3; i++) {
      const text = `hostname core-${label}\n! config ${i}\n`;
      const sha = createHash('sha256').update(text).digest('hex');
      await c.query(`INSERT INTO config_backup_contents (target_id, sha256, organization_id, content_enc, size_bytes, line_count) VALUES ($1, $2, $3, $4, $5, 2)`, [
        target,
        sha,
        org,
        seal('config_backup_contents', 'content_enc', [target, sha], text),
        text.length,
      ]);
    }
  }
}

beforeAll(async () => {
  db = await scratchDatabase('rotate_key');
  await withClient(db.ownerUrl, (c) => seed(c, OLD));
});

afterAll(async () => {
  if (db) await dropDatabase(db.name);
});

describe('sealed column list', () => {
  it('covers a value in every listed column (the seed is complete)', () => {
    for (const sc of SEALED_COLUMNS) {
      expect([...expected.keys()].some((k) => k.startsWith(`${sc.table}.${sc.column}|`)), `${sc.table}.${sc.column}`).toBe(true);
    }
    expect(SEALED_COLUMNS).toHaveLength(8);
  });
});

describe('rotateEncryptionKey', () => {
  it('refuses the same key twice', async () => {
    await expect(rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: Buffer.from(OLD) })).rejects.toMatchObject({ reason: 'same_key' });
  });

  it('refuses while an API instance is connected, and changes nothing', async () => {
    const api = new pg.Client({ connectionString: db.appUrl, application_name: 'ld-system' });
    await api.connect();
    try {
      const before = await withClient(db.ownerUrl, readAll);
      const err = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW }).catch((e) => e);
      expect(err).toBeInstanceOf(RotationRefused);
      expect(err.reason).toBe('api_connected');
      expect(err.message).toMatch(/ld-system/);
      expect(await withClient(db.ownerUrl, readAll)).toEqual(before);
    } finally {
      await api.end();
    }
  });

  it('refuses when the database has a sealed-looking column that is not in the list', async () => {
    await withClient(db.ownerUrl, (c) => c.query('ALTER TABLE sites ADD COLUMN api_token_sealed text'));
    try {
      const err = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW }).catch((e) => e);
      expect(err).toBeInstanceOf(RotationRefused);
      expect(err.reason).toBe('schema');
      expect(err.message).toContain('sites.api_token_sealed');
    } finally {
      await withClient(db.ownerUrl, (c) => c.query('ALTER TABLE sites DROP COLUMN api_token_sealed'));
    }
  });

  it('refuses with the wrong old key: nothing changes, no audit row, no secret in the message', async () => {
    const before = await withClient(db.ownerUrl, readAll);
    const err = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OTHER, newKey: NEW }).catch((e) => e);
    expect(err).toBeInstanceOf(RotationRefused);
    expect(err.reason).toBe('undecryptable');
    expect(err.message).toMatch(/do not decrypt with the old key/);
    expect(err.message).not.toMatch(/router-alpha|whsec|TOTP/);
    expect(await withClient(db.ownerUrl, readAll)).toEqual(before);
    const audits = await withClient(db.ownerUrl, (c) => c.query(`SELECT 1 FROM audit_logs WHERE action = 'security.encryption_key_rotated'`));
    expect(audits.rowCount).toBe(0);
  });

  it('refuses (and rolls back) when only one value is sealed with another key', async () => {
    const [router] = [...expected.keys()].filter((k) => k.startsWith('site_routers.secret_enc|'));
    const routerId = router!.split('|')[1]!;
    const original = await withClient(db.ownerUrl, async (c) => (await c.query<{ s: string }>('SELECT secret_enc AS s FROM site_routers WHERE id = $1', [routerId])).rows[0]!.s);
    await withClient(db.ownerUrl, (c) => c.query('UPDATE site_routers SET secret_enc = $2 WHERE id = $1', [routerId, sealWithKey(OTHER, 'stray')]));
    try {
      const before = await withClient(db.ownerUrl, readAll);
      const err = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW, batchSize: 2 }).catch((e) => e);
      expect(err.reason).toBe('undecryptable');
      expect(err.message).toContain(`site_routers.secret_enc (id=${routerId})`);
      expect(await withClient(db.ownerUrl, readAll)).toEqual(before);
    } finally {
      await withClient(db.ownerUrl, (c) => c.query('UPDATE site_routers SET secret_enc = $2 WHERE id = $1', [routerId, original]));
    }
  });

  it('dry run checks every value and changes nothing', async () => {
    const before = await withClient(db.ownerUrl, readAll);
    const r = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.total).toBe(expected.size);
    expect(r.auditRows).toBe(0);
    expect(r.columns.map((c) => `${c.table}.${c.column}`).sort()).toEqual(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
    expect(await withClient(db.ownerUrl, readAll)).toEqual(before);
  });

  it('re-encrypts every sealed column in one transaction and audits it per organization', async () => {
    const r = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW, batchSize: 2, operator: { osUser: 'tester', host: 'test-host' } });
    expect(r.dryRun).toBe(false);
    expect(r.total).toBe(expected.size);
    expect(r.oldKeyId).toBe(keyId(OLD));
    expect(r.newKeyId).toBe(keyId(NEW));
    expect(r.auditRows).toBe(orgIds.length);

    const after = await withClient(db.ownerUrl, readAll);
    expect(after.size).toBe(expected.size);
    for (const [k, stored] of after) {
      expect(openWithKey(NEW, stored), k).toBe(expected.get(k));
      expect(() => openWithKey(OLD, stored), k).toThrow();
    }

    const audits = await withClient(db.ownerUrl, (c) =>
      c.query<{ organization_id: string; actor: string; user_id: string | null; metadata: Record<string, unknown> }>(
        `SELECT organization_id, actor, user_id, metadata FROM audit_logs WHERE action = 'security.encryption_key_rotated' ORDER BY organization_id`,
      ),
    );
    expect(audits.rows.map((a) => a.organization_id).sort()).toEqual([...orgIds].sort());
    for (const a of audits.rows) {
      expect(a.actor).toBe('system');
      expect(a.user_id).toBeNull();
      expect(a.metadata.tool).toBe('rotate-key');
      expect(a.metadata.old_key_id).toBe(keyId(OLD));
      expect(a.metadata.new_key_id).toBe(keyId(NEW));
      expect(a.metadata.values_rotated_total).toBe(expected.size);
      // users are installation-wide; everything else in the seed belongs to one organization.
      expect(a.metadata.values_rotated_in_organization).toBe((expected.size - 4) / 2);
      expect(a.metadata.operator_os_user).toBe('tester');
      const json = JSON.stringify(a.metadata);
      expect(json).not.toContain(OLD.toString('hex'));
      expect(json).not.toContain(NEW.toString('hex'));
      expect(json).not.toMatch(/router-alpha|whsec|TOTP|hostname core/);
    }
  });

  it('a second run with the old key is refused and says the database looks already rotated', async () => {
    const err = await rotateEncryptionKey({ databaseUrl: db.ownerUrl, oldKey: OLD, newKey: NEW }).catch((e) => e);
    expect(err.reason).toBe('undecryptable');
    expect(err.message).toMatch(/already decrypt with the NEW key/);
  });
});
