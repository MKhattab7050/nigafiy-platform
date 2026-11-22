import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EndpointPlatform, RemoteDesktopSession, Role } from '@lan-detective/shared-types';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { hmacSha256, safeEqual } from '../../../common/crypto.ts';
import { AppError } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { systemPool, withTenant } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { onNotification } from '../../../infrastructure/pg-listen.ts';
import { readCookie, resolveSessionToken, SESSION_COOKIE } from '../../auth/index.ts';
import { authenticateAgentCredential } from '../agent/auth.ts';
import { validateCommandForPlatform } from '../commands/guards.ts';
import { payloadForAudit } from '../repo.ts';
import { rdInputCommandSchema } from './schema.ts';
import { RD_STREAM_CHANNEL } from './sessions.ts';
import { clearStream, markStreamDown, markStreamUp, streamLocation } from './stream-registry.ts';

/*
 * Live Remote Desktop stream hub (Fleet Pro). Frames are binary WebSocket messages relayed from
 * the endpoint agent to the operators' browsers, in memory only: nothing of a frame is written
 * to PostgreSQL (fleet_sessions keeps counts and bytes).
 *
 *   /api/v1/agent/stream?session=S                  the agent (Authorization: agent credential;
 *                                                    the agent's TLS pin is checked by the agent)
 *   /api/v1/endpoints/:id/remote-desktop/stream?session=S
 *                                                    an operator (session cookie, Origin must be
 *                                                    WEB_ORIGIN, technician or above)
 *   /api/v1/internal/rd-peer?endpoint=E&session=S&instance=I
 *                                                    another API instance (x-ld-peer: HMAC derived
 *                                                    from APP_ENCRYPTION_KEY, 60 s validity)
 *
 * Several API instances: each instance announces the agent sockets it holds on the pg_notify
 * channel ld_rd_stream ("up|E|S|instance|peerUrl", "down|E|S|instance"; "who|E|instance" asks
 * again). An instance whose operator watches an endpoint whose agent is connected elsewhere opens
 * one peer socket to that instance and carries every frame over it; its viewers count as one
 * weighted sink there. Session state ("state|E|…", "end|E") comes from sessions.ts on COMMIT.
 *
 * Control under the "prompt" policy: the agent opens its stream only after the user accepted the
 * dialog; the hub still sends it zero viewers (no frames) until the database says the session is
 * active, so nothing is relayed before the API recorded the consent.
 */

const PEER_PATH = '/api/v1/internal/rd-peer';
const AGENT_PATH = '/api/v1/agent/stream';
const VIEWER_PATH = /^\/api\/v1\/endpoints\/([0-9a-f-]{36})\/remote-desktop\/stream$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Close code: the session is over (the agent stops reconnecting). */
export const CLOSE_SESSION_ENDED = 4000;
/** Close code: another socket of the same agent replaced this one. */
export const CLOSE_SUPERSEDED = 4001;

/** A viewer whose socket buffers more than this misses frames until it catches up. */
const MAX_BUFFERED = 4 << 20;
const RESUME_BUFFERED = 512 << 10;
const MAX_FRAME_BYTES = 8 << 20;
const MAX_TEXT_BYTES = 256 << 10;
const MAX_HEADER_BYTES = 64 << 10;
const FLUSH_MS = 5_000;
const ROLE_RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };

// ── Messages ────────────────────────────────────────────────────────────────────────────────────

const messageSchema = (reqId: z.ZodString) => z.discriminatedUnion('t', [
  z.object({ t: z.literal('ack'), seq: z.number().int().min(0) }),
  z.object({ t: z.literal('full') }),
  z.object({ t: z.literal('displays') }),
  z.object({
    t: z.literal('settings'),
    display: z.number().int().min(0).max(16).optional(),
    quality: z.number().int().min(25).max(95).optional(),
    scale: z.number().min(0.25).max(1).optional(),
    adaptive: z.boolean().optional(),
  }),
  z.object({ t: z.literal('input'), ev: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal('clipboard_get'), req: reqId }),
  z.object({ t: z.literal('clipboard_set'), req: reqId, text: z.string().max(16_000) }),
]);
/** From an operator's browser. */
const viewerMessage = messageSchema(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/));
/** From another instance: clipboard request ids carry the asking viewer's sink id ("sink.req"). */
const peerMessage = messageSchema(z.string().regex(/^[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,32}$/));
type ViewerMessage = z.infer<typeof viewerMessage>;

const AGENT_TEXT_TYPES = new Set(['hello', 'stats', 'displays', 'clipboard', 'clipboard_error', 'clipboard_set_ok', 'input_error', 'error']);

interface FrameMeta {
  seq: number;
  full: boolean;
}

/** Checks a binary frame packet ('N', 1, uint32 header length, JSON header, tiles). */
export function frameMeta(buf: Buffer): FrameMeta | null {
  if (buf.length < 6 || buf.length > MAX_FRAME_BYTES || buf[0] !== 0x4e || buf[1] !== 1) return null;
  const n = buf.readUInt32BE(2);
  if (n === 0 || n > MAX_HEADER_BYTES || 6 + n > buf.length) return null;
  try {
    const h = JSON.parse(buf.subarray(6, 6 + n).toString('utf8')) as { t?: unknown; seq?: unknown; full?: unknown; tiles?: Array<{ n?: unknown }> };
    if (h.t !== 'frame' || typeof h.seq !== 'number' || !Array.isArray(h.tiles)) return null;
    let total = 0;
    for (const t of h.tiles) total += typeof t?.n === 'number' && t.n >= 0 ? t.n : Number.NaN;
    if (total !== buf.length - 6 - n) return null;
    return { seq: h.seq, full: h.full === true };
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function reject(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

function peerKey(): string {
  return hmacSha256(env.APP_ENCRYPTION_KEY, 'nigafiy-rd-peer-v1');
}

export function peerSignature(endpointId: string, sessionId: string, instance: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000);
  return `${ts}.${hmacSha256(peerKey(), `${ts}|${endpointId}|${sessionId}|${instance}`)}`;
}

export function verifyPeerSignature(sig: string | undefined, endpointId: string, sessionId: string, instance: string, now = Date.now()): boolean {
  if (!sig) return false;
  const dot = sig.indexOf('.');
  const ts = Number(sig.slice(0, dot));
  if (dot <= 0 || !Number.isInteger(ts) || Math.abs(now / 1000 - ts) > 60) return false;
  return safeEqual(sig.slice(dot + 1), hmacSha256(peerKey(), `${ts}|${endpointId}|${sessionId}|${instance}`));
}

// ── Sockets ─────────────────────────────────────────────────────────────────────────────────────

interface ViewerUser {
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  ip: string | null;
}

/** A receiver of frames: a local operator's browser, or another instance (weight = its viewers). */
interface Sink {
  id: string;
  ws: WebSocket;
  kind: 'viewer' | 'peer';
  weight: number;
  /** Missed frames (slow socket, or just joined): only a full frame is sent next. */
  stale: boolean;
  fullAsked: boolean;
  user?: ViewerUser;
}

interface Room {
  endpointId: string;
  orgId: string;
  sessionId: string;
  platform: EndpointPlatform | null;
  /** The agent's socket, when it is connected to this instance. */
  agent: WebSocket | null;
  /** Session state as last read or announced: frames flow only when 'active'. */
  active: boolean;
  /** Socket to the instance holding the agent, when it is elsewhere. */
  upstream: WebSocket | null;
  upstreamInstance: string | null;
  viewers: Set<Sink>;
  peers: Set<Sink>;
  hello: string | null;
  sentCount: number;
  frames: number;
  bytes: number;
  lastDisplay: number | null;
}

export interface StreamHubOptions {
  /** Address other instances use to reach this one (RD_PEER_URL). */
  peerUrl: string;
  instanceId?: string;
}

export class StreamHub {
  readonly instanceId: string;
  readonly peerUrl: string;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly rooms = new Map<string, Room>();
  private readonly servers = new Set<Server>();
  private unsubscribe: (() => void) | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: StreamHubOptions) {
    this.instanceId = opts.instanceId ?? randomUUID();
    this.peerUrl = opts.peerUrl.replace(/\/+$/, '');
  }

  start(): void {
    this.unsubscribe ??= onNotification(RD_STREAM_CHANNEL, (p) => this.onNotify(p));
    this.flushTimer ??= setInterval(() => void this.flushAll(), FLUSH_MS);
    this.flushTimer.unref();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    for (const s of this.servers) s.off('upgrade', this.onUpgrade);
    this.servers.clear();
    for (const room of [...this.rooms.values()]) this.closeRoom(room, 1001, 'server shutting down', false);
    await this.flushAll();
  }

  attach(server: Server): void {
    if (this.servers.has(server)) return;
    this.servers.add(server);
    server.on('upgrade', this.onUpgrade);
  }

  /** Counts for tests and the status route. */
  stats(endpointId: string): { agent: boolean; viewers: number; peers: number; upstream: boolean; active: boolean } | null {
    const r = this.rooms.get(endpointId);
    if (!r) return null;
    return { agent: r.agent !== null, viewers: r.viewers.size, peers: r.peers.size, upstream: r.upstream !== null, active: r.active };
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const viewer = VIEWER_PATH.exec(url.pathname);
    if (url.pathname !== AGENT_PATH && url.pathname !== PEER_PATH && !viewer) {
      reject(socket, 404, 'not_found', 'No WebSocket here');
      return;
    }
    socket.on('error', () => undefined);
    const task = url.pathname === AGENT_PATH ? this.acceptAgent(req, socket, head, url) : url.pathname === PEER_PATH ? this.acceptPeer(req, socket, head, url) : this.acceptViewer(req, socket, head, url, viewer![1]!);
    task.catch((err: unknown) => {
      if (err instanceof AppError) reject(socket, err.status, err.code, err.message);
      else {
        logger.error({ err }, 'remote desktop stream upgrade failed');
        reject(socket, 500, 'internal_error', 'Stream upgrade failed');
      }
    });
  };

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<WebSocket> {
    return new Promise((resolve) => this.wss.handleUpgrade(req, socket, head, (ws) => resolve(ws)));
  }

  private async currentSession(orgId: string, endpointId: string): Promise<{ session: RemoteDesktopSession | null; platform: EndpointPlatform } | null> {
    return withTenant(orgId, async (db) => {
      const r = await db.query<{ rd_session: RemoteDesktopSession | null; platform: EndpointPlatform }>(`SELECT rd_session, platform FROM endpoints WHERE id = $1`, [endpointId]);
      return r.rows[0] ? { session: r.rows[0].rd_session, platform: r.rows[0].platform } : null;
    });
  }

  private room(endpointId: string, orgId: string, sessionId: string, platform: EndpointPlatform | null): Room {
    let r = this.rooms.get(endpointId);
    if (r && r.sessionId !== sessionId) {
      this.closeRoom(r, CLOSE_SESSION_ENDED, 'session replaced', true);
      r = undefined;
    }
    if (!r) {
      r = { endpointId, orgId, sessionId, platform, agent: null, active: false, upstream: null, upstreamInstance: null, viewers: new Set(), peers: new Set(), hello: null, sentCount: -1, frames: 0, bytes: 0, lastDisplay: null };
      this.rooms.set(endpointId, r);
    }
    if (platform) r.platform = platform;
    return r;
  }

  private dropRoomIfEmpty(r: Room): void {
    if (!r.agent && r.viewers.size === 0 && r.peers.size === 0) {
      r.upstream?.close(1000);
      r.upstream = null;
      if (this.rooms.get(r.endpointId) === r) this.rooms.delete(r.endpointId);
      void this.flush(r);
    }
  }

  // ── Agent ──

  private async acceptAgent(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const ep = await authenticateAgentCredential(req.headers.authorization);
    if (!ep) throw new AppError(401, 'invalid_agent_credential', 'Agent credential is invalid or revoked');
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID.test(sessionId)) throw new AppError(400, 'bad_request', 'session is required');
    const cur = await this.currentSession(ep.organizationId, ep.id);
    if (!cur?.session) throw new AppError(410, 'no_remote_session', 'No remote desktop session is open');
    if (cur.session.id !== sessionId) throw new AppError(409, 'session_mismatch', 'This is not the open session');
    const ws = await this.upgrade(req, socket, head);
    const r = this.room(ep.id, ep.organizationId, sessionId, cur.platform);
    if (r.agent) r.agent.close(CLOSE_SUPERSEDED, 'replaced by a newer connection');
    r.agent = ws;
    r.active = (cur.session.state ?? 'active') === 'active';
    r.sentCount = -1;
    r.upstream?.close(1000);
    r.upstream = null;
    r.upstreamInstance = null;
    markStreamUp(ep.id, sessionId, this.instanceId, this.peerUrl);
    void this.announce(`up|${ep.id}|${sessionId}|${this.instanceId}|${this.peerUrl}`);
    void withTenant(ep.organizationId, (db) =>
      db.query(`UPDATE fleet_sessions SET transport = 'ws', stream_connected_at = coalesce(stream_connected_at, now()) WHERE endpoint_id = $1 AND public_id = $2`, [ep.id, sessionId]),
    ).catch((err: unknown) => logger.warn({ err }, 'fleet session stream update failed'));
    this.broadcastText(r, { t: 'path', path: 'direct', instance: this.instanceId }, false);
    this.sendViewerCount(r);

    ws.on('message', (data, isBinary) => {
      if (r.agent !== ws) return;
      const buf = toBuffer(data);
      if (isBinary) {
        const meta = frameMeta(buf);
        if (!meta || !r.active) return;
        if (this.fanOutFrame(r, buf, meta, true) > 0) {
          // Counted when it reached at least one operator (or another instance).
          r.frames++;
          r.bytes += buf.length;
        }
        return;
      }
      if (buf.length > MAX_TEXT_BYTES) return;
      let m: { t?: unknown; req?: unknown; desktop?: { mode?: unknown } };
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (typeof m.t !== 'string' || !AGENT_TEXT_TYPES.has(m.t)) return;
      const text = buf.toString('utf8');
      if (m.t === 'hello') {
        r.hello = text;
        const mode = typeof m.desktop?.mode === 'string' ? m.desktop.mode.slice(0, 40) : null;
        if (mode) {
          void withTenant(r.orgId, (db) => db.query(`UPDATE fleet_sessions SET desktop_mode = $3 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId, mode])).catch(() => undefined);
        }
      }
      this.routeAgentText(r, m, text, true);
    });
    const gone = () => {
      if (r.agent !== ws) return;
      r.agent = null;
      r.active = false;
      markStreamDown(r.endpointId, this.instanceId);
      void this.announce(`down|${r.endpointId}|${r.sessionId}|${this.instanceId}`);
      this.broadcastText(r, { t: 'path', path: 'waiting', reason: 'agent_disconnected' }, true);
      this.dropRoomIfEmpty(r);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  /** Agent text from the local agent (`fromAgent`) or from the upstream instance. */
  private routeAgentText(r: Room, m: { t?: unknown; req?: unknown }, text: string, fromAgent: boolean): void {
    if (typeof m.req === 'string' && m.req.includes('.')) {
      // A clipboard answer goes to the viewer that asked (sink id before the dot).
      const [sinkId, orig] = [m.req.slice(0, m.req.indexOf('.')), m.req.slice(m.req.indexOf('.') + 1)];
      const v = [...r.viewers].find((s) => s.id === sinkId);
      if (v) {
        const out: Record<string, unknown> = { ...(JSON.parse(text) as Record<string, unknown>), req: orig };
        this.sendJson(v, out);
        if (m.t === 'clipboard' && typeof out.text === 'string') {
          void this.recordClipboard(r, v, 'from_remote', out.text.length).catch((err: unknown) => logger.warn({ err }, 'clipboard audit failed'));
        }
        return;
      }
      if (fromAgent) for (const p of r.peers) this.sendRaw(p, text);
      return;
    }
    for (const v of r.viewers) this.sendRaw(v, text);
    if (fromAgent) for (const p of r.peers) this.sendRaw(p, text);
  }

  /** Sends a frame to every sink that can take it; returns how many got it. */
  private fanOutFrame(r: Room, buf: Buffer, meta: FrameMeta, includePeers: boolean): number {
    const sinks = includePeers ? [...r.viewers, ...r.peers] : [...r.viewers];
    let askFull = false;
    let delivered = 0;
    for (const s of sinks) {
      if (s.ws.readyState !== WebSocket.OPEN) continue;
      if (s.stale) {
        if (!meta.full) {
          if (!s.fullAsked && s.ws.bufferedAmount < RESUME_BUFFERED) {
            s.fullAsked = true;
            askFull = true;
          }
          continue;
        }
        s.stale = false;
        s.fullAsked = false;
      } else if (s.ws.bufferedAmount > MAX_BUFFERED) {
        s.stale = true;
        continue;
      }
      s.ws.send(buf, { binary: true });
      delivered++;
    }
    if (askFull) this.toAgent(r, { t: 'full' });
    return delivered;
  }

  private viewerCount(r: Room): number {
    let n = r.viewers.size;
    for (const p of r.peers) n += p.weight;
    return n;
  }

  private sendViewerCount(r: Room): void {
    if (r.agent) {
      const n = r.active ? this.viewerCount(r) : 0;
      if (n === r.sentCount) return;
      r.sentCount = n;
      r.agent.send(JSON.stringify({ t: 'viewers', count: n }));
    } else if (r.upstream?.readyState === WebSocket.OPEN) {
      r.upstream.send(JSON.stringify({ t: 'viewers', count: r.viewers.size }));
    }
  }

  /** A message for the agent: straight to its socket here, or over the peer link. */
  private toAgent(r: Room, m: Record<string, unknown>): boolean {
    if (r.agent?.readyState === WebSocket.OPEN) {
      if (!r.active) return false;
      r.agent.send(JSON.stringify(m));
      return true;
    }
    if (r.upstream?.readyState === WebSocket.OPEN) {
      r.upstream.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  // ── Operator ──

  private async acceptViewer(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, endpointId: string): Promise<void> {
    // A browser always sends Origin on a WebSocket; only our own web app may open this one.
    if (req.headers.origin !== env.WEB_ORIGIN) throw new AppError(403, 'csrf_rejected', 'Cross-origin stream rejected');
    const token = readCookie({ headers: req.headers } as never, SESSION_COOKIE);
    if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
    const who = await resolveSessionToken(token);
    if (ROLE_RANK[who.role] < ROLE_RANK.technician) throw new AppError(403, 'forbidden', 'You do not have permission to do this');
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID.test(sessionId)) throw new AppError(400, 'bad_request', 'session is required');
    const cur = await this.currentSession(who.organizationId, endpointId);
    if (!cur) throw new AppError(404, 'not_found', 'Endpoint not found');
    if (!cur.session || cur.session.id !== sessionId) throw new AppError(409, 'no_remote_session', 'This remote desktop session is not open');
    const ws = await this.upgrade(req, socket, head);
    const r = this.room(endpointId, who.organizationId, sessionId, cur.platform);
    if (!r.agent) r.active = (cur.session.state ?? 'active') === 'active';
    const sink: Sink = {
      id: randomUUID().replaceAll('-', ''),
      ws,
      kind: 'viewer',
      weight: 1,
      stale: true,
      fullAsked: false,
      user: { userId: who.userId, email: who.userEmail, orgId: who.organizationId, role: who.role, ip: req.socket.remoteAddress ?? null },
    };
    r.viewers.add(sink);
    this.sendJson(sink, { t: 'session', state: cur.session.state ?? 'active', session_id: sessionId });
    if (r.agent) {
      this.sendJson(sink, { t: 'path', path: 'direct', instance: this.instanceId });
      if (r.hello) this.sendRaw(sink, r.hello);
    } else if (r.upstream) {
      this.sendJson(sink, { t: 'path', path: 'relay', instance: r.upstreamInstance });
      if (r.hello) this.sendRaw(sink, r.hello);
    } else {
      this.sendJson(sink, { t: 'path', path: 'waiting', reason: 'agent_not_connected' });
      const known = streamLocation(endpointId, sessionId);
      if (known && known.instance !== this.instanceId) this.connectUpstream(r, known.instance, known.peerUrl);
      void this.announce(`who|${endpointId}|${this.instanceId}`);
    }
    this.sendViewerCount(r);

    // Messages are handled one at a time (input order matters; audits are written in order).
    let chain = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const buf = toBuffer(data);
      if (buf.length > 80_000) return;
      chain = chain.then(() => this.onViewerMessage(r, sink, buf)).catch((err: unknown) => logger.warn({ err }, 'remote desktop viewer message failed'));
    });
    const gone = () => {
      if (!r.viewers.delete(sink)) return;
      this.sendViewerCount(r);
      this.dropRoomIfEmpty(r);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  private async onViewerMessage(r: Room, sink: Sink, buf: Buffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    const parsed = viewerMessage.safeParse(raw);
    if (!parsed.success) {
      this.sendJson(sink, { t: 'error', where: 'message', error: 'Message not understood' });
      return;
    }
    const m: ViewerMessage = parsed.data;
    const user = sink.user!;
    switch (m.t) {
      case 'ack':
      case 'displays':
        this.toAgent(r, m);
        return;
      case 'full':
        sink.stale = true;
        sink.fullAsked = true;
        this.toAgent(r, m);
        return;
      case 'settings': {
        if (m.display !== undefined && m.display !== r.lastDisplay) {
          r.lastDisplay = m.display;
          await this.auditViewer(r, user, 'fleet.session_display', { display: m.display });
        }
        this.toAgent(r, m);
        return;
      }
      case 'input': {
        const ev = m.ev as Record<string, unknown>;
        const parsedEv = rdInputCommandSchema.safeParse({ ...ev, kind: 'rd_input', event_kind: ev.kind });
        if (!parsedEv.success) {
          this.sendJson(sink, { t: 'input_error', error: 'Input event not understood' });
          return;
        }
        try {
          if (r.platform) validateCommandForPlatform(r.platform, parsedEv.data, user.role);
        } catch (err) {
          this.sendJson(sink, { t: 'input_error', error: err instanceof Error ? err.message : 'Input refused' });
          return;
        }
        const { kind: _k, event_kind, ...rest } = parsedEv.data;
        const out = { ...rest, kind: event_kind };
        if (!this.toAgent(r, { t: 'input', ev: out })) {
          this.sendJson(sink, { t: 'input_error', error: r.active ? 'The endpoint is not connected to the live stream' : 'The user has not accepted the session yet' });
          return;
        }
        // Every action except pointer movement is in the audit trail (keys and text redacted).
        if (event_kind !== 'mouse_move') await this.auditViewer(r, user, 'endpoint.rd_input', { via: 'live_stream', ...payloadForAudit('rd_input', out) });
        return;
      }
      case 'clipboard_get':
        if (!this.toAgent(r, { t: 'clipboard_get', req: `${sink.id}.${m.req}` })) this.sendJson(sink, { t: 'clipboard_error', req: m.req, error: 'The endpoint is not connected to the live stream' });
        return;
      case 'clipboard_set':
        if (!this.toAgent(r, { t: 'clipboard_set', req: `${sink.id}.${m.req}`, text: m.text })) {
          this.sendJson(sink, { t: 'clipboard_error', req: m.req, error: 'The endpoint is not connected to the live stream' });
          return;
        }
        await this.recordClipboard(r, sink, 'to_remote', m.text.length);
        return;
    }
  }

  private async recordClipboard(r: Room, sink: Sink, direction: 'to_remote' | 'from_remote', chars: number): Promise<void> {
    const user = sink.user;
    if (!user) return;
    const col = direction === 'to_remote' ? 'clipboard_to_remote' : 'clipboard_from_remote';
    await withTenant(user.orgId, async (db) => {
      await db.query(`UPDATE fleet_sessions SET ${col} = ${col} + 1 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId]);
      await this.auditIn(db, r, user, 'fleet.session_clipboard', { direction, chars });
    });
  }

  private async auditViewer(r: Room, user: ViewerUser, action: string, metadata: Record<string, unknown>): Promise<void> {
    await withTenant(user.orgId, (db) => this.auditIn(db, r, user, action, metadata));
  }

  private async auditIn(db: { query: (q: string, v: unknown[]) => Promise<unknown> }, r: Room, user: ViewerUser, action: string, metadata: Record<string, unknown>): Promise<void> {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,$4,'endpoint',$5,$6,$7)`,
      [user.orgId, user.userId, user.email, action, r.endpointId, JSON.stringify({ ...metadata, session_id: r.sessionId }), user.ip],
    );
  }

  // ── Other instances ──

  private async acceptPeer(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const endpointId = url.searchParams.get('endpoint') ?? '';
    const sessionId = url.searchParams.get('session') ?? '';
    const instance = url.searchParams.get('instance') ?? '';
    const sig = req.headers['x-ld-peer'];
    if (!UUID.test(endpointId) || !SESSION_ID.test(sessionId) || !UUID.test(instance)) throw new AppError(400, 'bad_request', 'endpoint, session and instance are required');
    if (!verifyPeerSignature(typeof sig === 'string' ? sig : undefined, endpointId, sessionId, instance)) throw new AppError(401, 'unauthenticated', 'Peer signature rejected');
    const r = this.rooms.get(endpointId);
    if (!r?.agent || r.sessionId !== sessionId) throw new AppError(409, 'not_here', 'The agent is not connected to this instance');
    const ws = await this.upgrade(req, socket, head);
    const sink: Sink = { id: instance.replaceAll('-', ''), ws, kind: 'peer', weight: 0, stale: true, fullAsked: false };
    r.peers.add(sink);
    if (r.hello) this.sendRaw(sink, r.hello);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const buf = toBuffer(data);
      if (buf.length > 80_000) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (m.t === 'viewers') {
        sink.weight = Math.max(0, Math.min(1000, Number(m.count) || 0));
        if (sink.weight > 0) sink.stale = true;
        this.sendViewerCount(r);
        return;
      }
      // Already checked and audited on the operator's instance; checked again here.
      const parsed = peerMessage.safeParse(m);
      if (!parsed.success) return;
      if (parsed.data.t === 'full') {
        sink.stale = true;
        sink.fullAsked = true;
      }
      this.toAgent(r, parsed.data);
    });
    const gone = () => {
      if (!r.peers.delete(sink)) return;
      this.sendViewerCount(r);
      this.dropRoomIfEmpty(r);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  private connectUpstream(r: Room, instance: string, peerUrl: string): void {
    if (r.agent || (r.upstream && r.upstreamInstance === instance) || r.viewers.size === 0) return;
    r.upstream?.close(1000);
    const target = new URL(`${peerUrl.replace(/^http/, 'ws')}${PEER_PATH}`);
    target.searchParams.set('endpoint', r.endpointId);
    target.searchParams.set('session', r.sessionId);
    target.searchParams.set('instance', this.instanceId);
    const ws = new WebSocket(target, { headers: { 'x-ld-peer': peerSignature(r.endpointId, r.sessionId, this.instanceId) }, maxPayload: MAX_FRAME_BYTES });
    r.upstream = ws;
    r.upstreamInstance = instance;
    ws.on('open', () => {
      if (r.upstream !== ws) return;
      for (const v of r.viewers) v.stale = true;
      this.broadcastText(r, { t: 'path', path: 'relay', instance }, false);
      this.sendViewerCount(r);
    });
    ws.on('message', (data, isBinary) => {
      if (r.upstream !== ws) return;
      const buf = toBuffer(data);
      if (isBinary) {
        const meta = frameMeta(buf);
        if (meta) this.fanOutFrame(r, buf, meta, false);
        return;
      }
      if (buf.length > MAX_TEXT_BYTES) return;
      let m: { t?: unknown; req?: unknown };
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (typeof m.t !== 'string' || !AGENT_TEXT_TYPES.has(m.t)) return;
      const text = buf.toString('utf8');
      if (m.t === 'hello') r.hello = text;
      this.routeAgentText(r, m, text, false);
    });
    const gone = () => {
      if (r.upstream !== ws) return;
      r.upstream = null;
      r.upstreamInstance = null;
      if (this.rooms.get(r.endpointId) === r) this.broadcastText(r, { t: 'path', path: 'waiting', reason: 'relay_lost' }, false);
    };
    ws.on('close', gone);
    ws.on('error', (err) => {
      logger.warn({ err: (err as Error).message, instance }, 'remote desktop peer link failed');
      gone();
    });
  }

  // ── Notifications ──

  private async announce(payload: string): Promise<void> {
    try {
      await systemPool.query('SELECT pg_notify($1, $2)', [RD_STREAM_CHANNEL, payload]);
    } catch (err) {
      logger.warn({ err }, 'remote desktop stream announcement failed');
    }
  }

  private onNotify(payload: string): void {
    const parts = payload.split('|');
    const [kind, endpointId] = parts;
    if (!endpointId || !UUID.test(endpointId)) return;
    const r = this.rooms.get(endpointId);
    switch (kind) {
      case 'end':
        clearStream(endpointId);
        if (r) this.closeRoom(r, CLOSE_SESSION_ENDED, 'session ended', true);
        return;
      case 'state': {
        const state = parts[2];
        if (!r || (state !== 'active' && state !== 'waiting_consent')) return;
        r.active = state === 'active';
        this.broadcastText(r, { t: 'session', state, session_id: r.sessionId }, false);
        this.sendViewerCount(r);
        return;
      }
      case 'up': {
        const [, , sessionId, instance, peerUrl] = parts;
        if (!sessionId || !instance || !peerUrl) return;
        markStreamUp(endpointId, sessionId, instance, peerUrl);
        if (instance === this.instanceId || !r || r.sessionId !== sessionId) return;
        if (r.agent) {
          // The agent reconnected to another instance: this socket is a stale one.
          r.agent.close(CLOSE_SUPERSEDED, 'replaced by a newer connection');
          return;
        }
        this.connectUpstream(r, instance, peerUrl);
        return;
      }
      case 'down': {
        const [, , sessionId, instance] = parts;
        if (!instance || instance === this.instanceId) return;
        markStreamDown(endpointId, instance);
        if (r && r.upstreamInstance === instance && r.sessionId === sessionId) r.upstream?.close(1000);
        return;
      }
      case 'who': {
        if (r?.agent && parts[2] !== this.instanceId) void this.announce(`up|${endpointId}|${r.sessionId}|${this.instanceId}|${this.peerUrl}`);
        return;
      }
    }
  }

  private closeRoom(r: Room, code: number, reason: string, notifyViewers: boolean): void {
    if (this.rooms.get(r.endpointId) === r) this.rooms.delete(r.endpointId);
    if (notifyViewers) this.broadcastText(r, { t: 'end', reason }, true);
    for (const s of [...r.viewers, ...r.peers]) s.ws.close(code, reason);
    r.viewers.clear();
    r.peers.clear();
    if (r.agent) {
      markStreamDown(r.endpointId, this.instanceId);
      r.agent.close(code, reason);
    }
    r.agent = null;
    r.upstream?.close(1000);
    r.upstream = null;
    void this.flush(r);
  }

  // ── Output helpers ──

  private broadcastText(r: Room, m: Record<string, unknown>, includePeers: boolean): void {
    const text = JSON.stringify(m);
    for (const v of r.viewers) this.sendRaw(v, text);
    if (includePeers) for (const p of r.peers) this.sendRaw(p, text);
  }

  private sendJson(s: Sink, m: Record<string, unknown>): void {
    this.sendRaw(s, JSON.stringify(m));
  }

  private sendRaw(s: Sink, text: string): void {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(text);
  }

  private async flush(r: Room): Promise<void> {
    if (r.frames === 0 && r.bytes === 0) return;
    const [frames, bytes] = [r.frames, r.bytes];
    r.frames = 0;
    r.bytes = 0;
    try {
      await withTenant(r.orgId, (db) =>
        db.query(`UPDATE fleet_sessions SET frames_relayed = frames_relayed + $3, bytes_relayed = bytes_relayed + $4 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId, frames, bytes]),
      );
    } catch (err) {
      logger.warn({ err }, 'fleet session counters update failed');
    }
  }

  private async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((r) => this.flush(r)));
  }
}

let defaultHub: StreamHub | null = null;

/** The process's hub (main.ts attaches it to the HTTP and HTTPS servers). */
export function streamHub(): StreamHub {
  defaultHub ??= new StreamHub({ peerUrl: env.RD_PEER_URL ?? `http://127.0.0.1:${env.PORT}` });
  return defaultHub;
}
