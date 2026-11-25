import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readEnv } from '../config/env-compat.ts';

/*
 * Files the API keeps outside PostgreSQL (docs/features/android.md "Where APK files live").
 *
 * Today one backend: the local disk, under
 *   <NIGAFIY_FILES_DIR>/<namespace>/<organization id>/<sha256>
 * NIGAFIY_FILES_DIR defaults to <NIGAFIY_DATA_DIR>/files (legacy LD_DATA_DIR; else <repo>/.data/files).
 *
 *  - Content-addressed: a file's name is the SHA-256 of its bytes. The database keeps only the key
 *    "<namespace>/<organization id>/<sha256>" (plus size and SHA-256) and never a path.
 *  - One folder per organization, so the tenant boundary of Row Level Security also holds on disk.
 *  - Paths are built only from a validated namespace, a UUID and a 64-hex digest: no caller-supplied
 *    text ever reaches the file system, and every path is checked to stay under the root.
 *  - Writes stream to ".tmp-<random>" in the same folder (the request body is never held in memory),
 *    are flushed to disk (fsync), read back and checked for size and SHA-256, and only then renamed
 *    into place (atomic on one file system). An interrupted write leaves only a ".tmp-" file, which
 *    the sweep removes once it is old enough.
 *  - Reads check the size before the first byte and the SHA-256 while streaming; the last chunk is
 *    held back until the digest matches, so a damaged file is never delivered complete.
 *
 * The FileStore interface is what an S3-compatible object store would implement later (put by key,
 * verified read, remove, list). No such client is included: the local disk is the only backend.
 */

export type FileNamespace = 'apks';
const NAMESPACES: readonly FileNamespace[] = ['apks'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^(apks)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;
const TEMP = /^\.tmp-[0-9a-f]{32}$/;

export type FileStoreProblem = 'empty' | 'too_large' | 'missing' | 'corrupt' | 'invalid_key';

export class FileStoreError extends Error {
  readonly problem: FileStoreProblem;
  constructor(problem: FileStoreProblem, message: string) {
    super(message);
    this.name = 'FileStoreError';
    this.problem = problem;
  }
}

export interface ParsedKey {
  namespace: FileNamespace;
  organizationId: string;
  sha256: string;
}

/** The storage key of a file: "<namespace>/<organization id>/<sha256>". Throws on anything else. */
export function storageKey(namespace: FileNamespace, organizationId: string, sha256: string): string {
  const org = organizationId.toLowerCase();
  if (!NAMESPACES.includes(namespace) || !UUID.test(org) || !SHA256.test(sha256)) throw new FileStoreError('invalid_key', 'invalid storage key parts');
  return `${namespace}/${org}/${sha256}`;
}

export function parseStorageKey(key: string): ParsedKey {
  const m = KEY.exec(key);
  if (!m) throw new FileStoreError('invalid_key', 'invalid storage key');
  return { namespace: m[1] as FileNamespace, organizationId: m[2]!, sha256: m[3]! };
}

/** The data folder: NIGAFIY_DATA_DIR (legacy LD_DATA_DIR), else <repo>/.data — the same rule as ops/backup.ts dataDir(). */
function dataRoot(): string {
  const fromEnv = readEnv('NIGAFIY_DATA_DIR');
  return fromEnv ? path.resolve(fromEnv) : path.resolve(import.meta.dirname, '../../../../.data');
}

/** Root of the local file store: NIGAFIY_FILES_DIR, else <data folder>/files. Read on every call. */
export function filesRoot(): string {
  const fromEnv = readEnv('NIGAFIY_FILES_DIR');
  return fromEnv ? path.resolve(fromEnv) : path.join(dataRoot(), 'files');
}

/** A file written to a temporary name and checked; `commit()` moves it to its content address. */
export interface StagedFile {
  readonly sha256: string;
  readonly size: number;
  /** Up to the first 64 bytes (for a type sniff before committing). */
  readonly head: Buffer;
  /** Renames the file to its key (keeps an existing, intact copy). Returns the key. */
  commit(): Promise<string>;
  /** Removes the temporary file (no-op after commit). */
  discard(): Promise<void>;
}

export interface ScanEntry {
  /** 'object': a stored file; 'temp': an unfinished write; 'other': anything else (left alone). */
  kind: 'object' | 'temp' | 'other';
  /** The storage key (objects only). */
  key: string | null;
  organizationId: string | null;
  size: number;
  mtimeMs: number;
  /** Opaque handle for removeEntry(). */
  readonly ref: string;
}

export interface FileStore {
  readonly backend: 'local';
  /** Streams `source` into a temporary file of `organizationId`'s folder; refuses more than `maxBytes`. */
  stage(namespace: FileNamespace, organizationId: string, source: Readable, opts: { maxBytes: number }): Promise<StagedFile>;
  /** Size of the stored file, or null when it does not exist. */
  stat(key: string): Promise<{ size: number } | null>;
  /** A stream of the file that fails ('missing' before, 'corrupt' before or at the end) unless size and SHA-256 match. */
  openVerified(key: string, expect: { sha256: string; size: number }): Promise<Readable>;
  /** Reads the whole file and checks it (no bytes returned). */
  verify(key: string, expect: { sha256: string; size: number }): Promise<'ok' | 'missing' | 'corrupt'>;
  /** Deletes the stored file; false when it was not there. */
  remove(key: string): Promise<boolean>;
  /** Every entry under a namespace (for the sweep). */
  scan(namespace: FileNamespace): AsyncIterable<ScanEntry>;
  /** Removes a scanned entry ('object' or 'temp' only). */
  removeEntry(entry: ScanEntry): Promise<void>;
}

/** The local-disk store. `root` defaults to filesRoot() at each call (so the setting is read live). */
export class LocalFileStore implements FileStore {
  readonly backend = 'local' as const;
  private readonly fixedRoot: string | null;

  constructor(root?: string) {
    this.fixedRoot = root ? path.resolve(root) : null;
  }

  root(): string {
    return this.fixedRoot ?? filesRoot();
  }

  /** The absolute path of a key; throws when the key is malformed or would leave the root. */
  pathOf(key: string): string {
    const k = parseStorageKey(key);
    return this.inside(path.join(this.root(), k.namespace, k.organizationId, k.sha256));
  }

  private orgDir(namespace: FileNamespace, organizationId: string): string {
    const org = organizationId.toLowerCase();
    if (!NAMESPACES.includes(namespace) || !UUID.test(org)) throw new FileStoreError('invalid_key', 'invalid storage key parts');
    return this.inside(path.join(this.root(), namespace, org));
  }

  private inside(p: string): string {
    const root = this.root();
    const rel = path.relative(root, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new FileStoreError('invalid_key', 'path outside the file store');
    return p;
  }

  async stage(namespace: FileNamespace, organizationId: string, source: Readable, opts: { maxBytes: number }): Promise<StagedFile> {
    const dir = this.orgDir(namespace, organizationId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.tmp-${randomBytes(16).toString('hex')}`);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) {
          cb(new FileStoreError('too_large', `more than ${opts.maxBytes} bytes`));
          return;
        }
        if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      // flush: the descriptor is fsync'ed before it is closed.
      await pipeline(source, meter, fs.createWriteStream(tmp, { mode: 0o600, flush: true }));
      if (size === 0) throw new FileStoreError('empty', 'no bytes received');
      const sha256 = hash.digest('hex');
      // Read back what reached the disk.
      const disk = await hashFile(tmp);
      if (disk.size !== size || disk.sha256 !== sha256) throw new FileStoreError('corrupt', 'the written file does not match what was received');
      let done = false;
      return {
        sha256,
        size,
        head,
        commit: async () => {
          const key = storageKey(namespace, organizationId, sha256);
          const final = this.pathOf(key);
          if ((await this.verify(key, { sha256, size })) === 'ok') {
            await fsp.rm(tmp, { force: true });
          } else {
            await fsp.rename(tmp, final);
            await fsyncDir(dir);
          }
          done = true;
          return key;
        },
        discard: async () => {
          if (!done) await fsp.rm(tmp, { force: true });
          done = true;
        },
      };
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const s = await fsp.stat(this.pathOf(key));
      return s.isFile() ? { size: s.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async openVerified(key: string, expect: { sha256: string; size: number }): Promise<Readable> {
    const file = this.pathOf(key);
    const st = await this.stat(key);
    if (!st) throw new FileStoreError('missing', 'the stored file is missing');
    if (st.size !== expect.size) throw new FileStoreError('corrupt', `the stored file has ${st.size} bytes, expected ${expect.size}`);
    const hash = createHash('sha256');
    let seen = 0;
    let held: Buffer | null = null;
    const check = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        hash.update(chunk);
        const out = held;
        held = chunk;
        cb(null, out ?? undefined);
      },
      flush(cb) {
        const digest = hash.digest('hex');
        if (seen !== expect.size || digest !== expect.sha256) {
          cb(new FileStoreError('corrupt', 'the stored file does not match its SHA-256'));
          return;
        }
        cb(null, held ?? undefined);
      },
    });
    const src = fs.createReadStream(file);
    src.on('error', (err) => check.destroy(err));
    return src.pipe(check);
  }

  async verify(key: string, expect: { sha256: string; size: number }): Promise<'ok' | 'missing' | 'corrupt'> {
    const st = await this.stat(key);
    if (!st) return 'missing';
    if (st.size !== expect.size) return 'corrupt';
    const got = await hashFile(this.pathOf(key));
    return got.sha256 === expect.sha256 && got.size === expect.size ? 'ok' : 'corrupt';
  }

  async remove(key: string): Promise<boolean> {
    const file = this.pathOf(key);
    try {
      await fsp.unlink(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async *scan(namespace: FileNamespace): AsyncIterable<ScanEntry> {
    if (!NAMESPACES.includes(namespace)) return;
    const base = path.join(this.root(), namespace);
    let orgs: fs.Dirent[];
    try {
      orgs = await fsp.readdir(base, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const o of orgs) {
      if (!o.isDirectory() || !UUID.test(o.name)) continue;
      const dir = path.join(base, o.name);
      for (const f of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const ref = path.join(dir, f.name);
        let st: fs.Stats;
        try {
          st = await fsp.stat(ref);
        } catch {
          continue;
        }
        const kind = SHA256.test(f.name) ? 'object' : TEMP.test(f.name) ? 'temp' : 'other';
        yield { kind, key: kind === 'object' ? `${namespace}/${o.name}/${f.name}` : null, organizationId: o.name, size: st.size, mtimeMs: st.mtimeMs, ref };
      }
    }
  }

  async removeEntry(entry: ScanEntry): Promise<void> {
    if (entry.kind === 'other') throw new FileStoreError('invalid_key', 'only stored or temporary files are removed');
    const name = path.basename(entry.ref);
    if (entry.kind === 'object' ? !SHA256.test(name) : !TEMP.test(name)) throw new FileStoreError('invalid_key', 'not a file of the store');
    await fsp.rm(this.inside(entry.ref), { force: true });
  }
}

export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += (chunk as Buffer).length;
    h.update(chunk as Buffer);
  }
  return { sha256: h.digest('hex'), size };
}

/** Makes a rename durable on POSIX file systems; Windows cannot open a folder for fsync (NTFS journals the rename). */
async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await fsp.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

let store: FileStore | null = null;

/** The store this API uses (the local disk). */
export function fileStore(): FileStore {
  store ??= new LocalFileStore();
  return store;
}
