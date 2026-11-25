import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStore, filesRoot, parseStorageKey, storageKey } from '../src/infrastructure/file-store.ts';
import { migrate } from '../src/database/migrate.ts';
import { dropDatabase, scratchDatabase, withClient } from './ops-db.ts';

// The file store (infrastructure/file-store.ts) on its own, and migration 048 moving APK bytes out
// of an existing database. Real disk, real PostgreSQL; nothing mocked.

const root = mkdtempSync(path.join(tmpdir(), 'nigafiy-store-'));
const store = new LocalFileStore(root);
const ORG = '3f2a6c1e-8d4b-4e7a-9c0f-1b2d3e4f5a6b';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const folder = () => (existsSync(path.join(root, 'apks', ORG)) ? readdirSync(path.join(root, 'apks', ORG)) : []);
const drops: string[] = [];

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  for (const d of drops) await dropDatabase(d);
});

describe('file store', () => {
  it('stores by content, keeps one copy of the same bytes, and reads back verified', async () => {
    const bytes = Buffer.from('PK\u0003\u0004 some apk bytes');
    const a = await store.stage('apks', ORG, Readable.from([bytes]), { maxBytes: 1024 });
    expect({ sha256: a.sha256, size: a.size }).toEqual({ sha256: sha(bytes), size: bytes.length });
    const key = await a.commit();
    expect(key).toBe(`apks/${ORG}/${sha(bytes)}`);
    const b = await store.stage('apks', ORG, Readable.from([bytes]), { maxBytes: 1024 });
    expect(await b.commit()).toBe(key);
    expect(folder()).toEqual([sha(bytes)]);
    const chunks: Buffer[] = [];
    for await (const c of await store.openVerified(key, { sha256: sha(bytes), size: bytes.length })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(await store.verify(key, { sha256: sha(bytes), size: bytes.length })).toBe('ok');
    expect(await store.remove(key)).toBe(true);
    expect(await store.remove(key)).toBe(false);
    expect(await store.verify(key, { sha256: sha(bytes), size: bytes.length })).toBe('missing');
  });

  it('an interrupted or oversized write leaves no file behind', async () => {
    const broken = new PassThrough();
    const staging = store.stage('apks', ORG, broken, { maxBytes: 1 << 20 });
    broken.write(Buffer.alloc(4096, 1));
    setTimeout(() => broken.destroy(new Error('client went away')), 20);
    await expect(staging).rejects.toThrow('client went away');
    await expect(store.stage('apks', ORG, Readable.from([Buffer.alloc(2048)]), { maxBytes: 1024 })).rejects.toMatchObject({ problem: 'too_large' });
    await expect(store.stage('apks', ORG, Readable.from([]), { maxBytes: 1024 })).rejects.toMatchObject({ problem: 'empty' });
    expect(folder()).toEqual([]);
    // A staged file that is never committed is discarded.
    const s = await store.stage('apks', ORG, Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    expect(folder()).toHaveLength(1);
    await s.discard();
    expect(folder()).toEqual([]);
  });

  it('paths come only from validated keys: traversal is impossible', async () => {
    const h = 'a'.repeat(64);
    for (const bad of [`apks/../${ORG}/${h}`, `apks/${ORG}/../../${h}`, `../apks/${ORG}/${h}`, `apks/${ORG}/${h}/..`, `other/${ORG}/${h}`, `apks/${ORG.toUpperCase()}/${h}`, `apks\\${ORG}\\${h}`, `apks/${ORG}/${'A'.repeat(64)}`, '']) {
      expect(() => parseStorageKey(bad), bad).toThrow();
      expect(() => store.pathOf(bad), bad).toThrow();
      await expect(store.stat(bad)).rejects.toThrow();
      await expect(store.remove(bad)).rejects.toThrow();
    }
    expect(() => storageKey('apks', '../../etc', h)).toThrow();
    expect(() => storageKey('apks', ORG, '../passwd')).toThrow();
    await expect(store.stage('apks', '..', Readable.from([Buffer.from('x')]), { maxBytes: 10 })).rejects.toThrow();
    // removeEntry only touches store-named files under the root.
    await expect(store.removeEntry({ kind: 'temp', key: null, organizationId: ORG, size: 1, mtimeMs: 0, ref: path.join(root, '..', 'victim') })).rejects.toThrow();
    await expect(store.removeEntry({ kind: 'other', key: null, organizationId: ORG, size: 1, mtimeMs: 0, ref: path.join(root, 'apks', ORG, 'x') })).rejects.toThrow();
    expect(store.pathOf(`apks/${ORG}/${h}`)).toBe(path.join(root, 'apks', ORG, h));
  });

  it('the default root is <data folder>/files unless NIGAFIY_FILES_DIR is set', () => {
    const saved = process.env.NIGAFIY_FILES_DIR;
    const savedData = process.env.NIGAFIY_DATA_DIR;
    try {
      delete process.env.NIGAFIY_FILES_DIR;
      process.env.NIGAFIY_DATA_DIR = path.join(root, 'data');
      expect(filesRoot()).toBe(path.join(root, 'data', 'files'));
      process.env.NIGAFIY_FILES_DIR = path.join(root, 'elsewhere');
      expect(filesRoot()).toBe(path.join(root, 'elsewhere'));
    } finally {
      if (saved === undefined) delete process.env.NIGAFIY_FILES_DIR;
      else process.env.NIGAFIY_FILES_DIR = saved;
      if (savedData === undefined) delete process.env.NIGAFIY_DATA_DIR;
      else process.env.NIGAFIY_DATA_DIR = savedData;
    }
  });
});

describe('migration 048: APK bytes move from the database to the file store', () => {
  it('moves every row, refuses on a mismatch without changing anything, and runs again cleanly', async () => {
    const db = await scratchDatabase('apk_move', { migrate: false });
    drops.push(db.name);
    await migrate(db.ownerUrl, db.appUrl, undefined, { stopBefore: '048_android_apk_files.sql' });
    const good = Buffer.from('PK\u0003\u0004 an apk from before 048');
    const bad = Buffer.from('PK\u0003\u0004 bytes whose recorded digest is wrong');
    const { org, badId } = await withClient(db.ownerUrl, async (c) => {
      const o = (await c.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Move test') RETURNING id`)).rows[0]!.id;
      await c.query(
        `INSERT INTO fleet_android_apks (organization_id, name, file_name, size_bytes, sha256, content, uploaded_by_email) VALUES ($1,'Good','good.apk',$2,$3,$4,'a@example.com')`,
        [o, good.length, sha(good), good],
      );
      const b = (
        await c.query<{ id: string }>(
          `INSERT INTO fleet_android_apks (organization_id, name, file_name, size_bytes, sha256, content, uploaded_by_email) VALUES ($1,'Bad','bad.apk',$2,$3,$4,'a@example.com') RETURNING id`,
          [o, bad.length, 'f'.repeat(64), bad],
        )
      ).rows[0]!.id;
      return { org: o, badId: b };
    });
    const hasContent = () =>
      withClient(db.ownerUrl, async (c) => Boolean((await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'fleet_android_apks' AND column_name = 'content'`)).rowCount));

    // A row whose bytes do not match its SHA-256: the migration stops, `content` is untouched.
    await expect(migrate(db.ownerUrl, db.appUrl)).rejects.toThrow(/048_android_apk_files\.sql failed: APK .* do not match/);
    expect(await hasContent()).toBe(true);

    // Fix the record; the next run (as at the next start) completes. The good file written by the
    // failed run is simply reused.
    await withClient(db.ownerUrl, (c) => c.query(`UPDATE fleet_android_apks SET sha256 = $2 WHERE id = $1`, [badId, sha(bad)]));
    const logs: string[] = [];
    await migrate(db.ownerUrl, db.appUrl, (m) => logs.push(m));
    expect(logs).toContain('moved 2 APK file(s) from the database to the file store');
    expect(await hasContent()).toBe(false);
    const rows = await withClient(db.ownerUrl, async (c) => (await c.query<{ storage_key: string; sha256: string }>(`SELECT storage_key, sha256 FROM fleet_android_apks ORDER BY name DESC`)).rows);
    expect(rows).toEqual([
      { storage_key: `apks/${org}/${sha(good)}`, sha256: sha(good) },
      { storage_key: `apks/${org}/${sha(bad)}`, sha256: sha(bad) },
    ]);
    expect(readFileSync(path.join(filesRoot(), 'apks', org, sha(good))).equals(good)).toBe(true);
    expect(readFileSync(path.join(filesRoot(), 'apks', org, sha(bad))).equals(bad)).toBe(true);
    expect(readdirSync(path.join(filesRoot(), 'apks', org)).sort()).toEqual([sha(good), sha(bad)].sort());

    // RLS and grants unchanged: the app role still sees only its organization's rows.
    const seen = await withClient(db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_org', $1, true)`, ['00000000-0000-4000-8000-000000000000']);
      const n = (await c.query(`SELECT count(*)::int AS n FROM fleet_android_apks`)).rows[0].n as number;
      await c.query('ROLLBACK');
      return n;
    });
    expect(seen).toBe(0);
  });

  it('applying 048 outside the migrator refuses while APKs are in the table', async () => {
    const db = await scratchDatabase('apk_psql', { migrate: false });
    drops.push(db.name);
    await migrate(db.ownerUrl, db.appUrl, undefined, { stopBefore: '048_android_apk_files.sql' });
    const sql = readFileSync(path.join(import.meta.dirname, '../src/database/migrations/048_android_apk_files.sql'), 'utf8');
    const bytes = Buffer.from('PK\u0003\u0004 x');
    await withClient(db.ownerUrl, async (c) => {
      const o = (await c.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Psql test') RETURNING id`)).rows[0]!.id;
      await c.query(
        `INSERT INTO fleet_android_apks (organization_id, name, file_name, size_bytes, sha256, content, uploaded_by_email) VALUES ($1,'A','a.apk',$2,$3,$4,'a@example.com')`,
        [o, bytes.length, sha(bytes), bytes],
      );
      await c.query('BEGIN');
      await expect(c.query(sql)).rejects.toThrow(/not moved to the file store/);
      await c.query('ROLLBACK');
    });
  });
});
