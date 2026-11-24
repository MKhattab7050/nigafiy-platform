import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret, encryptSecret } from '../../../common/crypto.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { dataDir } from '../../../ops/backup.ts';

/*
 * Session recordings (Fleet Pro, migration 036). What is kept: the frames the operators saw (the
 * same packets the stream relays) and the timing of operator input — the kind of each event and,
 * for the mouse, where it went. Typed keys and text never: a key event is recorded as "key" only.
 *
 * Files: <data>/recordings/<org>/<recording id>/seg-<start ms>.nrec, written by the API instance
 * that holds the agent's socket. Each segment starts with "NREC1\n" and holds records
 *   [u32 BE length][12-byte nonce][AES-256-GCM ciphertext + 16-byte tag]
 * under the recording's own 256-bit key (fleet_recordings.key_sealed, sealed with
 * APP_ENCRYPTION_KEY and re-sealed by rotate-key). The additional data is "<id>|<segment>", so a
 * record cannot be moved to another recording or segment unnoticed. Plaintext:
 *   [u8 type][u64 BE epoch ms][payload]   type 1 frame packet, 2 input timing JSON, 3 event JSON
 */

export const REC_FRAME = 1;
export const REC_INPUT = 2;
export const REC_EVENT = 3;
const MAGIC = Buffer.from('NREC1\n');
const SEGMENT_MS = 10 * 60_000;
const SEGMENT_BYTES = 256 << 20;
const MAX_RECORD = 16 << 20;

export const recordingsRoot = (): string => path.join(dataDir(), 'recordings');
export const recordingDir = (orgId: string, id: string): string => path.join(recordingsRoot(), orgId, id);

const SAFE = /^[0-9a-f-]{36}$/i;
const SEGMENT_NAME = /^seg-\d{13}\.nrec$/;

/** A new recording row with its own key (sealed); the key is returned to the caller only. */
export async function createRecording(
  db: Db,
  o: { orgId: string; endpointId: string; fleetSessionId: string; publicId: string; email: string | null; retentionDays: number },
): Promise<string> {
  const key = randomBytes(32);
  const r = await db.query<{ id: string }>(
    `INSERT INTO fleet_recordings (organization_id, endpoint_id, fleet_session_id, session_public_id, key_sealed, started_by_email, retention_days, retention_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $7)) RETURNING id`,
    [o.orgId, o.endpointId, o.fleetSessionId, o.publicId, encryptSecret(key.toString('base64')), o.email, o.retentionDays],
  );
  return r.rows[0]!.id;
}

async function recordingKey(orgId: string, id: string): Promise<Buffer | null> {
  const row = await withTenant(orgId, async (db) => (await db.query<{ key_sealed: string }>(`SELECT key_sealed FROM fleet_recordings WHERE id = $1`, [id])).rows[0]);
  return row ? Buffer.from(decryptSecret(row.key_sealed), 'base64') : null;
}

export function sealRecord(key: Buffer, aad: string, type: number, at: number, payload: Buffer): Buffer {
  const plain = Buffer.alloc(9 + payload.length);
  plain[0] = type;
  plain.writeBigUInt64BE(BigInt(at), 1);
  payload.copy(plain, 9);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(12 + ct.length);
  return Buffer.concat([len, nonce, ct]);
}

export interface PlainRecord {
  type: number;
  at: number;
  payload: Buffer;
}

/** Decrypts a whole segment; a damaged or tampered record stops the reading there (error set). */
export function openSegment(key: Buffer, aad: string, file: Buffer): { records: PlainRecord[]; error: string | null } {
  const records: PlainRecord[] = [];
  if (file.length < MAGIC.length || !file.subarray(0, MAGIC.length).equals(MAGIC)) return { records, error: 'not a recording segment' };
  let off = MAGIC.length;
  while (off < file.length) {
    if (off + 4 > file.length) return { records, error: 'truncated record' };
    const len = file.readUInt32BE(off);
    if (len < 12 + 16 + 9 || len > MAX_RECORD + 64 || off + 4 + len > file.length) return { records, error: 'truncated record' };
    const nonce = file.subarray(off + 4, off + 16);
    const body = file.subarray(off + 16, off + 4 + len);
    try {
      const d = createDecipheriv('aes-256-gcm', key, nonce);
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(body.subarray(body.length - 16));
      const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
      records.push({ type: plain[0]!, at: Number(plain.readBigUInt64BE(1)), payload: plain.subarray(9) });
    } catch {
      return { records, error: 'a record failed authentication (damaged or altered)' };
    }
    off += 4 + len;
  }
  return { records, error: null };
}

/**
 * Writes one recording. Synchronous appends: a crash loses at most the record being written, and
 * every record already on disk stays readable on its own.
 */
export class RecordingWriter {
  frames = 0;
  inputs = 0;
  bytes = 0;
  segments = 0;
  private fd: number | null = null;
  private segment = '';
  private segmentStarted = 0;
  private segmentBytes = 0;
  private closed = false;
  private flushedAt = 0;
  /** Asks the agent for a whole picture (each segment starts with one). */
  onNeedFull: () => void = () => undefined;

  readonly id: string;
  readonly orgId: string;
  private readonly key: Buffer;
  private readonly dir: string;

  private constructor(id: string, orgId: string, key: Buffer, dir: string) {
    this.id = id;
    this.orgId = orgId;
    this.key = key;
    this.dir = dir;
  }

  static async open(orgId: string, id: string): Promise<RecordingWriter | null> {
    if (!SAFE.test(id) || !SAFE.test(orgId)) return null;
    const key = await recordingKey(orgId, id);
    if (!key) return null;
    const dir = recordingDir(orgId, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new RecordingWriter(id, orgId, key, dir);
  }

  get active(): boolean {
    return !this.closed;
  }

  private rotate(now: number): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.segment = `seg-${String(now).padStart(13, '0')}.nrec`;
    this.fd = fs.openSync(path.join(this.dir, this.segment), 'a', 0o600);
    fs.writeSync(this.fd, MAGIC);
    this.segmentStarted = now;
    this.segmentBytes = MAGIC.length;
    this.segments++;
    this.bytes += MAGIC.length;
    this.onNeedFull();
  }

  private write(type: number, payload: Buffer): void {
    if (this.closed || payload.length > MAX_RECORD) return;
    const now = Date.now();
    try {
      if (this.fd === null || now - this.segmentStarted > SEGMENT_MS || this.segmentBytes > SEGMENT_BYTES) this.rotate(now);
      const rec = sealRecord(this.key, `${this.id}|${this.segment}`, type, now, payload);
      fs.writeSync(this.fd!, rec);
      this.segmentBytes += rec.length;
      this.bytes += rec.length;
    } catch (err) {
      logger.error({ err, recording: this.id }, 'session recording write failed');
      void this.close('failed', (err as Error).message);
    }
  }

  frame(packet: Buffer): void {
    this.frames++;
    this.write(REC_FRAME, packet);
  }

  /** Input timing only: the kind, the display and the pointer position — never a key or text. */
  input(ev: { kind: string; display_index?: number; x?: number; y?: number }): void {
    this.inputs++;
    const mouse = ev.kind.startsWith('mouse');
    const k = mouse ? ev.kind : 'key';
    this.write(REC_INPUT, Buffer.from(JSON.stringify(mouse ? { k, d: ev.display_index ?? 0, x: ev.x, y: ev.y } : { k })));
  }

  event(e: Record<string, unknown>): void {
    this.write(REC_EVENT, Buffer.from(JSON.stringify(e)));
  }

  async flush(force = false): Promise<void> {
    if (!force && Date.now() - this.flushedAt < 5_000) return;
    this.flushedAt = Date.now();
    await withTenant(this.orgId, (db) =>
      db.query(`UPDATE fleet_recordings SET frames = $2, input_events = $3, bytes = $4, segments = $5 WHERE id = $1`, [this.id, this.frames, this.inputs, this.bytes, this.segments]),
    ).catch((err: unknown) => logger.warn({ err }, 'recording counters update failed'));
  }

  async close(state: 'complete' | 'failed' = 'complete', error: string | null = null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    await withTenant(this.orgId, (db) =>
      db.query(
        `UPDATE fleet_recordings SET state = CASE WHEN state = 'deleted' THEN state ELSE $6 END, error = coalesce($7, error), ended_at = coalesce(ended_at, now()),
                frames = $2, input_events = $3, bytes = $4, segments = $5 WHERE id = $1`,
        [this.id, this.frames, this.inputs, this.bytes, this.segments, state, error],
      ),
    ).catch((err: unknown) => logger.warn({ err }, 'recording close update failed'));
  }
}

/** The segments of a recording, oldest first. */
export function listSegments(orgId: string, id: string): Array<{ name: string; bytes: number; started_at: string }> {
  if (!SAFE.test(id) || !SAFE.test(orgId)) return [];
  const dir = recordingDir(orgId, id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => SEGMENT_NAME.test(n))
    .sort()
    .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size, started_at: new Date(Number(name.slice(4, 17))).toISOString() }));
}

/** A segment decrypted for playback: [u32 BE length][plaintext record] repeated. */
export async function readSegmentForPlayback(orgId: string, id: string, name: string): Promise<{ body: Buffer; records: number; error: string | null } | null> {
  if (!SEGMENT_NAME.test(name) || !SAFE.test(id)) return null;
  const file = path.join(recordingDir(orgId, id), name);
  if (!fs.existsSync(file)) return null;
  const key = await recordingKey(orgId, id);
  if (!key) return null;
  const { records, error } = openSegment(key, `${id}|${name}`, fs.readFileSync(file));
  const parts: Buffer[] = [];
  for (const r of records) {
    const head = Buffer.alloc(13);
    head.writeUInt32BE(9 + r.payload.length);
    head[4] = r.type;
    head.writeBigUInt64BE(BigInt(r.at), 5);
    parts.push(head, r.payload);
  }
  return { body: Buffer.concat(parts), records: records.length, error };
}

export function removeRecordingFiles(orgId: string, id: string): void {
  if (!SAFE.test(id) || !SAFE.test(orgId)) return;
  fs.rmSync(recordingDir(orgId, id), { recursive: true, force: true });
}

/** Retention job: files past their group's retention are removed; the row stays, marked deleted. */
export async function runRecordingRetention(): Promise<number> {
  const due = await withSystem(async (db) =>
    (
      await db.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM fleet_recordings WHERE state <> 'deleted' AND retention_until <= now() ORDER BY retention_until LIMIT 200`,
      )
    ).rows,
  );
  for (const r of due) {
    removeRecordingFiles(r.organization_id, r.id);
    await withSystem((db) =>
      db.query(
        `WITH d AS (UPDATE fleet_recordings SET state = 'deleted', deleted_at = now(), delete_reason = 'retention' WHERE id = $1 AND state <> 'deleted' RETURNING id, organization_id, endpoint_id, session_public_id)
         INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
         SELECT organization_id, NULL, NULL, 'fleet.recording_deleted', 'endpoint', endpoint_id, jsonb_build_object('recording_id', id, 'session_id', session_public_id, 'reason', 'retention'), 'system' FROM d`,
        [r.id],
      ),
    );
  }
  // A recording whose session ended without the writing instance closing it (that instance stopped).
  await withSystem((db) =>
    db.query(
      `UPDATE fleet_recordings r SET state = 'complete', ended_at = coalesce(r.ended_at, f.ended_at, now())
         FROM fleet_sessions f WHERE f.id = r.fleet_session_id AND r.state = 'recording' AND f.state = 'ended' AND f.ended_at < now() - interval '5 minutes'`,
    ),
  );
  return due.length;
}
