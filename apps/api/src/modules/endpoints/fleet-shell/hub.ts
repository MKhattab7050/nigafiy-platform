import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Role } from '@nigafiy/shared-types';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { AppError } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { systemPool, withTenant } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { onNotification } from '../../../infrastructure/pg-listen.ts';
import { readCookie, resolveSessionToken, SESSION_COOKIE } from '../../auth/index.ts';
import { authenticateAgentCredential } from '../agent/auth.ts';
import { CLOSE_POLICY, DEFAULT_WS_LIMITS, MessageRate, heartbeat, type WsLimits } from '../../../common/ws-guard.ts';
import { openTranscriptKey, sealChunk } from './transcript.ts';
import { endShell, SHELL_CHANNEL } from './shells.ts';
import { shellAgentMessage, shellOperatorMessage } from './schema.ts';

/*
 * Remote shell sockets (Fleet Pro). Binary messages carry terminal bytes: keystrokes from the
 * operator to the agent, the shell's output from the agent to the operator. Text messages are JSON
 * control (resize, hello, exit, end).
 *
 *   /api/v1/agent/shell?shell=P                      the agent (agent credential; one per shell)
 *   /api/v1/endpoints/:id/shell/stream?shell=P       the operator who opened it (session cookie,
 *                                                     Origin = WEB_ORIGIN, admin or owner)
 *
 * The instance holding the agent's socket writes the transcript: every chunk in both directions
 * is sealed (transcript.ts) and written in small batches (FLUSH_MS); consecutive chunks of one
 * direction are merged. When the operator's socket is on another API instance, bytes travel over
 * pg_notify on SHELL_CHANNEL in base64 pieces below the 8000-byte payload limit:
 *   o|P|b64    output for the operators          i|P|b64   input for the agent
 *   r|P|c|r    resize                            who|P     an operator joined elsewhere (send the screen)
 *   end|P|why  the shell ended (shells.ts, on COMMIT): every socket of it is closed with 4000
 * The holder ends the shell when the transcript reaches its limit or after the idle timeout (no
 * byte either way), and when the agent's socket goes.
 */

const AGENT_PATH = '/api/v1/agent/shell';
const OPERATOR_PATH = /^\/api\/v1\/endpoints\/([0-9a-f-]{36})\/shell\/stream$/i;
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** Close code: the shell is over. */
export const CLOSE_SHELL_ENDED = 4000;
const MAX_INPUT_MESSAGE = 64 << 10;
const MAX_OUTPUT_MESSAGE = 1 << 20;
const FLUSH_MS = 200;
const MERGE_LIMIT = 32 << 10;
/** Output kept to repaint an operator's terminal when they (re)connect. */
const SCROLLBACK = 64 << 10;
/** base64 characters per pg_notify piece (payload limit 8000 bytes). */
const NOTIFY_PIECE = 6000;
const ROLE_RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };
/** Operator sockets (browser tabs) of one shell. */
const MAX_OPERATOR_SOCKETS = 4;

interface Chunk {
  direction: 'i' | 'o' | 'e';
  at: Date;
  data: Buffer;
}

interface Room {
  publicId: string;
  shellId: string;
  orgId: string;
  endpointId: string;
  agent: WebSocket | null;
  operators: Set<WebSocket>;
  /** Only on the instance holding the agent's socket. */
  key: Buffer | null;
  pending: Chunk[];
  transcriptBytes: number;
  maxBytes: number;
  idleTimeoutS: number;
  lastActivity: number;
  bytesIn: number;
  bytesOut: number;
  flushedIn: number;
  flushedOut: number;
  scrollback: Buffer[];
  scrollbackBytes: number;
  hello: string | null;
  ending: boolean;
  flushing: Promise<void>;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class ShellHub {
  /** The agent sends the shell's output. */
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_OUTPUT_MESSAGE });
  /** The operator sends keystrokes (a paste is one message) and resizes (EXT-2). */
  private readonly operatorWss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_MESSAGE });
  private readonly rooms = new Map<string, Room>();
  readonly limits: WsLimits;

  constructor(limits: Partial<WsLimits> = {}) {
    this.limits = { ...DEFAULT_WS_LIMITS, ...limits };
  }
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    this.unsubscribe ??= onNotification(SHELL_CHANNEL, (p) => this.onNotify(p));
    this.timer ??= setInterval(() => void this.tick(), FLUSH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of [...this.rooms.values()]) {
      await this.flush(r);
      r.agent?.close(1001, 'server shutting down');
      for (const o of r.operators) o.close(1001, 'server shutting down');
    }
    this.rooms.clear();
  }

  handles(pathname: string): boolean {
    return pathname === AGENT_PATH || OPERATOR_PATH.test(pathname);
  }

  /** Counts for tests. */
  stats(publicId: string): { agent: boolean; operators: number; holder: boolean } | null {
    const r = this.rooms.get(publicId);
    return r ? { agent: r.agent !== null, operators: r.operators.size, holder: r.key !== null } : null;
  }

  /** Settles when the socket was accepted or refused. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, reject: (socket: Duplex, status: number, code: string, message: string) => void): Promise<void> {
    const op = OPERATOR_PATH.exec(url.pathname);
    const task = op ? this.acceptOperator(req, socket, head, url, op[1]!) : this.acceptAgent(req, socket, head, url);
    return task.catch((err: unknown) => {
      if (err instanceof AppError) reject(socket, err.status, err.code, err.message);
      else {
        logger.error({ err }, 'remote shell upgrade failed');
        reject(socket, 500, 'internal_error', 'Shell upgrade failed');
      }
    });
  }

  /** Accepts the socket and starts its heartbeat (a socket that stops answering pings is ended). */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, server: WebSocketServer = this.wss): Promise<WebSocket> {
    return new Promise((resolve) =>
      server.handleUpgrade(req, socket, head, (ws) => {
        heartbeat(ws, this.limits.pingMs);
        resolve(ws);
      }),
    );
  }

  private room(s: { public_id: string; id: string; organization_id: string; endpoint_id: string; max_transcript_bytes: number; idle_timeout_s: number }): Room {
    let r = this.rooms.get(s.public_id);
    if (!r) {
      r = {
        publicId: s.public_id,
        shellId: s.id,
        orgId: s.organization_id,
        endpointId: s.endpoint_id,
        agent: null,
        operators: new Set(),
        key: null,
        pending: [],
        transcriptBytes: 0,
        maxBytes: s.max_transcript_bytes,
        idleTimeoutS: s.idle_timeout_s,
        lastActivity: Date.now(),
        bytesIn: 0,
        bytesOut: 0,
        flushedIn: 0,
        flushedOut: 0,
        scrollback: [],
        scrollbackBytes: 0,
        hello: null,
        ending: false,
        flushing: Promise.resolve(),
      };
      this.rooms.set(s.public_id, r);
    }
    return r;
  }

  private dropIfEmpty(r: Room): void {
    if (!r.agent && r.operators.size === 0 && this.rooms.get(r.publicId) === r) {
      void this.flush(r);
      this.rooms.delete(r.publicId);
    }
  }

  // ── Agent ──

  private async acceptAgent(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const ep = await authenticateAgentCredential(req.headers.authorization);
    if (!ep) throw new AppError(401, 'invalid_agent_credential', 'Agent credential is invalid or revoked');
    const publicId = url.searchParams.get('shell') ?? '';
    if (!PUBLIC_ID.test(publicId)) throw new AppError(400, 'bad_request', 'shell is required');
    const s = await withTenant(ep.organizationId, async (db) => {
      const row = (
        await db.query<{ id: string; public_id: string; organization_id: string; endpoint_id: string; state: string; transcript_key_sealed: string; max_transcript_bytes: number; idle_timeout_s: number; bytes: number }>(
          `SELECT sh.id, sh.public_id, sh.organization_id, sh.endpoint_id, sh.state, sh.transcript_key_sealed, sh.max_transcript_bytes, sh.idle_timeout_s,
                  (SELECT coalesce(sum(length(ciphertext) - 28), 0)::float8 FROM fleet_shell_transcript t WHERE t.shell_id = sh.id) AS bytes
             FROM fleet_shell_sessions sh WHERE sh.public_id = $1 AND sh.endpoint_id = $2`,
          [publicId, ep.id],
        )
      ).rows[0];
      if (!row) return null;
      if (row.state === 'closed') return row;
      await db.query(`UPDATE fleet_shell_sessions SET state = 'open', opened_at = coalesce(opened_at, now()), last_activity_at = now() WHERE id = $1`, [row.id]);
      return row;
    });
    if (!s) throw new AppError(404, 'not_found', 'No such shell');
    if (s.state === 'closed') throw new AppError(410, 'shell_closed', 'This shell has ended');
    const ws = await this.upgrade(req, socket, head);
    const r = this.room(s);
    if (r.agent) r.agent.close(4001, 'replaced by a newer connection');
    r.agent = ws;
    r.key = openTranscriptKey(s.transcript_key_sealed);
    r.transcriptBytes = Math.max(r.transcriptBytes, s.bytes);
    r.lastActivity = Date.now();

    ws.on('message', (data, isBinary) => {
      if (r.agent !== ws || r.ending) return;
      const buf = toBuffer(data);
      if (isBinary) {
        this.output(r, buf);
        return;
      }
      let m: unknown;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      const p = shellAgentMessage.safeParse(m);
      if (!p.success) return;
      const msg = p.data;
      if (msg.t === 'hello') {
        r.hello = JSON.stringify({ t: 'hello', shell: msg.shell, pty: msg.pty });
        for (const o of r.operators) o.send(r.hello);
        void withTenant(r.orgId, (db) => db.query(`UPDATE fleet_shell_sessions SET shell = $2, pty = $3 WHERE id = $1`, [r.shellId, msg.shell.slice(0, 200), msg.pty])).catch(() => undefined);
        void this.publish(`hello|${r.publicId}|${Buffer.from(r.hello).toString('base64')}`);
      } else if (msg.t === 'exit') {
        void this.end(r, 'exited', { exitCode: msg.code });
      } else if (msg.t === 'error') {
        void this.end(r, 'open_failed', { error: msg.error });
      }
    });
    const gone = () => {
      if (r.agent !== ws) return;
      r.agent = null;
      // The shell cannot be reached any more: it ends (the agent stops it too).
      if (!r.ending) void this.end(r, 'agent_gone', {});
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  /** Bytes from the shell: transcript, then every operator (here or on another instance). */
  private output(r: Room, buf: Buffer): void {
    if (!buf.length) return;
    r.bytesOut += buf.length;
    r.lastActivity = Date.now();
    this.record(r, 'o', buf);
    r.scrollback.push(buf);
    r.scrollbackBytes += buf.length;
    while (r.scrollbackBytes > SCROLLBACK && r.scrollback.length > 1) r.scrollbackBytes -= r.scrollback.shift()!.length;
    for (const o of r.operators) if (o.readyState === WebSocket.OPEN) o.send(buf, { binary: true });
    if (r.operators.size === 0) void this.publishBytes('o', r.publicId, buf);
  }

  /** Keystrokes from an operator: transcript, then the agent (here or on another instance). */
  private input(r: Room, buf: Buffer): void {
    if (!buf.length) return;
    if (r.agent) {
      r.bytesIn += buf.length;
      r.lastActivity = Date.now();
      this.record(r, 'i', buf);
      if (r.agent.readyState === WebSocket.OPEN) r.agent.send(buf, { binary: true });
    } else {
      void this.publishBytes('i', r.publicId, buf);
    }
  }

  private resize(r: Room, cols: number, rows: number): void {
    if (r.agent) {
      this.record(r, 'e', Buffer.from(`resized to ${cols}x${rows}`));
      r.agent.send(JSON.stringify({ t: 'resize', cols, rows }));
    } else void this.publish(`r|${r.publicId}|${cols}|${rows}`);
  }

  private record(r: Room, direction: Chunk['direction'], data: Buffer): void {
    if (!r.key || r.ending) return;
    r.transcriptBytes += data.length;
    const last = r.pending.at(-1);
    if (last && last.direction === direction && direction !== 'e' && last.data.length + data.length <= MERGE_LIMIT) last.data = Buffer.concat([last.data, data]);
    else r.pending.push({ direction, at: new Date(), data });
    if (r.transcriptBytes > r.maxBytes) void this.end(r, 'limit', {});
  }

  /** Writes the pending chunks (one transaction), with the counters and the activity time. */
  private flush(r: Room): Promise<void> {
    r.flushing = r.flushing.then(async () => {
      if (!r.key || (!r.pending.length && r.bytesIn === r.flushedIn && r.bytesOut === r.flushedOut)) return;
      const batch = r.pending.splice(0);
      const key = r.key;
      const dIn = r.bytesIn - r.flushedIn;
      const dOut = r.bytesOut - r.flushedOut;
      try {
        await withTenant(r.orgId, async (db) => {
          if (batch.length) {
            // Sequence numbers come from the table under a per-shell lock (events are written
            // there too, possibly by another instance): AAD binds each chunk to its number.
            await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [r.shellId]);
            const next = (await db.query<{ n: number }>(`SELECT coalesce(max(seq) + 1, 0)::int AS n FROM fleet_shell_transcript WHERE shell_id = $1`, [r.shellId])).rows[0]!.n;
            const rows = batch.map((c, i) => ({ seq: next + i, direction: c.direction, at: c.at, ct: sealChunk(key, r.publicId, next + i, c.direction, c.data) }));
            await db.query(
              `INSERT INTO fleet_shell_transcript (shell_id, organization_id, seq, direction, at, ciphertext)
               SELECT $1, $2, x.seq, x.direction, x.at, x.ct FROM unnest($3::int[], $4::text[], $5::timestamptz[], $6::bytea[]) AS x(seq, direction, at, ct)`,
              [r.shellId, r.orgId, rows.map((x) => x.seq), rows.map((x) => x.direction), rows.map((x) => x.at), rows.map((x) => x.ct)],
            );
          }
          await db.query(
            `UPDATE fleet_shell_sessions SET transcript_chunks = transcript_chunks + $2, bytes_in = bytes_in + $3, bytes_out = bytes_out + $4,
                    last_activity_at = greatest(last_activity_at, to_timestamp($5 / 1000.0)) WHERE id = $1`,
            [r.shellId, batch.length, dIn, dOut, r.lastActivity],
          );
        });
        r.flushedIn += dIn;
        r.flushedOut += dOut;
      } catch (err) {
        logger.error({ err, shell: r.shellId }, 'shell transcript write failed');
        // A shell that cannot be recorded does not go on.
        if (!r.ending) void this.end(r, 'limit', { error: 'The transcript could not be written' });
      }
    });
    return r.flushing;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const r of this.rooms.values()) {
      if (!r.key) continue;
      await this.flush(r);
      if (!r.ending && now - r.lastActivity > r.idleTimeoutS * 1000) void this.end(r, 'idle', {});
    }
  }

  private async end(r: Room, reason: 'exited' | 'idle' | 'limit' | 'agent_gone' | 'open_failed', extra: { exitCode?: number | null; error?: string }): Promise<void> {
    if (r.ending) return;
    await this.flush(r);
    r.ending = true;
    try {
      await withTenant(r.orgId, (db) => endShell(db, r.orgId, r.shellId, reason, { system: reason === 'exited' ? 'agent' : 'Nigafiy' }, extra));
    } catch (err) {
      logger.warn({ err }, 'shell end failed');
    }
    this.closeRoom(r, reason);
  }

  private closeRoom(r: Room, reason: string): void {
    r.ending = true;
    const msg = JSON.stringify({ t: 'end', reason });
    for (const ws of [r.agent, ...r.operators]) {
      if (!ws) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      ws.close(CLOSE_SHELL_ENDED, 'shell ended');
    }
    r.agent = null;
    r.operators.clear();
    if (this.rooms.get(r.publicId) === r) this.rooms.delete(r.publicId);
  }

  // ── Operator ──

  private async acceptOperator(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, endpointId: string): Promise<void> {
    if (req.headers.origin !== env.WEB_ORIGIN) throw new AppError(403, 'csrf_rejected', 'Cross-origin socket rejected');
    const token = readCookie({ headers: req.headers } as never, SESSION_COOKIE);
    if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
    const who = await resolveSessionToken(token);
    if (ROLE_RANK[who.role] < ROLE_RANK.admin) throw new AppError(403, 'shell_admin_only', 'Only an admin can use a remote shell');
    const publicId = url.searchParams.get('shell') ?? '';
    if (!PUBLIC_ID.test(publicId)) throw new AppError(400, 'bad_request', 'shell is required');
    const s = await withTenant(who.organizationId, async (db) =>
      (
        await db.query<{ id: string; public_id: string; organization_id: string; endpoint_id: string; state: string; operator_id: string | null; max_transcript_bytes: number; idle_timeout_s: number; shell: string | null; pty: string | null }>(
          `SELECT id, public_id, organization_id, endpoint_id, state, operator_id, max_transcript_bytes, idle_timeout_s, shell, pty
             FROM fleet_shell_sessions WHERE public_id = $1 AND endpoint_id = $2`,
          [publicId, endpointId],
        )
      ).rows[0],
    );
    if (!s) throw new AppError(404, 'not_found', 'No such shell');
    if (s.state === 'closed') throw new AppError(410, 'shell_closed', 'This shell has ended');
    // Only the admin who opened it types into it.
    if (s.operator_id !== who.userId) throw new AppError(403, 'not_shell_operator', 'Only the admin who opened this shell can use it');
    // Connection count (EXT-2): a few tabs of the same shell, not hundreds.
    if ((this.rooms.get(s.public_id)?.operators.size ?? 0) >= MAX_OPERATOR_SOCKETS) throw new AppError(429, 'too_many_shell_windows', 'This shell is already open in too many windows');
    const ws = await this.upgrade(req, socket, head, this.operatorWss);
    const r = this.room(s);
    r.operators.add(ws);
    ws.send(JSON.stringify({ t: 'state', state: s.state, shell: s.shell, pty: s.pty, agent: r.agent !== null }));
    if (r.hello) ws.send(r.hello);
    if (r.agent) {
      for (const b of r.scrollback) ws.send(b, { binary: true });
    } else void this.publish(`who|${r.publicId}`);

    const rate = new MessageRate(this.limits.softPerSecond, this.limits.hardPerSecond);
    ws.on('message', (data, isBinary) => {
      const verdict = rate.take();
      if (verdict === 'close') {
        ws.close(CLOSE_POLICY, 'too many messages');
        return;
      }
      if (r.ending || verdict === 'drop') return;
      const buf = toBuffer(data);
      if (isBinary) {
        if (buf.length <= MAX_INPUT_MESSAGE) this.input(r, buf);
        return;
      }
      let m: unknown;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      const p = shellOperatorMessage.safeParse(m);
      if (p.success && p.data.t === 'resize') this.resize(r, p.data.cols, p.data.rows);
    });
    const gone = () => {
      r.operators.delete(ws);
      this.dropIfEmpty(r);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  // ── Between instances ──

  private async publish(payload: string): Promise<void> {
    try {
      await systemPool.query('SELECT pg_notify($1, $2)', [SHELL_CHANNEL, payload]);
    } catch (err) {
      logger.warn({ err }, 'shell notify failed');
    }
  }

  private async publishBytes(dir: 'o' | 'i', publicId: string, buf: Buffer): Promise<void> {
    const b64 = buf.toString('base64');
    for (let i = 0; i < b64.length; i += NOTIFY_PIECE) await this.publish(`${dir}|${publicId}|${b64.slice(i, i + NOTIFY_PIECE)}`);
  }

  private onNotify(payload: string): void {
    const [kind, publicId, a, b] = payload.split('|');
    if (!kind || !publicId) return;
    const r = this.rooms.get(publicId);
    if (!r) return;
    switch (kind) {
      case 'o':
        // Output relayed from the holder: only for operators here (the holder has none).
        if (!r.agent) for (const o of r.operators) if (o.readyState === WebSocket.OPEN) o.send(Buffer.from(a ?? '', 'base64'), { binary: true });
        break;
      case 'i':
        if (r.agent) this.input(r, Buffer.from(a ?? '', 'base64'));
        break;
      case 'r':
        if (r.agent) this.resize(r, Math.max(20, Math.min(400, Number(a) || 120)), Math.max(5, Math.min(200, Number(b) || 30)));
        break;
      case 'hello':
        if (!r.agent) {
          r.hello = Buffer.from(a ?? '', 'base64').toString('utf8');
          for (const o of r.operators) o.send(r.hello);
        }
        break;
      case 'who':
        if (r.agent) {
          if (r.hello) void this.publish(`hello|${publicId}|${Buffer.from(r.hello).toString('base64')}`);
          for (const s of r.scrollback) void this.publishBytes('o', publicId, s);
        }
        break;
      case 'end':
        if (r.agent && !r.ending) {
          // Ended elsewhere (operator, person, sweep): write what is pending, then close.
          void this.flush(r).then(() => this.closeRoom(r, a ?? 'ended'));
        } else this.closeRoom(r, a ?? 'ended');
        break;
    }
  }
}

let hub: ShellHub | null = null;
export function shellHub(): ShellHub {
  hub ??= new ShellHub();
  return hub;
}
