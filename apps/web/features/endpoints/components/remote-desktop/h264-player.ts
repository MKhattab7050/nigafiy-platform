/**
 * Plays a phone's hardware H.264 (agents/android-agent VideoEncoder.kt) on the console's canvas
 * with WebCodecs. Before this every picture from a phone was a whole JPEG, slow to make and heavy
 * to send (owner, 2026-11-27). Frames arrive Annex B; key frames carry SPS/PPS, so decoding can
 * (re)start at any key frame. Browsers without WebCodecs keep the JPEG pictures.
 */

/** The `avc1.PPCCLL` codec string from the stream's SPS, or null when there is none. */
export function avcCodec(data: Uint8Array): string | null {
  for (let i = 0; i + 4 < data.length; i++) {
    const three = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (!three) continue;
    const nal = data[i + 3]!;
    if ((nal & 0x1f) === 7 && i + 6 < data.length) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4]!)}${hex(data[i + 5]!)}${hex(data[i + 6]!)}`;
    }
  }
  return null;
}

/** Whether this browser can decode the phone's video (checked once). */
let support: Promise<boolean> | null = null;
export function h264Supported(): Promise<boolean> {
  if (support) return support;
  support = (async () => {
    if (typeof window === 'undefined' || !('VideoDecoder' in window)) return false;
    try {
      for (const codec of ['avc1.42E01F', 'avc1.640028']) {
        const r = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
        if (r.supported) return true;
      }
    } catch {
      // Not supported here.
    }
    return false;
  })();
  return support;
}

/** Decoded pictures waiting this long means this screen is behind: skip to the next key frame. */
const MAX_QUEUE = 8;

export class H264Player {
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private waitingKey = true;
  private closed = false;

  constructor(
    private readonly canvas: () => HTMLCanvasElement | null,
    /** A picture is on the canvas (the agent measures its round trip on the ack). */
    private readonly onDrawn: (seq: number) => void,
    /** The decoder failed: the console asks for JPEG pictures again. */
    private readonly onError: (reason: string) => void,
  ) {}

  /** Feeds one frame; false when a key frame is needed first (ask the agent for one). */
  push(seq: number, key: boolean, data: Uint8Array): boolean {
    if (this.closed) return true;
    if (key) {
      const codec = avcCodec(data);
      if (codec && (codec !== this.codec || !this.decoder || this.decoder.state === 'closed')) {
        if (!this.open(codec)) return true;
      }
      this.waitingKey = false;
    }
    const d = this.decoder;
    if (!d || d.state !== 'configured' || this.waitingKey) return false;
    if (!key && d.decodeQueueSize > MAX_QUEUE) {
      this.waitingKey = true;
      return false;
    }
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data }));
    } catch (err) {
      this.fail(err);
    }
    return true;
  }

  private open(codec: string): boolean {
    try {
      this.decoder?.close();
    } catch {
      // Already closed.
    }
    try {
      const d = new VideoDecoder({
        output: (frame) => {
          const c = this.canvas();
          if (c && !this.closed) {
            if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
              c.width = frame.displayWidth;
              c.height = frame.displayHeight;
            }
            c.getContext('2d')?.drawImage(frame, 0, 0);
            this.onDrawn(frame.timestamp);
          }
          frame.close();
        },
        error: (e) => this.fail(e),
      });
      d.configure({ codec, optimizeForLatency: true });
      this.decoder = d;
      this.codec = codec;
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private fail(err: unknown) {
    if (this.closed) return;
    this.close();
    this.onError(err instanceof Error ? err.message : String(err));
  }

  close() {
    this.closed = true;
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // Already closed.
    }
    this.decoder = null;
  }
}
