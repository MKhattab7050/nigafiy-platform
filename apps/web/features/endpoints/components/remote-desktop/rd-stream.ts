import type { RemoteDesktopDisplay } from '@nigafiy/shared-types';

// The live stream's wire format (agent: internal/remotedesktop/stream.go; relayed unchanged by the
// API's stream hub): 'N', 1, uint32 big-endian header length, the JSON header, then the JPEG bytes
// of each tile in header order. The viewer draws each tile at (x, y) of a w × h canvas.

export interface StreamTile {
  x: number;
  y: number;
  w: number;
  h: number;
  n: number;
}

export interface StreamFrameHeader {
  t: 'frame';
  seq: number;
  full: boolean;
  display: number;
  displays?: RemoteDesktopDisplay[];
  w: number;
  h: number;
  sw: number;
  sh: number;
  q: number;
  s: number;
  fmt: string;
  tiles: StreamTile[];
  cap_ms: number;
  enc_ms: number;
  changed_pct: number;
  mode: string;
}

export interface StreamStats {
  fps: number;
  kbps: number;
  rtt_ms: number;
  throughput_kbps: number;
  quality: number;
  scale: number;
  display: number;
  adaptive: boolean;
  changed_pct: number;
  cap_ms: number;
  enc_ms: number;
  viewers: number;
  width: number;
  height: number;
  /** A phone: 'h264' (hardware video) or 'jpeg', and the video's current bitrate. */
  encoder?: string;
  bitrate_kbps?: number;
}

export interface StreamHello {
  session_id: string;
  displays: RemoteDesktopDisplay[] | null;
  desktop?: { mode?: string; backend?: string; input_supported?: boolean; permissions?: Record<string, string> | null };
  encoder: string;
  control?: boolean;
  /** WebRTC video (H.264 from Media Foundation on Windows); `reason` when not available. */
  webrtc?: { supported: boolean; encoder?: string; reason?: string };
  /** Video the agent can send on this stream when the viewer asks (a phone: ['h264']). */
  video?: string[];
}

/** The header of a packet and where its payload starts (video frames are not split into tiles). */
export function packetHeader(buf: ArrayBuffer): { header: StreamFrameHeader; offset: number } | null {
  const v = new DataView(buf);
  if (buf.byteLength < 6 || v.getUint8(0) !== 0x4e || v.getUint8(1) !== 1) return null;
  const n = v.getUint32(2);
  if (n === 0 || 6 + n > buf.byteLength) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 6, n))) as StreamFrameHeader;
    return header.t === 'frame' ? { header, offset: 6 + n } : null;
  } catch {
    return null;
  }
}

/** Splits a packet; null when it is not one (wrong magic, lengths that do not add up). */
export function parsePacket(buf: ArrayBuffer): { header: StreamFrameHeader; tiles: Blob[] } | null {
  const v = new DataView(buf);
  if (buf.byteLength < 6 || v.getUint8(0) !== 0x4e || v.getUint8(1) !== 1) return null;
  const n = v.getUint32(2);
  if (n === 0 || 6 + n > buf.byteLength) return null;
  let header: StreamFrameHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 6, n)));
  } catch {
    return null;
  }
  if (header.t !== 'frame' || !Array.isArray(header.tiles)) return null;
  const tiles: Blob[] = [];
  let off = 6 + n;
  for (const t of header.tiles) {
    if (off + t.n > buf.byteLength) return null;
    tiles.push(new Blob([new Uint8Array(buf, off, t.n)], { type: 'image/jpeg' }));
    off += t.n;
  }
  return off === buf.byteLength ? { header, tiles } : null;
}

/** Draws a frame onto the canvas (resized, and so cleared, when the frame size changes). */
export async function drawFrame(canvas: HTMLCanvasElement, header: StreamFrameHeader, tiles: Blob[]): Promise<void> {
  if (canvas.width !== header.w || canvas.height !== header.h) {
    canvas.width = header.w;
    canvas.height = header.h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bitmaps = await Promise.all(tiles.map((b) => createImageBitmap(b)));
  header.tiles.forEach((t, i) => {
    const bmp = bitmaps[i]!;
    ctx.drawImage(bmp, t.x, t.y, t.w, t.h);
    bmp.close();
  });
}

/** Draws one whole JPEG (the HTTP fallback's frame). */
export async function drawJpegBase64(canvas: HTMLCanvasElement, b64: string, width: number, height: number): Promise<void> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const w = width || bmp.width;
  const h = height || bmp.height;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, w, h);
  bmp.close();
}

/** The socket address of a session's live stream, on this page's origin (proxied to the API). */
export function streamUrl(endpointId: string, sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/endpoints/${encodeURIComponent(endpointId)}/remote-desktop/stream?session=${encodeURIComponent(sessionId)}`;
}
