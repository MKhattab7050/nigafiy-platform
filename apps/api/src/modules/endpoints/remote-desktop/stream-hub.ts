import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EndpointAndroidState, EndpointPlatform, FleetPermissions, RemoteDesktopSession, Role } from '@nigafiy/shared-types';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { hmacSha256, safeEqual } from '../../../common/crypto.ts';
import { CLOSE_POLICY, DEFAULT_WS_LIMITS, MessageRate, SocketCounter, heartbeat, type WsLimits } from '../../../common/ws-guard.ts';
import { AppError } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { type Db, systemPool, withTenant } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { onNotification } from '../../../infrastructure/pg-listen.ts';
import { readCookie, resolveSessionToken, SESSION_COOKIE } from '../../auth/index.ts';
import { authenticateAgentCredential } from '../agent/auth.ts';
import { validateCommandForPlatform } from '../commands/guards.ts';
import { payloadForAudit } from '../repo.ts';
import { PROFILE_REFUSAL_MESSAGES, type ProfileRefusalCode, refusalFlag } from '../fleet-policy/enforce.ts';
import { sessionPermissions } from '../fleet-policy/profiles.ts';
import { RecordingWriter } from './recording.ts';
import { rdInputCommandSchema } from './schema.ts';
import { participantAccess } from './session-tools.ts';
import { RD_STREAM_CHANNEL, auditEndpointEvent } from './sessions.ts';
import { clearStream, markStreamDown, markStreamUp, streamLocation } from './stream-registry.ts';
import { type ShellHub, shellHub } from '../fleet-shell/hub.ts';

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
 * weighted sink there. Session state ("state|E|…", "end|E|S", always naming the session) comes from sessions.ts on COMMIT.
 *
 * WebRTC video (docs/features/fleet-pro.md "WebRTC video"): the browser and the agent may also form a
 * direct peer connection on the LAN for H.264 video and a data channel for input. The hub only
 * signals (rtc_offer / rtc_answer / rtc_ice, tagged "<sink>.rtc" so an answer reaches only the
 * browser that asked), checks every offer (session active, the viewer's view permission, the
 * agent's capability, RD_WEBRTC, no recording) and audits start, fallback, stop and every input
 * the agent reports (rtc_input). A viewer whose video plays over WebRTC no longer counts as a JPEG
 * viewer; one that falls back counts again and gets a full frame. Recorded sessions stay on JPEG.
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
// A clipboard picture (4 MiB PNG as base64) is the largest text message.
const MAX_TEXT_BYTES = 6 << 20;
const MAX_HEADER_BYTES = 64 << 10;
const FLUSH_MS = 5_000;
const ROLE_RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };

// ── Messages ────────────────────────────────────────────────────────────────────────────────────

const clipFormat = z.enum(['text', 'image', 'files']);
const unit = z.number().min(0).max(1);
const annotateOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('stroke'),
    display: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }),
    points: z.array(z.tuple([unit, unit])).min(2).max(2000),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    width: z.number().int().min(1).max(24).optional(),
  }),
  z.object({
    op: z.literal('pointer'),
    display: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }),
    x: unit,
    y: unit,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
  z.object({ op: z.literal('pointer_hide') }),
  z.object({ op: z.literal('clear') }),
]);

/** WebRTC signalling (validated here; the SDP and candidates are relayed, never stored or audited). */
const rtcSdp = z
  .string()
  .min(10)
  .max(64 * 1024)
  .refine((s) => s.startsWith('v=0'), 'not an SDP');
/** An ICE candidate as RTCIceCandidate.toJSON() gives it; "" is the end of candidates. No relay. */
const rtcCandidate = z
  .object({
    candidate: z
      .string()
      .max(1024)
      .regex(/^(|candidate:[A-Za-z0-9+/]{1,32} \d{1,5} (udp|tcp|UDP|TCP) \d{1,10} [0-9A-Za-z.:-]{1,255} \d{1,5} typ (host|srflx|prflx)( [\x21-\x7e]{1,255})*)$/),
    sdpMid: z.string().max(32).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(16).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .nullable();
/** Why a browser went back to JPEG (rtc_fallback). */
export const RTC_FALLBACK_REASONS = [
  'no_rtc',
  'no_h264',
  'refused',
  'answer_timeout',
  'no_video',
  'ice_failed',
  'ice_disconnected',
  'encoder_failed',
  'recording',
  'agent_failed',
  'error',
] as const;

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
    // Show the remote pointer in the picture; colour depth (8 = greyscale).
    cursor: z.boolean().optional(),
    depth: z.union([z.literal(8), z.literal(16), z.literal(24)]).optional(),
  }),
  z.object({ t: z.literal('input'), ev: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal('clipboard_get'), req: reqId, format: clipFormat.optional() }),
  z.object({
    t: z.literal('clipboard_set'),
    req: reqId,
    format: clipFormat.optional(),
    text: z.string().max(16_000).optional(),
    // A PNG picture (base64, at most 4 MiB decoded) or file paths on the remote computer (files
    // the operator uploaded there first, through the chunked SHA-256 file transfer).
    data: z.string().max(5_600_000).optional(),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(50).optional(),
  }),
  // In-session tools (migration 036). `from` is set by the hub from the signed-in operator.
  z.object({ t: z.literal('privacy'), on: z.boolean() }),
  z.object({ t: z.literal('block_input'), on: z.boolean() }),
  z.object({ t: z.literal('sas') }),
  z.object({ t: z.literal('chat'), id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), text: z.string().trim().min(1).max(2000), from: z.string().max(320).optional() }),
  z.object({
    t: z.literal('ask'),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    text: z.string().trim().min(1).max(500),
    kind: z.enum(['ok', 'yes_no', 'text']),
    timeout_s: z.number().int().min(10).max(600).default(300),
    from: z.string().max(320).optional(),
  }),
  z.object({ t: z.literal('annotate'), op: annotateOp }),
  z.object({ t: z.literal('audio'), on: z.boolean(), mono: z.boolean().optional() }),
  // WebRTC. From a browser, `req`, `control` and `ice_servers` are ignored (the hub sets them); from
  // another instance they carry what the operator's instance decided.
  z.object({
    t: z.literal('rtc_offer'),
    sdp: rtcSdp,
    req: reqId.optional(),
    control: z.boolean().optional(),
    ice_servers: z.array(z.string().max(200)).max(4).optional(),
  }),
  z.object({ t: z.literal('rtc_ice'), candidate: rtcCandidate, req: reqId.optional() }),
  z.object({ t: z.literal('rtc_active'), encoder: z.string().max(160).optional(), req: reqId.optional() }),
  z.object({ t: z.literal('rtc_fallback'), reason: z.enum(RTC_FALLBACK_REASONS), req: reqId.optional() }),
  z.object({ t: z.literal('rtc_close'), req: reqId.optional() }),
  z.object({ t: z.literal('rtc_perms'), control: z.boolean(), req: reqId.optional() }),
]);
/** From an operator's browser. */
const viewerMessage = messageSchema(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/));
/** From another instance: clipboard request ids carry the asking viewer's sink id ("sink.req"). */
const peerMessage = messageSchema(z.string().regex(/^[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,32}$/));
type ViewerMessage = z.infer<typeof viewerMessage>;

const AGENT_TEXT_TYPES = new Set([
  'hello',
  'stats',
  'displays',
  'clipboard',
  'clipboard_error',
  'clipboard_set_ok',
  'input_error',
  'error',
  // In-session tools: what is switched on (shown to every operator), refusals, Ctrl+Alt+Del,
  // the person's chat replies and answers.
  'tool_state',
  'tool_error',
  'sas_result',
  'chat',
  'chat_shown',
  'answer',
  // WebRTC: the answer, the agent's candidates, the peer's state (connected, failed with a code,
  // encoder changed), the input it applied (audited here, never forwarded) and video stats.
  'rtc_answer',
  'rtc_ice',
  'rtc_state',
  'rtc_input',
  'rtc_stats',
]);

/** Why an offer was refused (sent as rtc_refused and audited as fleet.session_transport). */
export type RtcRefusal =
  | 'webrtc_disabled'
  | 'webrtc_unsupported'
  | 'webrtc_recording_active'
  | 'webrtc_session_not_active'
  | 'webrtc_agent_not_connected'
  | 'profile_forbids_view';
const RTC_REFUSAL_MESSAGES: Record<RtcRefusal, string> = {
  webrtc_disabled: 'WebRTC video is switched off on this server',
  webrtc_unsupported: 'This computer cannot send WebRTC video (no H.264 encoder, or not Windows)',
  webrtc_recording_active: 'This session is being recorded: the picture stays on the server path',
  webrtc_session_not_active: 'The session is not active yet',
  webrtc_agent_not_connected: 'The endpoint is not connected to the live stream',
  profile_forbids_view: PROFILE_REFUSAL_MESSAGES.profile_forbids_view,
};
const RTC_INPUT_KINDS = new Set(['mouse_click', 'mouse_down', 'mouse_up', 'mouse_wheel', 'key_press', 'key_down', 'key_up', 'key_combo', 'text']);

/** Close code for an operator removed from the session (or whose invitation ended). */
export const CLOSE_PARTICIPANT_REMOVED = 4003;

/** Audio packet from the agent: 'N', 2, uint32 header length, JSON header, IMA ADPCM bytes. */
export function isAudioPacket(buf: Buffer): boolean {
  if (buf.length < 6 || buf.length > 1 << 20 || buf[0] !== 0x4e || buf[1] !== 2) return false;
  const n = buf.readUInt32BE(2);
  return n > 0 && n <= 4096 && 6 + n <= buf.length;
}

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
  /** This operator's permissions: the session's, narrowed for an invited colleague. */
  perms?: FleetPermissions;
  /** The operator listens to the computer's sound. */
  audio?: boolean;
  /** WebRTC video: offer relayed, or video playing (then this viewer gets no JPEG frames). */
  rtc?: 'offered' | 'active' | null;
  /** The last fallback reason audited for this viewer (a repeat is not audited again). */
  rtcLast?: string | null;
}

interface Room {
  endpointId: string;
  orgId: string;
  sessionId: string;
  platform: EndpointPlatform | null;
  /** A phone's reported controls (agents/android-agent): what its live input is checked against. */
  android: EndpointAndroidState | null;
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
  /** The session's granted permission profile (rd_session.permissions), enforced on every operator message. */
  permissions: FleetPermissions;
  /** The session recording written here (this instance holds the agent's socket). */
  recorder: RecordingWriter | null;
  recordingId: string | null;
  audioOn: boolean;
  /** The agent's hello said it can send WebRTC video. */
  rtcSupported: boolean;
  /** The session is being recorded (rd_session.recording_id): WebRTC is refused. */
  recordingOn: boolean;
  /** Audit rows of this room's operators are written one after another, in the order they happened. */
  auditChain: Promise<void>;
}

export interface StreamHubOptions {
  /** Address other instances use to reach this one (RD_PEER_URL). */
  peerUrl: string;
  instanceId?: string;
  /** Remote shell sockets on the same listener (default: this process's shell hub). */
  shell?: ShellHub;
  /** Message rate, connection count and heartbeat limits (tests make them small). */
  limits?: Partial<WsLimits>;
}

export class StreamHub {
  readonly instanceId: string;
  readonly peerUrl: string;
  /** Agents and other instances: binary frames. */
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Operators' browsers send text only; the largest is a clipboard picture. */
  private readonly viewerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_TEXT_BYTES });
  readonly limits: WsLimits;
  /** Upgrades still being authenticated, per remote address (both hubs on this listener). */
  private readonly pending = new SocketCounter();
  /** Open viewer sockets per signed-in user. */
  private readonly perUser = new SocketCounter();
  private readonly rooms = new Map<string, Room>();
  private readonly servers = new Set<Server>();
  private unsubscribe: (() => void) | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly shell: ShellHub;

  constructor(opts: StreamHubOptions) {
    this.shell = opts.shell ?? shellHub();
    this.limits = { ...DEFAULT_WS_LIMITS, ...opts.limits };
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
  stats(endpointId: string): { agent: boolean; viewers: number; peers: number; upstream: boolean; active: boolean; rtc: number } | null {
    const r = this.rooms.get(endpointId);
    if (!r) return null;
    const rtc = [...r.viewers].filter((v) => v.rtc === 'active').length;
    return { agent: r.agent !== null, viewers: r.viewers.size, peers: r.peers.size, upstream: r.upstream !== null, active: r.active, rtc };
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isShell = this.shell.handles(url.pathname);
    const viewer = VIEWER_PATH.exec(url.pathname);
    if (!isShell && url.pathname !== AGENT_PATH && url.pathname !== PEER_PATH && !viewer) {
      reject(socket, 404, 'not_found', 'No WebSocket here');
      return;
    }
    socket.on('error', () => undefined);
    // Each upgrade costs a credential or session lookup before it is accepted: one address may
    // have only a few in flight (EXT-2). Released when the upgrade is settled or the socket goes.
    const release = this.pending.acquire(req.socket.remoteAddress ?? 'unknown', this.limits.maxPendingPerAddress);
    if (!release) {
      reject(socket, 429, 'rate_limited', 'Too many connections are being opened from this address');
      return;
    }
    socket.once('close', release);
    // Remote shell sockets (Fleet Pro, fleet-shell/hub.ts) share the listener.
    if (isShell) {
      void this.shell.handleUpgrade(req, socket, head, url, reject).finally(release);
      return;
    }
    const task = url.pathname === AGENT_PATH ? this.acceptAgent(req, socket, head, url) : url.pathname === PEER_PATH ? this.acceptPeer(req, socket, head, url) : this.acceptViewer(req, socket, head, url, viewer![1]!);
    task
      .catch((err: unknown) => {
        if (err instanceof AppError) reject(socket, err.status, err.code, err.message);
        else {
          logger.error({ err }, 'remote desktop stream upgrade failed');
          reject(socket, 500, 'internal_error', 'Stream upgrade failed');
        }
      })
      .finally(release);
  };

  /** Accepts the socket and starts its heartbeat (a socket that stops answering pings is ended). */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, server: WebSocketServer = this.wss): Promise<WebSocket> {
    return new Promise((resolve) =>
      server.handleUpgrade(req, socket, head, (ws) => {
        heartbeat(ws, this.limits.pingMs);
        resolve(ws);
      }),
    );
  }

  private async currentSession(
    orgId: string,
    endpointId: string,
  ): Promise<{ session: RemoteDesktopSession | null; platform: EndpointPlatform; android: EndpointAndroidState | null } | null> {
    return withTenant(orgId, async (db) => {
      const r = await db.query<{ rd_session: RemoteDesktopSession | null; platform: EndpointPlatform; android: EndpointAndroidState | null }>(
        `SELECT rd_session, platform, android FROM endpoints WHERE id = $1`,
        [endpointId],
      );
      return r.rows[0] ? { session: r.rows[0].rd_session, platform: r.rows[0].platform, android: r.rows[0].android } : null;
    });
  }

  private room(endpointId: string, orgId: string, sessionId: string, platform: EndpointPlatform | null, session: RemoteDesktopSession | null = null): Room {
    let r = this.rooms.get(endpointId);
    if (r && r.sessionId !== sessionId) {
      this.closeRoom(r, CLOSE_SESSION_ENDED, 'session replaced', true);
      r = undefined;
    }
    if (!r) {
      r = {
        endpointId,
        orgId,
        sessionId,
        platform,
        android: null,
        agent: null,
        active: false,
        upstream: null,
        upstreamInstance: null,
        viewers: new Set(),
        peers: new Set(),
        hello: null,
        sentCount: -1,
        frames: 0,
        bytes: 0,
        lastDisplay: null,
        permissions: sessionPermissions(session),
        recorder: null,
        recordingId: null,
        audioOn: false,
        rtcSupported: false,
        recordingOn: Boolean(session?.recording_id),
        auditChain: Promise.resolve(),
      };
      this.rooms.set(endpointId, r);
    }
    if (platform) r.platform = platform;
    if (session) {
      r.permissions = sessionPermissions(session);
      r.recordingOn = Boolean(session.recording_id);
    }
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
    const r = this.room(ep.id, ep.organizationId, sessionId, cur.platform, cur.session);
    r.android = cur.android;
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
      db.query(`UPDATE fleet_sessions SET transport = CASE WHEN transport = 'webrtc' THEN 'webrtc' ELSE 'ws' END, stream_connected_at = coalesce(stream_connected_at, now()) WHERE endpoint_id = $1 AND public_id = $2`, [ep.id, sessionId]),
    ).catch((err: unknown) => logger.warn({ err }, 'fleet session stream update failed'));
    this.broadcastText(r, { t: 'path', path: 'direct', instance: this.instanceId }, false);
    this.sendViewerCount(r);
    void this.syncRecording(r, cur.session.recording_id ?? null);

    ws.on('message', (data, isBinary) => {
      if (r.agent !== ws) return;
      const buf = toBuffer(data);
      if (isBinary) {
        if (isAudioPacket(buf)) {
          if (r.active) this.fanOutAudio(r, buf, true);
          return;
        }
        const meta = frameMeta(buf);
        if (!meta || !r.active) return;
        if (this.fanOutFrame(r, buf, meta, true) > 0) {
          // Counted when it reached at least one operator (or another instance).
          r.frames++;
          r.bytes += buf.length;
          // The recording keeps exactly what the operators saw.
          r.recorder?.frame(buf);
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
        this.setHello(r, text, m as { webrtc?: unknown });
        const mode = typeof m.desktop?.mode === 'string' ? m.desktop.mode.slice(0, 40) : null;
        if (mode) {
          void withTenant(r.orgId, (db) => db.query(`UPDATE fleet_sessions SET desktop_mode = $3 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId, mode])).catch(() => undefined);
        }
      }
      this.onAgentTool(r, m as Record<string, unknown>);
      this.routeAgentText(r, m, text, true);
    });
    const gone = () => {
      if (r.agent !== ws) return;
      r.agent = null;
      r.active = false;
      r.audioOn = false;
      // The recording continues in a new segment when the agent reconnects (here or elsewhere).
      const rec = r.recorder;
      r.recorder = null;
      r.recordingId = null;
      if (rec) void rec.close();
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
      if (v && m.t === 'rtc_input') {
        void this.auditRtcInput(r, v, m as Record<string, unknown>).catch((err: unknown) => logger.warn({ err }, 'webrtc input audit failed'));
        return;
      }
      if (v) {
        const out: Record<string, unknown> = { ...(JSON.parse(text) as Record<string, unknown>), req: orig };
        this.sendJson(v, out);
        if (m.t === 'clipboard' && typeof out.text === 'string') {
          void this.recordClipboard(r, v, 'from_remote', out.text.length).catch((err: unknown) => logger.warn({ err }, 'clipboard audit failed'));
        } else if (m.t === 'clipboard' && (out.format === 'image' || out.format === 'files') && v.user) {
          const detail = out.format === 'image' ? { bytes: typeof out.bytes === 'number' ? out.bytes : 0 } : { files: Array.isArray(out.paths) ? out.paths.length : 0 };
          const u = v.user;
          void withTenant(u.orgId, async (db) => {
            await db.query(`UPDATE fleet_sessions SET clipboard_from_remote = clipboard_from_remote + 1 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId]);
            await this.auditIn(db, r, u, 'fleet.session_clipboard', { direction: 'from_remote', format: out.format, ...detail });
          }).catch((err: unknown) => logger.warn({ err }, 'clipboard audit failed'));
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
      // Its picture plays over WebRTC (other viewers may still take JPEG frames).
      if (s.rtc === 'active') continue;
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

  /** Audio goes only to operators who switched it on and whose permissions include audio. */
  private fanOutAudio(r: Room, buf: Buffer, includePeers: boolean): void {
    for (const v of r.viewers) {
      if (v.audio && v.perms?.audio && v.ws.readyState === WebSocket.OPEN && v.ws.bufferedAmount < MAX_BUFFERED) v.ws.send(buf, { binary: true });
    }
    if (includePeers) for (const p of r.peers) if (p.audio && p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount < MAX_BUFFERED) p.ws.send(buf, { binary: true });
  }

  /** What the agent reports about the tools: counted (chat) and marked in the recording; never the text. */
  private onAgentTool(r: Room, m: Record<string, unknown>): void {
    if (m.t === 'chat' && m.from === 'user') {
      r.recorder?.event({ e: 'chat', from: 'user', chars: typeof m.text === 'string' ? m.text.length : 0 });
      void withTenant(r.orgId, (db) => db.query(`UPDATE fleet_sessions SET chat_messages = chat_messages + 1 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId])).catch(
        () => undefined,
      );
    } else if (m.t === 'answer') {
      r.recorder?.event({ e: 'answer', id: m.id, answer: m.answer });
      void withTenant(r.orgId, (db) =>
        auditEndpointEvent(db, r.orgId, r.endpointId, 'fleet.session_answer', {
          session_id: r.sessionId,
          question_id: m.id,
          answer: m.answer,
          chars: typeof m.text === 'string' ? m.text.length : 0,
        }),
      ).catch(() => undefined);
    } else if (m.t === 'tool_state') {
      r.recorder?.event({ e: 'tool_state', privacy: m.privacy, input_blocked: m.input_blocked, audio: m.audio, recording: m.recording });
    }
  }

  /** Opens or closes this instance's recording writer to match the session (rd_session.recording_id). */
  private async syncRecording(r: Room, recordingId: string | null): Promise<void> {
    if (!r.agent) return;
    if (r.recordingId === recordingId && (recordingId === null || r.recorder?.active)) return;
    const old = r.recorder;
    r.recorder = null;
    r.recordingId = recordingId;
    if (old) await old.close();
    if (!recordingId) return;
    try {
      const w = await RecordingWriter.open(r.orgId, recordingId);
      if (!w || r.recordingId !== recordingId || !r.agent) {
        await w?.close();
        return;
      }
      w.onNeedFull = () => this.toAgent(r, { t: 'full' });
      r.recorder = w;
      w.event({ e: 'started', session_id: r.sessionId });
      this.toAgent(r, { t: 'full' });
    } catch (err) {
      logger.error({ err }, 'session recording could not be opened');
      await withTenant(r.orgId, (db) => db.query(`UPDATE fleet_recordings SET state = 'failed', error = $2 WHERE id = $1`, [recordingId, (err as Error).message.slice(0, 300)])).catch(
        () => undefined,
      );
    }
  }

  /** Viewers that take JPEG frames here (a viewer whose video plays over WebRTC does not). */
  private jpegViewers(r: Room): number {
    let n = 0;
    for (const v of r.viewers) if (v.rtc !== 'active') n++;
    return n;
  }

  private viewerCount(r: Room): number {
    let n = this.jpegViewers(r);
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
      r.upstream.send(JSON.stringify({ t: 'viewers', count: this.jpegViewers(r) }));
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
    // Only the operator holding the session and colleagues who joined it (each with their own,
    // possibly narrower, permissions) may watch.
    const perms = await withTenant(who.organizationId, (db) => participantAccess(db, cur.session as never, who.userId));
    if (!perms) throw new AppError(403, 'not_a_participant', 'You are not in this session: ask the operator holding it to invite you');
    // Connection count (EXT-2): viewers of one session, and sockets of one user.
    const existing = this.rooms.get(endpointId);
    if (existing && existing.sessionId === sessionId && existing.viewers.size >= this.limits.maxPerSession) {
      throw new AppError(429, 'too_many_viewers', 'This session already has as many viewers as it can take');
    }
    const releaseUser = this.perUser.acquire(who.userId, this.limits.maxPerUser);
    if (!releaseUser) throw new AppError(429, 'too_many_streams', 'You have too many remote desktop windows open: close one first');
    socket.once('close', releaseUser);
    const ws = await this.upgrade(req, socket, head, this.viewerWss);
    const r = this.room(endpointId, who.organizationId, sessionId, cur.platform, cur.session);
    r.android = cur.android;
    if (!r.agent) r.active = (cur.session.state ?? 'active') === 'active';
    const sink: Sink = {
      id: randomUUID().replaceAll('-', ''),
      ws,
      kind: 'viewer',
      weight: 1,
      stale: true,
      fullAsked: false,
      user: { userId: who.userId, email: who.userEmail, orgId: who.organizationId, role: who.role, ip: req.socket.remoteAddress ?? null },
      perms,
      audio: false,
    };
    r.viewers.add(sink);
    this.sendJson(sink, {
      t: 'session',
      state: cur.session.state ?? 'active',
      session_id: sessionId,
      permissions: perms,
      session_permissions: r.permissions,
      operators: cur.session.operators ?? [cur.session.operator_email],
      recording: Boolean(cur.session.recording_id),
      holder: (cur.session as { operator_user_id?: string }).operator_user_id === who.userId,
      // WebRTC video: allowed by this server, and the STUN servers the browser may use (none by default).
      webrtc: env.RD_WEBRTC === 'on',
      ice_servers: env.RD_WEBRTC_STUN_URLS,
    });
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
    // A browser that floods the socket loses the extra messages, then the socket (EXT-2).
    let chain = Promise.resolve();
    let queued = 0;
    const rate = new MessageRate(this.limits.softPerSecond, this.limits.hardPerSecond);
    ws.on('message', (data, isBinary) => {
      const verdict = rate.take();
      if (verdict === 'close' || queued >= this.limits.maxQueued) {
        ws.close(CLOSE_POLICY, 'too many messages');
        return;
      }
      if (verdict === 'drop' || isBinary) return;
      const buf = toBuffer(data);
      if (buf.length > MAX_TEXT_BYTES) return;
      queued++;
      chain = chain
        .then(() => this.onViewerMessage(r, sink, buf))
        .catch((err: unknown) => logger.warn({ err }, 'remote desktop viewer message failed'))
        .finally(() => {
          queued--;
        });
    });
    const gone = () => {
      if (!r.viewers.delete(sink)) return;
      if (sink.rtc) {
        // The viewer left: the agent closes that peer connection.
        sink.rtc = null;
        this.toAgent(r, { t: 'rtc_close', req: `${sink.id}.rtc` });
        void this.auditViewer(r, sink.user!, 'fleet.session_transport', { event: 'stopped', mode: 'webrtc', reason: 'viewer_left' }).catch(() => undefined);
      }
      this.sendViewerCount(r);
      this.syncAudio(r);
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
    const perms = sink.perms ?? r.permissions;
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
          if (r.platform) validateCommandForPlatform(r.platform, parsedEv.data, user.role, r.android);
        } catch (err) {
          this.sendJson(sink, { t: 'input_error', error: err instanceof Error ? err.message : 'Input refused' });
          return;
        }
        const { kind: _k, event_kind, ...rest } = parsedEv.data;
        if (!perms.control) {
          this.sendJson(sink, { t: 'input_error', code: 'profile_forbids_control', error: PROFILE_REFUSAL_MESSAGES.profile_forbids_control });
          if (event_kind !== 'mouse_move') await this.refused(r, user, 'profile_forbids_control', { kind: event_kind });
          return;
        }
        const out = { ...rest, kind: event_kind };
        if (!this.toAgent(r, { t: 'input', ev: out })) {
          this.sendJson(sink, { t: 'input_error', error: r.active ? 'The endpoint is not connected to the live stream' : 'The user has not accepted the session yet' });
          return;
        }
        // Input timing (never keys or text) goes into the recording.
        r.recorder?.input(out as { kind: string; display_index?: number; x?: number; y?: number });
        // Every action except pointer movement is in the audit trail (keys and text redacted).
        if (event_kind !== 'mouse_move') await this.auditViewer(r, user, 'endpoint.rd_input', { via: 'live_stream', ...payloadForAudit('rd_input', out) });
        return;
      }
      case 'clipboard_get':
        if (m.format === 'image' || m.format === 'files') {
          await this.richClipboard(r, sink, perms, m.req, m.format, 'from_remote', null);
          return;
        }
        if (!perms.clipboard_out) {
          this.sendJson(sink, { t: 'clipboard_error', req: m.req, code: 'profile_forbids_clipboard_out', error: PROFILE_REFUSAL_MESSAGES.profile_forbids_clipboard_out });
          await this.refused(r, user, 'profile_forbids_clipboard_out', { direction: 'from_remote' });
          return;
        }
        if (!this.toAgent(r, { t: 'clipboard_get', req: `${sink.id}.${m.req}` })) this.sendJson(sink, { t: 'clipboard_error', req: m.req, error: 'The endpoint is not connected to the live stream' });
        return;
      case 'clipboard_set': {
        if (m.format === 'image' || m.format === 'files') {
          await this.richClipboard(r, sink, perms, m.req, m.format, 'to_remote', m);
          return;
        }
        const text = m.text ?? '';
        if (!perms.clipboard_in) {
          this.sendJson(sink, { t: 'clipboard_error', req: m.req, code: 'profile_forbids_clipboard_in', error: PROFILE_REFUSAL_MESSAGES.profile_forbids_clipboard_in });
          await this.refused(r, user, 'profile_forbids_clipboard_in', { direction: 'to_remote', chars: text.length });
          return;
        }
        if (!this.toAgent(r, { t: 'clipboard_set', req: `${sink.id}.${m.req}`, text })) {
          this.sendJson(sink, { t: 'clipboard_error', req: m.req, error: 'The endpoint is not connected to the live stream' });
          return;
        }
        await this.recordClipboard(r, sink, 'to_remote', text.length);
        return;
      }
      case 'privacy':
      case 'block_input': {
        const flag = m.t === 'privacy' ? 'privacy_screen' : 'block_input';
        if (!perms[flag]) {
          const code = m.t === 'privacy' ? 'profile_forbids_privacy_screen' : 'profile_forbids_block_input';
          this.sendJson(sink, { t: 'tool_error', tool: m.t, code, error: PROFILE_REFUSAL_MESSAGES[code] });
          await this.refused(r, user, code, { on: m.on });
          return;
        }
        if (!this.toAgent(r, { t: m.t, on: m.on })) return this.notConnected(r, sink, m.t);
        r.recorder?.event({ e: m.t, on: m.on, by: user.email });
        await this.auditViewer(r, user, m.t === 'privacy' ? 'fleet.session_privacy_screen' : 'fleet.session_block_input', { on: m.on });
        return;
      }
      case 'sas':
        if (!perms.control) {
          this.sendJson(sink, { t: 'tool_error', tool: 'sas', code: 'profile_forbids_control', error: PROFILE_REFUSAL_MESSAGES.profile_forbids_control });
          await this.refused(r, user, 'profile_forbids_control', { tool: 'sas' });
          return;
        }
        if (!this.toAgent(r, { t: 'sas' })) return this.notConnected(r, sink, 'sas');
        r.recorder?.event({ e: 'sas', by: user.email });
        await this.auditViewer(r, user, 'fleet.session_sas', {});
        return;
      case 'chat': {
        // Every operator in the session sees the message; the audit keeps its length only.
        const out = { t: 'chat', id: m.id, from: user.email, text: m.text };
        if (!this.toAgent(r, out)) return this.notConnected(r, sink, 'chat');
        for (const v of r.viewers) if (v !== sink) this.sendJson(v, out);
        r.recorder?.event({ e: 'chat', from: user.email, chars: m.text.length });
        await withTenant(user.orgId, async (db) => {
          await db.query(`UPDATE fleet_sessions SET chat_messages = chat_messages + 1 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId]);
          await this.auditIn(db, r, user, 'fleet.session_chat', { chars: m.text.length });
        });
        return;
      }
      case 'ask':
        if (!this.toAgent(r, { t: 'ask', id: m.id, text: m.text, kind: m.kind, timeout_s: m.timeout_s, from: user.email })) return this.notConnected(r, sink, 'ask');
        r.recorder?.event({ e: 'ask', id: m.id, kind: m.kind, by: user.email });
        await this.auditViewer(r, user, 'fleet.session_question', { question_id: m.id, kind: m.kind, chars: m.text.length });
        return;
      case 'annotate':
        if (!this.toAgent(r, { t: 'annotate', op: m.op })) return this.notConnected(r, sink, 'annotate');
        // Strokes and clearing are in the audit; the moving laser pointer is not (it is continuous).
        if (m.op.op === 'stroke' || m.op.op === 'clear') {
          r.recorder?.event({ e: 'annotate', op: m.op.op, by: user.email });
          await this.auditViewer(r, user, 'fleet.session_annotation', { op: m.op.op, points: m.op.op === 'stroke' ? m.op.points.length : 0 });
        }
        return;
      case 'audio':
        if (m.on && !perms.audio) {
          this.sendJson(sink, { t: 'tool_error', tool: 'audio', code: 'profile_forbids_audio', error: PROFILE_REFUSAL_MESSAGES.profile_forbids_audio });
          await this.refused(r, user, 'profile_forbids_audio', {});
          return;
        }
        sink.audio = m.on;
        this.syncAudio(r, m.mono === true);
        await this.auditViewer(r, user, 'fleet.session_audio', { on: m.on });
        return;
      case 'rtc_offer': {
        const refusal = this.rtcRefusal(r, perms);
        const control = perms.control && r.permissions.control;
        if (refusal || !this.toAgent(r, { t: 'rtc_offer', req: `${sink.id}.rtc`, sdp: m.sdp, control, ice_servers: env.RD_WEBRTC_STUN_URLS })) {
          const code: RtcRefusal = refusal ?? 'webrtc_agent_not_connected';
          this.sendJson(sink, { t: 'rtc_refused', code, error: RTC_REFUSAL_MESSAGES[code] });
          await this.auditViewer(r, user, 'fleet.session_transport', { event: 'refused', mode: 'webrtc', code });
          return;
        }
        sink.rtc = 'offered';
        return;
      }
      case 'rtc_ice':
        if (sink.rtc) this.toAgent(r, { t: 'rtc_ice', req: `${sink.id}.rtc`, candidate: m.candidate });
        return;
      case 'rtc_active': {
        if (sink.rtc !== 'offered') return;
        sink.rtc = 'active';
        sink.rtcLast = null;
        this.sendViewerCount(r);
        const encoder = m.encoder ?? null;
        await this.inAuditOrder(r, user.orgId, async (db) => {
          await db.query(
            `UPDATE fleet_sessions SET transport = 'webrtc', rtc_encoder = coalesce($3, rtc_encoder), rtc_started_at = coalesce(rtc_started_at, now())
              WHERE endpoint_id = $1 AND public_id = $2`,
            [r.endpointId, r.sessionId, encoder],
          );
          await this.auditIn(db, r, user, 'fleet.session_transport', { event: 'started', mode: 'webrtc', encoder });
        });
        return;
      }
      case 'rtc_fallback':
        await this.endRtc(r, sink, m.reason, 'fallback');
        return;
      case 'rtc_close':
        if (sink.rtc) await this.endRtc(r, sink, 'closed_by_viewer', 'stopped');
        return;
      case 'rtc_perms':
        // Only the hub decides what a viewer may do.
        return;
    }
  }

  /** Why an offer cannot be relayed now (null: it can). Checked again on the instance holding the agent. */
  private rtcRefusal(r: Room, perms: FleetPermissions | null): RtcRefusal | null {
    if (env.RD_WEBRTC === 'off') return 'webrtc_disabled';
    if (!r.active) return 'webrtc_session_not_active';
    if (perms && !perms.view) return 'profile_forbids_view';
    if (r.recordingOn || r.recorder) return 'webrtc_recording_active';
    if (!r.rtcSupported) return 'webrtc_unsupported';
    return null;
  }

  /**
   * A viewer goes back to JPEG (fallback) or stops WebRTC: the agent drops the peer, the viewer
   * counts as a JPEG viewer again and gets a full frame first. Audited with the reason.
   */
  private async endRtc(r: Room, sink: Sink, reason: string, event: 'fallback' | 'stopped'): Promise<void> {
    const had = sink.rtc ?? null;
    sink.rtc = null;
    if (had) {
      this.toAgent(r, { t: 'rtc_close', req: `${sink.id}.rtc` });
      sink.stale = true;
      sink.fullAsked = true;
      this.sendViewerCount(r);
      this.toAgent(r, { t: 'full' });
    }
    if (event === 'fallback' && sink.rtcLast === reason) return;
    sink.rtcLast = reason;
    const user = sink.user;
    if (!user) return;
    await this.inAuditOrder(r, user.orgId, async (db) => {
      if (event === 'fallback') await db.query(`UPDATE fleet_sessions SET rtc_fallback_reason = $3 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId, reason]);
      await this.auditIn(db, r, user, 'fleet.session_transport', { event, mode: event === 'fallback' ? 'jpeg' : 'webrtc', reason, had_webrtc: had !== null });
    });
  }

  /** Input the agent applied (or refused) from a viewer's data channel: audited like the socket path. */
  private async auditRtcInput(r: Room, sink: Sink, m: Record<string, unknown>): Promise<void> {
    const user = sink.user;
    const kind = typeof m.kind === 'string' ? m.kind : '';
    if (!user || !sink.rtc || !RTC_INPUT_KINDS.has(kind)) return;
    if (typeof m.refused === 'string') {
      const code: ProfileRefusalCode = 'profile_forbids_control';
      await this.auditViewer(r, user, 'fleet.session_refused_action', { kind, code, needs: refusalFlag(code), via: 'webrtc' });
      return;
    }
    const out: Record<string, unknown> = { kind };
    if (m.button === 'left' || m.button === 'right' || m.button === 'middle') out.button = m.button;
    if (typeof m.display_index === 'number' && Number.isInteger(m.display_index) && m.display_index >= 0 && m.display_index <= 16) out.display_index = m.display_index;
    if (m.double === true) out.double = true;
    await this.auditViewer(r, user, 'endpoint.rd_input', { via: 'webrtc', ...payloadForAudit('rd_input', out) });
  }

  private setHello(r: Room, text: string, m: { webrtc?: unknown }): void {
    r.hello = text;
    const w = m.webrtc as { supported?: unknown } | undefined;
    r.rtcSupported = w?.supported === true;
  }

  private notConnected(r: Room, sink: Sink, tool: string): void {
    this.sendJson(sink, { t: 'tool_error', tool, error: r.active ? 'The endpoint is not connected to the live stream' : 'The user has not accepted the session yet' });
  }

  /** The agent captures sound while at least one operator listens. */
  private syncAudio(r: Room, mono = false): void {
    const want = [...r.viewers].some((v) => v.audio && v.perms?.audio);
    if (want === r.audioOn) return;
    if (this.toAgent(r, { t: 'audio', on: want, mono })) r.audioOn = want;
    else if (!want) r.audioOn = false;
  }

  /** Pictures and file lists on the clipboard (both directions, per the operator's permissions). */
  private async richClipboard(
    r: Room,
    sink: Sink,
    perms: FleetPermissions,
    req: string,
    format: 'image' | 'files',
    direction: 'to_remote' | 'from_remote',
    m: { data?: string; paths?: string[] } | null,
  ): Promise<void> {
    const user = sink.user!;
    const code: ProfileRefusalCode | null =
      direction === 'to_remote' && !perms.clipboard_in
        ? 'profile_forbids_clipboard_in'
        : direction === 'from_remote' && !perms.clipboard_out
          ? 'profile_forbids_clipboard_out'
          : format === 'files' && !perms.files
            ? 'profile_forbids_files'
            : null;
    if (code) {
      this.sendJson(sink, { t: 'clipboard_error', req, format, code, error: PROFILE_REFUSAL_MESSAGES[code] });
      await this.refused(r, user, code, { direction, format });
      return;
    }
    const payload: Record<string, unknown> = { t: direction === 'to_remote' ? 'clipboard_set' : 'clipboard_get', req: `${sink.id}.${req}`, format };
    if (direction === 'to_remote') {
      if (format === 'image' && !m?.data) return this.sendJson(sink, { t: 'clipboard_error', req, format, error: 'No picture' });
      if (format === 'files' && !m?.paths?.length) return this.sendJson(sink, { t: 'clipboard_error', req, format, error: 'No files' });
      payload.data = m?.data;
      payload.paths = m?.paths;
    }
    if (!this.toAgent(r, payload)) {
      this.sendJson(sink, { t: 'clipboard_error', req, format, error: 'The endpoint is not connected to the live stream' });
      return;
    }
    if (direction === 'to_remote') {
      const detail = format === 'image' ? { bytes: Math.floor(((m?.data?.length ?? 0) * 3) / 4) } : { files: m?.paths?.length ?? 0 };
      await withTenant(user.orgId, async (db) => {
        await db.query(`UPDATE fleet_sessions SET clipboard_to_remote = clipboard_to_remote + 1 WHERE endpoint_id = $1 AND public_id = $2`, [r.endpointId, r.sessionId]);
        await this.auditIn(db, r, user, 'fleet.session_clipboard', { direction, format, ...detail });
      });
    }
  }

  /** An operator message the session's profile refused (audited; the text of a clipboard never). */
  private async refused(r: Room, user: ViewerUser, code: ProfileRefusalCode, metadata: Record<string, unknown>): Promise<void> {
    await this.auditViewer(r, user, 'fleet.session_refused_action', { ...metadata, code, needs: refusalFlag(code), via: 'live_stream' });
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
    await this.inAuditOrder(r, user.orgId, (db) => this.auditIn(db, r, user, action, metadata));
  }

  /**
   * Runs a transaction that writes an operator's audit row after the room's earlier ones.
   * Messages are handled concurrently, so each insert in its own transaction could commit (and
   * take its created_at) in any order: two key presses, or a fallback and the refusal after it,
   * could read back swapped. Chained per room, the rows follow the order of the events. A failed
   * transaction does not hold up the next one; its caller still sees the error.
   */
  private inAuditOrder(r: Room, orgId: string, fn: (db: Db) => Promise<unknown>): Promise<void> {
    const run = r.auditChain.then(async () => {
      await withTenant(orgId, fn);
    });
    r.auditChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
      if (buf.length > MAX_TEXT_BYTES) return;
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
      if (parsed.data.t === 'audio') sink.audio = parsed.data.on;
      if (parsed.data.t === 'input') r.recorder?.input(parsed.data.ev as { kind: string });
      if (parsed.data.t.startsWith('rtc_') && !('req' in parsed.data && parsed.data.req)) return;
      if (parsed.data.t === 'rtc_offer') {
        // Checked again here (this instance knows the recording and the agent's hello first-hand).
        const refusal = this.rtcRefusal(r, null);
        if (refusal) {
          this.sendJson(sink, { t: 'rtc_state', req: parsed.data.req, state: 'failed', code: refusal, reason: RTC_REFUSAL_MESSAGES[refusal] });
          return;
        }
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
        if (isAudioPacket(buf)) {
          this.fanOutAudio(r, buf, false);
          return;
        }
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
      if (m.t === 'hello') this.setHello(r, text, m as { webrtc?: unknown });
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
      case 'end': {
        // "end|E|S": only session S ends. Notifications arrive asynchronously, so an end for an
        // earlier session can land after a newer session of this endpoint already has its room.
        // An empty S (an older instance's payload) still means "whatever is open".
        const sessionId = parts[2] || null;
        clearStream(endpointId, sessionId);
        if (r && (sessionId === null || r.sessionId === sessionId)) this.closeRoom(r, CLOSE_SESSION_ENDED, 'session ended', true);
        return;
      }
      case 'state': {
        const state = parts[2];
        const sessionId = parts[3] || null;
        if (!r || (sessionId !== null && r.sessionId !== sessionId)) return;
        if (state !== 'active' && state !== 'waiting_consent' && state !== 'waiting_approval') return;
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
      case 'rec': {
        // Recording switched on or off (session-tools.ts): the instance holding the agent writes it;
        // every viewer is told so the recording mark shows in the console too.
        if (!r) return;
        const id = parts[2] && UUID.test(parts[2]) ? parts[2] : null;
        r.recordingOn = id !== null;
        if (id) {
          // Recording needs the picture on the server path: every WebRTC viewer here goes back to JPEG.
          for (const v of r.viewers) {
            if (!v.rtc) continue;
            this.sendJson(v, { t: 'rtc_closed', reason: 'recording' });
            void this.endRtc(r, v, 'recording', 'fallback').catch((err: unknown) => logger.warn({ err }, 'webrtc fallback audit failed'));
          }
        }
        this.broadcastText(r, { t: 'recording', on: id !== null }, false);
        void this.syncRecording(r, id);
        void this.refreshOperators(r);
        return;
      }
      case 'part': {
        // An operator left or was removed: their sockets close.
        const userId = parts[2];
        if (!r || !userId) return;
        for (const v of [...r.viewers]) if (v.user?.userId === userId) v.ws.close(CLOSE_PARTICIPANT_REMOVED, 'removed from the session');
        return;
      }
    }
  }

  /** After a join, a hand-over or a removal: every viewer gets the new list and their own permissions. */
  private async refreshOperators(r: Room): Promise<void> {
    const cur = await this.currentSession(r.orgId, r.endpointId).catch(() => null);
    const s = cur?.session;
    if (!s || s.id !== r.sessionId) return;
    r.permissions = sessionPermissions(s);
    for (const v of r.viewers) {
      if (!v.user) continue;
      const perms = await withTenant(r.orgId, (db) => participantAccess(db, s as never, v.user!.userId)).catch(() => null);
      if (!perms) {
        v.ws.close(CLOSE_PARTICIPANT_REMOVED, 'removed from the session');
        continue;
      }
      v.perms = perms;
      if (v.rtc) {
        if (!perms.view) {
          this.sendJson(v, { t: 'rtc_closed', reason: 'profile_forbids_view' });
          await this.endRtc(r, v, 'profile_forbids_view', 'stopped').catch(() => undefined);
        } else {
          // A hand-over or a narrower invitation: the agent applies it to that viewer's data channel.
          this.toAgent(r, { t: 'rtc_perms', req: `${v.id}.rtc`, control: perms.control && r.permissions.control });
        }
      }
      this.sendJson(v, {
        t: 'operators',
        operators: s.operators ?? [s.operator_email],
        permissions: perms,
        holder: (s as { operator_user_id?: string }).operator_user_id === v.user.userId,
        recording: Boolean(s.recording_id),
      });
    }
    this.syncAudio(r);
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
    const rec = r.recorder;
    r.recorder = null;
    r.recordingId = null;
    if (rec) void rec.close();
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
    if (r.recorder) await r.recorder.flush();
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
